import * as THREE from 'three';
import type { Pt } from '@sigilfall/recognizer';
import type { ParticleVfx } from './vfx';
import { settings } from './settings';

export const PLANE_DIST = 2.2;

const RV = /* glsl */ `
attribute float aU; attribute float aV; attribute float aAge;
varying float vU; varying float vV; varying float vAge;
void main(){ vU = aU; vV = aV; vAge = aAge; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const RF = /* glsl */ `
varying float vU; varying float vV; varying float vAge;
uniform vec3 uColor; uniform float uFade; uniform float uFlash; uniform float uTime; uniform float uDissolve;
float h(vec2 p){ return fract(sin(dot(p, vec2(41.3,289.1))) * 43758.5453); }
void main(){
  float edge = 1.0 - abs(vV);
  float core = pow(max(edge, 0.0), 2.2);
  float glow = pow(max(edge, 0.0), 0.7) * 0.55;
  float flow = 0.82 + 0.18 * sin(vU * 60.0 - uTime * 9.0);
  float head = smoothstep(0.0, 0.25, vU) * 0.65 + 0.35;
  float a = (core + glow) * flow * head * uFade;
  if (uDissolve > 0.0) {
    float n = h(floor(vec2(vU * 90.0, vV * 5.0 + uTime * 3.0)));
    if (n < uDissolve) discard;
  }
  vec3 c = uColor * (0.8 + core * 1.2) + vec3(1.0) * core * (0.35 + uFlash);
  gl_FragColor = vec4(c * a, a);
}`;

class Ribbon {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private u: Float32Array;
  private v: Float32Array;
  private age: Float32Array;
  readonly mat: THREE.ShaderMaterial;

  constructor(private max: number, color: number) {
    this.pos = new Float32Array(max * 2 * 3);
    this.u = new Float32Array(max * 2);
    this.v = new Float32Array(max * 2);
    this.age = new Float32Array(max * 2);
    const idx: number[] = [];
    for (let i = 0; i < max - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aU', new THREE.BufferAttribute(this.u, 1));
    this.geo.setAttribute('aV', new THREE.BufferAttribute(this.v, 1));
    this.geo.setAttribute('aAge', new THREE.BufferAttribute(this.age, 1));
    this.geo.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: RV, fragmentShader: RF, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color(color) }, uFade: { value: 1 }, uFlash: { value: 0 }, uTime: { value: 0 }, uDissolve: { value: 0 } },
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 50;
  }

  /** pts are in plane-local world units; widths per point */
  set(pts: { x: number; y: number; w: number }[]): void {
    const n = Math.min(pts.length, this.max);
    for (let i = 0; i < n; i++) {
      const p = pts[i]!;
      const a = pts[Math.max(0, i - 1)]!;
      const b = pts[Math.min(n - 1, i + 1)]!;
      let tx = b.x - a.x;
      let ty = b.y - a.y;
      const l = Math.hypot(tx, ty) || 1;
      tx /= l; ty /= l;
      const nx = -ty * p.w;
      const ny = tx * p.w;
      const k = i * 2;
      this.pos.set([p.x + nx, p.y + ny, 0, p.x - nx, p.y - ny, 0], k * 3);
      this.u[k] = this.u[k + 1] = n > 1 ? 1 - i / (n - 1) : 1;
      this.v[k] = 1; this.v[k + 1] = -1;
    }
    this.geo.setDrawRange(0, Math.max(0, (n - 1) * 6));
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aU as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aV as THREE.BufferAttribute).needsUpdate = true;
  }
}

export type Phase = 'idle' | 'drawing' | 'snap' | 'fizzle' | 'unravel';

/** The glass sigil plane parented to the camera, with the live ribbon, ghost tutor ribbon and draw-timer ring. */
export class SigilPlane {
  readonly group = new THREE.Group();
  private live = new Ribbon(360, 0x9fd0ff);
  private ghost = new Ribbon(200, 0xffffff);
  private disc: THREE.Mesh;
  private rim: THREE.Mesh;
  private timer: THREE.Mesh;
  private timerMat: THREE.ShaderMaterial;
  private discMat: THREE.MeshBasicMaterial;
  private pts: { x: number; y: number; t: number; w: number }[] = [];
  phase: Phase = 'idle';
  /** wand is recovering after a cast: the plane dims until you may draw again */
  busy = false;
  private phaseT = 0;
  private holdFor = 0;
  private time = 0;
  private glow = 0.35;
  private ghostPts: Pt[] = [];
  private ghostProgress = 0;
  private ghostActive = false;
  private canonPts: { x: number; y: number; w: number }[] = [];
  private canonT = 0;
  // metrics (screen px)
  cx = 0;
  cy = 0;
  rPx = 200;
  private rWorld = 0.7;
  private offX = 0;
  private offY = 0;
  private color = new THREE.Color(0x9fd0ff);
  private lastHead = new THREE.Vector3();

  constructor(private camera: THREE.PerspectiveCamera, private vfx: ParticleVfx) {
    this.discMat = new THREE.MeshBasicMaterial({ color: 0x7aa4ff, transparent: true, opacity: 0.06, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
    this.disc = new THREE.Mesh(new THREE.CircleGeometry(1, 64), this.discMat);
    this.disc.renderOrder = 40;
    this.rim = new THREE.Mesh(
      new THREE.RingGeometry(0.985, 1, 96),
      new THREE.MeshBasicMaterial({ color: 0x9fc0ff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }),
    );
    this.rim.renderOrder = 41;
    this.timerMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uP: { value: 0 }, uColor: { value: new THREE.Color(0xffd27a) } },
      vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);} ',
      fragmentShader: 'varying vec2 vP; uniform float uP; uniform vec3 uColor; void main(){ float a = atan(vP.x, vP.y); a = a<0.0? a+6.2831853 : a; float f = a/6.2831853; if (f > uP) discard; gl_FragColor = vec4(uColor, 0.85); }',
    });
    this.timer = new THREE.Mesh(new THREE.RingGeometry(1.04, 1.07, 96), this.timerMat);
    this.timer.renderOrder = 42;
    this.timer.visible = false;
    this.group.add(this.disc, this.rim, this.timer, this.ghost.mesh, this.live.mesh);
    this.group.position.z = -PLANE_DIST;
    camera.add(this.group);
    this.layout();
  }

  /** recompute plane metrics from window size and fov */
  layout(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const small = Math.min(w, h) < 520;
    this.rPx = Math.min(w, h) * (small ? 0.34 : 0.24) * settings.planeScale;
    this.cx = w / 2;
    this.cy = h * (small ? 0.44 : 0.46);
    const halfH = Math.tan((this.camera.fov * Math.PI) / 360) * PLANE_DIST;
    const wpp = (halfH * 2) / h;
    this.rWorld = this.rPx * wpp;
    this.offX = (this.cx - w / 2) * wpp;
    this.offY = -(this.cy - h / 2) * wpp;
    this.group.position.set(this.offX, this.offY, -PLANE_DIST);
    for (const m of [this.disc, this.rim, this.timer]) m.scale.setScalar(this.rWorld);
  }

  /** screen px -> recognizer plane coordinates (0..1000, y down) */
  toPlane(px: number, py: number): Pt {
    return { x: 500 + ((px - this.cx) / this.rPx) * 500, y: 500 + ((py - this.cy) / this.rPx) * 500 };
  }

  inside(px: number, py: number, slack = 1): boolean {
    return Math.hypot(px - this.cx, py - this.cy) <= this.rPx * slack;
  }

  /** plane coords -> group-local world coords */
  private local(p: Pt): { x: number; y: number } {
    return { x: ((p.x - 500) / 500) * this.rWorld, y: (-(p.y - 500) / 500) * this.rWorld };
  }

  headWorld(out = new THREE.Vector3()): THREE.Vector3 {
    const p = this.pts[this.pts.length - 1];
    if (!p) return out.set(0, 0, -PLANE_DIST);
    return this.group.localToWorld(out.set(p.x, p.y, 0));
  }

  localToWorld(p: Pt, out = new THREE.Vector3()): THREE.Vector3 {
    const l = this.local(p);
    return this.group.localToWorld(out.set(l.x, l.y, 0));
  }

  setColor(c: number): void {
    this.color.setHex(c);
    this.live.mat.uniforms.uColor!.value.copy(this.color);
    (this.rim.material as THREE.MeshBasicMaterial).color.copy(this.color);
    this.discMat.color.copy(this.color);
  }

  begin(): void {
    this.phase = 'drawing';
    this.pts = [];
    this.live.mat.uniforms.uFade!.value = 1;
    this.live.mat.uniforms.uDissolve!.value = 0;
    this.live.mat.uniforms.uFlash!.value = 0;
    this.glow = 0.9;
    this.timer.visible = true;
    this.timerMat.uniforms.uP!.value = 1;
  }

  addPoint(p: Pt, t: number): void {
    const l = this.local(p);
    const last = this.pts[this.pts.length - 1];
    if (last && Math.hypot(last.x - l.x, last.y - l.y) < this.rWorld * 0.008) return;
    let w = 0.03;
    if (last) {
      const dt = Math.max(1, t - last.t);
      const speed = Math.hypot(last.x - l.x, last.y - l.y) / dt; // world units per ms
      w = THREE.MathUtils.clamp(0.052 - speed * 5.5, 0.016, 0.052);
      w = last.w * 0.6 + w * 0.4;
    }
    this.pts.push({ x: l.x, y: l.y, t, w });
    this.lastHead = this.headWorld(this.lastHead);
    if (!settings.clarity) this.vfx.burst({ pos: this.lastHead, color: this.color.getHex(), count: 2, speed: 0.5, life: 0.5, size: 0.05, gravity: 0.6, drag: 1.5 });
  }

  /** fraction of the 2s draw window remaining (0..1) */
  setTimer(f: number): void {
    this.timerMat.uniforms.uP!.value = Math.max(0, f);
  }

  /** recognised: snap to the clean canonical symbol with a flash */
  snap(canon: Pt[], holdFor = 1.0): void {
    this.phase = 'snap';
    this.phaseT = 0;
    this.holdFor = holdFor;
    // your own stroke stays on screen; the clean symbol blooms over it on the ghost ribbon
    this.ghostActive = false;
    this.canonPts = canon.map((p) => {
      const l = this.local(p);
      return { x: l.x, y: l.y, w: 0.026 };
    });
    this.ghost.set(this.canonPts);
    this.ghost.mat.uniforms.uColor!.value.copy(this.color);
    this.canonT = 1;
    this.live.mat.uniforms.uFlash!.value = 1;
    this.timer.visible = false;
    this.glow = 1.4;
    if (!settings.clarity) {
      const c = this.pts.length;
      for (let i = 0; i < c; i += 3) {
        const p = this.pts[i]!;
        this.vfx.burst({ pos: this.group.localToWorld(new THREE.Vector3(p.x, p.y, 0)), color: this.color.getHex(), count: 2, speed: 0.9, life: 0.6, size: 0.06, drag: 2 });
      }
    }
  }

  fizzle(): void {
    this.phase = 'fizzle';
    this.phaseT = 0;
    this.holdFor = 0.5;
    this.timer.visible = false;
    this.live.mat.uniforms.uColor!.value.set(0x887788);
  }

  unravel(): void {
    this.phase = 'unravel';
    this.phaseT = 0;
    this.holdFor = 0.45;
    this.timer.visible = false;
  }

  cancel(): void {
    this.phase = 'idle';
    this.pts = [];
    this.timer.visible = false;
    this.live.set([]);
  }

  showGhost(canon: Pt[] | null): void {
    this.ghostActive = !!canon;
    this.ghostPts = canon ?? [];
    this.ghostProgress = 0;
    if (!canon) this.ghost.set([]);
  }

  /** current ghost head in plane coords (used for the numbered start marker) */
  ghostStart(): Pt | null {
    return this.ghostPts[0] ?? null;
  }

  pulse(v = 1): void {
    this.glow = Math.max(this.glow, v);
  }

  update(dt: number, active: boolean): void {
    this.time += dt;
    this.live.mat.uniforms.uTime!.value = this.time;
    this.ghost.mat.uniforms.uTime!.value = this.time;
    this.glow += ((active ? 0.7 : this.busy ? 0.0 : 0.28) - this.glow) * Math.min(1, dt * 4);
    this.discMat.opacity = 0.012 + this.glow * 0.06;
    (this.rim.material as THREE.MeshBasicMaterial).opacity = 0.1 + this.glow * 0.4;
    this.group.rotation.z = Math.sin(this.time * 0.4) * 0.01;

    if (this.ghostActive && this.ghostPts.length) {
      this.ghostProgress = Math.min(1.25, this.ghostProgress + dt * 0.5);
      if (this.ghostProgress >= 1.25) this.ghostProgress = 0;
      const n = Math.max(2, Math.floor(this.ghostPts.length * Math.min(1, this.ghostProgress)));
      const shown = this.ghostPts.slice(0, n).map((p) => {
        const l = this.local(p);
        return { x: l.x, y: l.y, w: 0.02 };
      });
      this.ghost.set(shown);
      this.ghost.mat.uniforms.uFade!.value = this.ghostProgress > 1 ? Math.max(0, 1 - (this.ghostProgress - 1) * 4) * 0.8 : 0.8;
      this.ghost.mat.uniforms.uColor!.value.set(0xffe6a8);
    } else if (this.canonT > 0) {
      this.canonT = Math.max(0, this.canonT - dt / 1.0);
      this.ghost.mat.uniforms.uFade!.value = Math.min(1, this.canonT * 1.6);
      if (this.canonT === 0) this.ghost.set([]);
    } else {
      this.ghost.mat.uniforms.uFade!.value = 0;
    }

    if (this.phase === 'drawing' || this.phase === 'snap' || this.phase === 'fizzle' || this.phase === 'unravel') {
      let pts = this.pts;
      if (this.phase !== 'drawing') {
        this.phaseT += dt;
        const f = this.phaseT / this.holdFor;
        const u = this.live.mat.uniforms;
        if (this.phase === 'snap') {
          u.uFlash!.value = Math.max(0, 1 - f * 2);
          u.uFade!.value = f < 0.55 ? 1 : Math.max(0, 1 - (f - 0.55) / 0.45);
        } else if (this.phase === 'fizzle') {
          u.uDissolve!.value = Math.min(0.98, f);
          u.uFade!.value = 0.7;
          pts = pts.map((p, i) => ({ ...p, x: p.x + Math.sin(this.time * 40 + i) * 0.006 * f, y: p.y - f * 0.03 * (i % 3) * 0.2 }));
        } else {
          const keep = Math.max(2, Math.floor(pts.length * (1 - f)));
          pts = pts.slice(0, keep);
          u.uFade!.value = Math.max(0, 1 - f);
        }
        if (this.phaseT >= this.holdFor) {
          this.phase = 'idle';
          this.pts = [];
          this.live.set([]);
          this.live.mat.uniforms.uColor!.value.copy(this.color);
          return;
        }
      }
      this.live.set(pts);
    }
  }

  get strokeLength(): number {
    return this.pts.length;
  }
}
