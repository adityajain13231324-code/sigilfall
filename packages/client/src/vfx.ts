import * as THREE from 'three';

export interface BurstOpts {
  pos: THREE.Vector3;
  color: number;
  count: number;
  speed: number;
  life: number;
  size: number;
  spread?: number; // 0..1 cone half-angle fraction (1 = sphere)
  dir?: THREE.Vector3;
  gravity?: number;
  drag?: number;
  inward?: boolean; // particles spawn on a shell and fly to pos
  radius?: number;
}

/** The only API the game uses for particles and rings, so three.quarks (or anything else) can replace this. */
export interface VfxManager {
  readonly group: THREE.Group;
  burst(o: BurstOpts): void;
  ring(pos: THREE.Vector3, color: number, r0: number, r1: number, life: number, axis?: 'x' | 'y' | 'z', thick?: number): void;
  update(dt: number): void;
  setScale(s: number): void;
  clear(): void;
}

const VERT = /* glsl */ `
attribute float aSize;
attribute vec4 aColor;
varying vec4 vColor;
uniform float uScale;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(aSize * uScale / max(0.1, -mv.z), 1.0, 44.0);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = /* glsl */ `
varying vec4 vColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  if (r > 1.0) discard;
  float a = pow(1.0 - r, 1.6);
  gl_FragColor = vec4(vColor.rgb * (0.6 + a), vColor.a * a);
}`;

const MAX = 3600;

export class ParticleVfx implements VfxManager {
  readonly group = new THREE.Group();
  private pos = new Float32Array(MAX * 3);
  private vel = new Float32Array(MAX * 3);
  private col = new Float32Array(MAX * 4);
  private size = new Float32Array(MAX);
  private life = new Float32Array(MAX);
  private max = new Float32Array(MAX);
  private grav = new Float32Array(MAX);
  private drag = new Float32Array(MAX);
  private base = new Float32Array(MAX);
  private tgt = new Float32Array(MAX * 3);
  private inward = new Uint8Array(MAX);
  private head = 0;
  private cap = MAX;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  private points: THREE.Points;
  private rings: { mesh: THREE.Mesh; life: number; max: number; r0: number; r1: number }[] = [];
  private ringPool: THREE.Mesh[] = [];
  private ringGeo = new THREE.RingGeometry(0.92, 1, 48);
  private tmp = new THREE.Color();

  constructor() {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: 600 } },
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    this.group.add(this.points);
  }

  setScale(s: number): void {
    this.mat.uniforms.uScale!.value = s;
  }

  setCap(n: number): void {
    this.cap = Math.max(200, Math.min(MAX, n));
  }

  burst(o: BurstOpts): void {
    this.tmp.setHex(o.color);
    const spread = o.spread ?? 1;
    for (let i = 0; i < o.count; i++) {
      const k = this.head;
      this.head = (this.head + 1) % this.cap;
      const v = k * 3;
      let dx = Math.random() * 2 - 1;
      let dy = Math.random() * 2 - 1;
      let dz = Math.random() * 2 - 1;
      const l = Math.hypot(dx, dy, dz) || 1;
      dx /= l; dy /= l; dz /= l;
      if (o.dir) {
        dx = o.dir.x + dx * spread; dy = o.dir.y + dy * spread; dz = o.dir.z + dz * spread;
        const m = Math.hypot(dx, dy, dz) || 1;
        dx /= m; dy /= m; dz /= m;
      }
      const sp = o.speed * (0.4 + Math.random() * 0.8);
      if (o.inward) {
        const r = o.radius ?? 1.4;
        this.pos[v] = o.pos.x + dx * r; this.pos[v + 1] = o.pos.y + dy * r; this.pos[v + 2] = o.pos.z + dz * r;
        this.vel[v] = -dx * sp; this.vel[v + 1] = -dy * sp; this.vel[v + 2] = -dz * sp;
      } else {
        this.pos[v] = o.pos.x; this.pos[v + 1] = o.pos.y; this.pos[v + 2] = o.pos.z;
        this.vel[v] = dx * sp; this.vel[v + 1] = dy * sp; this.vel[v + 2] = dz * sp;
      }
      const c = k * 4;
      const jitter = 0.85 + Math.random() * 0.3;
      this.col[c] = this.tmp.r * jitter; this.col[c + 1] = this.tmp.g * jitter; this.col[c + 2] = this.tmp.b * jitter; this.col[c + 3] = 1;
      this.base[k] = o.size * (0.6 + Math.random() * 0.8);
      this.size[k] = this.base[k]!;
      this.life[k] = this.max[k] = o.life * (0.6 + Math.random() * 0.6);
      this.grav[k] = o.gravity ?? 0;
      this.drag[k] = o.drag ?? 1.2;
    }
  }

  ring(pos: THREE.Vector3, color: number, r0: number, r1: number, life: number, axis: 'x' | 'y' | 'z' = 'y', thick = 1): void {
    let mesh = this.ringPool.pop();
    if (!mesh) {
      mesh = new THREE.Mesh(
        this.ringGeo,
        new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
      );
      mesh.renderOrder = 9;
    }
    (mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
    mesh.position.copy(pos);
    mesh.rotation.set(axis === 'y' ? -Math.PI / 2 : 0, axis === 'x' ? Math.PI / 2 : 0, 0);
    mesh.scale.setScalar(r0);
    mesh.userData.thick = thick;
    this.group.add(mesh);
    this.rings.push({ mesh, life, max: life, r0, r1 });
  }

  update(dt: number): void {
    const n = this.cap;
    for (let k = 0; k < n; k++) {
      let l = this.life[k]!;
      if (l <= 0) {
        this.size[k] = 0;
        continue;
      }
      l -= dt;
      this.life[k] = l;
      const v = k * 3;
      const d = Math.max(0, 1 - this.drag[k]! * dt);
      this.vel[v] = this.vel[v]! * d;
      this.vel[v + 1] = this.vel[v + 1]! * d - this.grav[k]! * dt;
      this.vel[v + 2] = this.vel[v + 2]! * d;
      this.pos[v] = this.pos[v]! + this.vel[v]! * dt;
      this.pos[v + 1] = this.pos[v + 1]! + this.vel[v + 1]! * dt;
      this.pos[v + 2] = this.pos[v + 2]! + this.vel[v + 2]! * dt;
      const f = Math.max(0, l / this.max[k]!);
      this.col[k * 4 + 3] = f;
      this.size[k] = this.base[k]! * (0.4 + 0.6 * f);
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i]!;
      r.life -= dt;
      const f = 1 - Math.max(0, r.life) / r.max;
      r.mesh.scale.setScalar(r.r0 + (r.r1 - r.r0) * (1 - Math.pow(1 - f, 2)));
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - f) * 0.9;
      if (r.life <= 0) {
        this.group.remove(r.mesh);
        this.ringPool.push(r.mesh);
        this.rings.splice(i, 1);
      }
    }
  }

  clear(): void {
    this.life.fill(0);
    for (const r of this.rings) {
      this.group.remove(r.mesh);
      this.ringPool.push(r.mesh);
    }
    this.rings.length = 0;
  }
}
