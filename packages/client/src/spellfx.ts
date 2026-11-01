import * as THREE from 'three';
import type { DuelState, Lane, PlayerId, ProjKind, Projectile, StormStrike, Well, Windup } from '@sigilfall/sim';
import { SPELL_INFO } from './theme';
import type { ParticleVfx } from './vfx';
import type { World } from './world';
import { LANE_SPACING, WIZ_Z } from './world';
import { makeGlow } from './rigs';
import { settings } from './settings';

export class Layout {
  constructor(public seat: PlayerId) {}
  laneX(lane: number): number {
    return (lane - 1) * LANE_SPACING * (this.seat === 0 ? 1 : -1);
  }
  zOf(p: PlayerId): number {
    return p === this.seat ? WIZ_Z : -WIZ_Z;
  }
  /** unit direction toward the opponent for player p */
  fwd(p: PlayerId): number {
    return p === this.seat ? -1 : 1;
  }
}

const COL: Record<ProjKind, number> = { cinder: 0xff7a2a, blast: 0xffcf4a, lance: 0x9b5cff, shard: 0xbfe6ff, eclipse: 0xffb020 };
const SHAPE_ICON: Record<ProjKind, string> = { cinder: 'flame', blast: 'circle', lance: 'spiral', shard: 'hex', eclipse: 'infinity' };
void SHAPE_ICON;

const WELL_F = /* glsl */ `
varying vec2 vUv; uniform float uTime;
void main(){
  vec2 p = vUv - 0.5; float r = length(p) * 2.0; float a = atan(p.y, p.x);
  float sp = 0.5 + 0.5 * sin(a * 5.0 + r * 14.0 - uTime * 7.0);
  float core = smoothstep(1.0, 0.0, r);
  float al = core * (0.35 + 0.65 * sp) + smoothstep(0.75,1.0,r) * (1.0 - smoothstep(1.0,1.02,r)) * 0.9;
  vec3 c = mix(vec3(0.05,0.0,0.12), vec3(0.62,0.34,1.0), sp * (1.0 - core*0.6));
  gl_FragColor = vec4(c, al);
}`;
const QUAD_V = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;

interface ProjView {
  group: THREE.Group;
  light?: THREE.PointLight;
  ring: THREE.Mesh;
  parts: THREE.Object3D[];
  kind: ProjKind;
  last: THREE.Vector3;
  origin: THREE.Vector3;
}

export class SpellFx {
  readonly group = new THREE.Group();
  private proj = new Map<number, ProjView>();
  private strikes = new Map<number, { line: THREE.Line; ring: THREE.Mesh; mark: THREE.Mesh }>();
  private wards: Record<number, { g: THREE.Group; mats: THREE.MeshStandardMaterial[]; grow: number; lastHp: number } | null> = { 0: null, 1: null };
  private mirrors: Record<number, { g: THREE.Group; t: number } | null> = { 0: null, 1: null };
  private wells = new Map<number, { m: THREE.Mesh; mat: THREE.ShaderMaterial; t: number }>();
  private eclipse: Record<number, { g: THREE.Group; t: number } | null> = { 0: null, 1: null };
  private t = 0;
  private dangerMats = new THREE.MeshBasicMaterial({ color: 0xff3b2f, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  private ringGeo = new THREE.RingGeometry(0.86, 1, 40);
  private outline = new THREE.MeshBasicMaterial({ color: 0x080204, side: THREE.BackSide });
  private bolts: { line: THREE.Line[]; life: number }[] = [];
  /** world position of a wizard's wand tip: projectiles are born here and fly out */
  tipOf: (p: PlayerId) => THREE.Vector3 = () => new THREE.Vector3(0, 1.5, 0);
  private charges: Record<number, { g: THREE.Group; core: THREE.Mesh; ring: THREE.Mesh; ring2: THREE.Mesh; glow: THREE.Sprite } | null> = { 0: null, 1: null };

  constructor(private world: World, private vfx: ParticleVfx, public layout: Layout) {
    world.scene.add(this.group);
  }

  setLayout(l: Layout): void {
    this.layout = l;
  }

  reset(): void {
    for (const v of this.proj.values()) this.group.remove(v.group);
    this.proj.clear();
    for (const s of this.strikes.values()) this.group.remove(s.line, s.ring, s.mark);
    this.strikes.clear();
    for (const p of [0, 1]) {
      if (this.wards[p]) this.group.remove(this.wards[p]!.g);
      if (this.mirrors[p]) this.group.remove(this.mirrors[p]!.g);
      if (this.eclipse[p]) this.group.remove(this.eclipse[p]!.g);
      this.wards[p] = this.mirrors[p] = this.eclipse[p] = null;
    }
    for (const w of this.wells.values()) this.group.remove(w.m);
    this.wells.clear();
    for (const b of this.bolts) b.line.forEach((l) => this.group.remove(l));
    this.bolts.length = 0;
  }

  projPos(pr: Projectile, viewTick: number, out = new THREE.Vector3()): THREE.Vector3 {
    const f = THREE.MathUtils.clamp((viewTick - pr.born) / Math.max(1, pr.arrive - pr.born), 0, 1);
    const z0 = this.layout.zOf(pr.owner) + this.layout.fwd(pr.owner) * 1.4;
    const z1 = this.layout.zOf(pr.owner === 0 ? 1 : 0) - this.layout.fwd(pr.owner) * 0.4;
    // projectiles are launched from the caster's lane position, then slide into the target lane if it was re-laned
    return out.set(this.layout.laneX(pr.lane), pr.kind === 'eclipse' ? 1.7 : 1.5 + Math.sin(f * Math.PI) * 0.15, z0 + (z1 - z0) * f);
  }

  private makeProj(pr: Projectile): ProjView {
    const g = new THREE.Group();
    const parts: THREE.Object3D[] = [];
    const reflected = pr.reflected;
    const c = reflected ? 0xdfe8f5 : COL[pr.kind];
    let r = 0.26;
    let core: THREE.Mesh;
    if (pr.kind === 'shard') {
      r = 0.2;
      core = new THREE.Mesh(new THREE.OctahedronGeometry(r, 0), new THREE.MeshBasicMaterial({ color: 0xeaf8ff }));
      core.scale.set(0.7, 1.4, 0.7);
    } else if (pr.kind === 'lance') {
      core = new THREE.Mesh(new THREE.ConeGeometry(0.2, 1.1, 10), new THREE.MeshBasicMaterial({ color: 0xe6d4ff }));
      core.rotation.x = Math.PI / 2 * (this.layout.fwd(pr.owner) > 0 ? 1 : -1);
    } else if (pr.kind === 'eclipse') {
      r = 0.95;
      core = new THREE.Mesh(new THREE.SphereGeometry(r, 28, 20), new THREE.MeshBasicMaterial({ color: 0x030106 }));
      const cor = new THREE.Mesh(new THREE.TorusGeometry(r * 1.18, 0.07, 8, 56), new THREE.MeshBasicMaterial({ color: 0xffc23a, blending: THREE.AdditiveBlending, transparent: true }));
      const inner = new THREE.Mesh(new THREE.TorusGeometry(r * 1.02, 0.045, 8, 48), new THREE.MeshBasicMaterial({ color: 0xa36bff, blending: THREE.AdditiveBlending, transparent: true }));
      inner.rotation.x = 1.0;
      parts.push(cor, inner);
      g.add(cor, inner, makeGlow(0xffb020, r * 6, 0.65));
    } else {
      core = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 14), new THREE.MeshBasicMaterial({ color: pr.kind === 'blast' ? 0xfff2b8 : 0xfff0d0 }));
    }
    const out = new THREE.Mesh((core.geometry as THREE.BufferGeometry).clone(), this.outline);
    out.scale.copy(core.scale).multiplyScalar(1.28);
    out.rotation.copy(core.rotation);
    g.add(out, core);
    if (pr.kind !== 'eclipse') g.add(makeGlow(c, r * 5.5, 0.75));
    let light: THREE.PointLight | undefined;
    if (pr.kind === 'cinder' || pr.kind === 'eclipse') {
      light = new THREE.PointLight(c, pr.kind === 'eclipse' ? 3 : 2.2, 9, 1.8);
      g.add(light);
    }
    // danger language: lane + countdown ring painted on the floor where it will land
    const ring = new THREE.Mesh(this.ringGeo, this.dangerMats.clone());
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06;
    ring.renderOrder = 3;
    this.group.add(ring);
    this.group.add(g);
    return { group: g, light, ring, parts, kind: pr.kind, last: new THREE.Vector3(), origin: this.tipOf(pr.owner).clone() };
  }

  /** Called every frame with the interpolated view tick. */
  update(dt: number, s: DuelState, viewTick: number): void {
    this.t += dt;
    const lay = this.layout;
    const me = lay.seat;
    const seen = new Set<number>();
    const danger = [0, 0, 0];
    for (const pr of s.projectiles) {
      seen.add(pr.id);
      let v = this.proj.get(pr.id);
      if (!v) {
        v = this.makeProj(pr);
        this.proj.set(pr.id, v);
      }
      const f0 = THREE.MathUtils.clamp((viewTick - pr.born) / Math.max(1, pr.arrive - pr.born), 0, 1);
      const k = THREE.MathUtils.smoothstep(f0, 0, pr.kind === 'eclipse' ? 0.12 : 0.22);
      const pos = this.projPos(pr, viewTick, new THREE.Vector3());
      pos.lerpVectors(v.origin, pos, k); // leaves the wand tip, then settles into its lane
      v.group.position.copy(pos);
      const grow = 0.3 + 0.7 * k;
      const incoming = pr.owner !== me;
      const eta = Math.max(0, pr.arrive - viewTick);
      const f = 1 - eta / Math.max(1, pr.arrive - pr.born);
      // emit trail
      if (!settings.clarity || pr.kind === 'eclipse') {
        const col = pr.reflected ? 0xdfe8f5 : COL[pr.kind];
        if (pr.kind === 'cinder') this.vfx.burst({ pos, color: col, count: 3, speed: 0.6, life: 0.45, size: 0.14, gravity: -0.6, dir: new THREE.Vector3(0, 0, -lay.fwd(pr.owner)), spread: 0.8 });
        else if (pr.kind === 'eclipse') this.vfx.burst({ pos, color: Math.random() < 0.5 ? 0xffb020 : 0xa36bff, count: 5, speed: 1.4, life: 0.8, size: 0.18, inward: true, radius: 1.8 });
        else if (pr.kind === 'lance') this.vfx.burst({ pos, color: col, count: 2, speed: 0.5, life: 0.4, size: 0.1 });
        else this.vfx.burst({ pos, color: col, count: 1, speed: 0.4, life: 0.4, size: 0.1 });
      }
      if (pr.kind === 'eclipse') {
        v.group.rotation.z += dt * 1.5;
        v.parts.forEach((p, i) => { p.rotation.x += dt * (1 + i); p.rotation.y += dt * 0.7; });
        v.group.scale.setScalar((1 + Math.sin(this.t * 9) * 0.03) * grow);
      } else {
        v.group.scale.setScalar(grow);
        if (pr.kind === 'shard') v.group.rotation.y += dt * 6;
      }
      if (v.light) v.light.intensity = (pr.kind === 'eclipse' ? 3 : 2.2) * (0.8 + Math.sin(this.t * 40) * 0.2);
      // countdown ring at the landing spot
      const tz = lay.zOf(pr.owner === 0 ? 1 : 0);
      v.ring.position.set(lay.laneX(pr.lane), 0.06, tz);
      const showRing = incoming || true;
      v.ring.visible = showRing && eta > 0;
      const rs = 0.4 + eta * 0.06;
      v.ring.scale.setScalar(Math.max(0.45, Math.min(2.4, rs)));
      (v.ring.material as THREE.MeshBasicMaterial).opacity = incoming ? 0.35 + (1 - Math.min(1, eta / 20)) * 0.6 : 0.18;
      (v.ring.material as THREE.MeshBasicMaterial).color.setHex(incoming ? 0xff3b2f : 0x7fd6ff);
      if (incoming) danger[pr.lane] = Math.max(danger[pr.lane]!, 0.18 + f * 0.3);
      void f;
    }
    for (const [id, v] of this.proj) {
      if (!seen.has(id)) {
        this.group.remove(v.group, v.ring);
        this.proj.delete(id);
      }
    }

    // storm marks
    const seenS = new Set<number>();
    for (const st of s.strikes) {
      seenS.add(st.id);
      let v = this.strikes.get(st.id);
      if (!v) {
        v = this.makeStrike(st);
        this.strikes.set(st.id, v);
      }
      const x = lay.laneX(st.lane);
      const tz = lay.zOf(st.owner === 0 ? 1 : 0);
      const oz = lay.zOf(st.owner);
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 18; i++) {
        const u = i / 18;
        pts.push(new THREE.Vector3(x + (i === 0 || i === 18 ? 0 : (Math.random() - 0.5) * 0.35), 0.12 + Math.random() * 0.1, oz + (tz - oz) * u));
      }
      v.line.geometry.setFromPoints(pts);
      v.ring.position.set(x, 0.07, tz);
      const eta = Math.max(0, st.hit - viewTick);
      v.ring.scale.setScalar(0.5 + eta * 0.09);
      v.mark.position.set(x, 0.08, tz);
      v.mark.rotation.z += dt * 2;
      (v.ring.material as THREE.MeshBasicMaterial).opacity = 0.5 + Math.sin(this.t * 30) * 0.3;
      if (st.owner !== me) danger[st.lane] = Math.max(danger[st.lane]!, 0.4);
    }
    for (const [id, v] of this.strikes) {
      if (!seenS.has(id)) {
        this.group.remove(v.line, v.ring, v.mark);
        this.strikes.delete(id);
      }
    }
    this.world.laneGlow.forEach((m, i) => {
      const mat = m.material as THREE.MeshBasicMaterial;
      const d = danger[i]!;
      mat.opacity = 0.05 + d * (0.7 + Math.sin(this.t * 14) * 0.3);
      mat.color.setHex(d > 0 ? 0xff4636 : 0x8aa8ff);
    });

    // bolts (storm strike flashes)
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i]!;
      b.life -= dt;
      b.line.forEach((l) => ((l.material as THREE.LineBasicMaterial).opacity = Math.max(0, b.life / 0.22)));
      if (b.life <= 0) {
        b.line.forEach((l) => this.group.remove(l));
        this.bolts.splice(i, 1);
      }
    }

    // wards, mirrors, wells, eclipse channels
    for (const p of [0, 1] as PlayerId[]) {
      const w = s.w[p];
      this.syncWard(p, w.ward, dt);
      this.syncMirror(p, w.mirror !== null, w.lane, dt);
      this.syncEclipse(p, w.state === 'channeling', dt);
    }
    const seenW = new Set<number>();
    for (const wl of s.wells) {
      seenW.add(wl.id);
      this.syncWell(wl, s, dt);
    }
    for (const [id, w] of this.wells) {
      if (!seenW.has(id)) {
        this.group.remove(w.m);
        this.wells.delete(id);
      }
    }
  }

  /** the visible charge-up: an orb of the spell's colour condenses at the wand tip before it is released */
  charge(p: PlayerId, wu: Windup | null, tick: number, tip: THREE.Vector3, dt: number): void {
    let c = this.charges[p];
    if (!wu) {
      if (c) c.g.visible = false;
      return;
    }
    if (!c) {
      const g = new THREE.Group();
      const core = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 }));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.05, 6, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
      const ring2 = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.03, 6, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
      const glow = makeGlow(0xffffff, 4, 0.7);
      g.add(core, ring, ring2, glow);
      this.group.add(g);
      c = { g, core, ring, ring2, glow };
      this.charges[p] = c;
    }
    const info = SPELL_INFO[wu.spell];
    const prog = THREE.MathUtils.clamp((tick - wu.start) / Math.max(1, wu.end - wu.start), 0, 1);
    const big = wu.spell === 'eclipse' ? 3.2 : wu.spell === 'gravewell' || wu.spell === 'ward' ? 1.6 : 1;
    const size = (0.03 + 0.15 * prog * prog) * big * (wu.misfire ? 1 + Math.sin(this.t * 60) * 0.25 : 1);
    c.g.visible = true;
    c.g.position.copy(tip);
    c.core.scale.setScalar(size);
    (c.core.material as THREE.MeshBasicMaterial).color.setHex(wu.misfire ? 0x442222 : info.color).lerp(new THREE.Color(0xffffff), 0.55);
    c.ring.scale.setScalar(size * (1.6 - prog * 0.6));
    c.ring2.scale.setScalar(size * (2.2 - prog * 1.1));
    c.ring.rotation.x += dt * 5;
    c.ring.rotation.y += dt * 3;
    c.ring2.rotation.z -= dt * 4;
    c.ring2.rotation.x += dt * 2;
    for (const m of [c.ring, c.ring2]) (m.material as THREE.MeshBasicMaterial).color.setHex(info.color);
    c.glow.material.color.setHex(info.color);
    c.glow.scale.setScalar(size * 9 * (0.8 + Math.sin(this.t * 14) * 0.1));
  }

  private makeStrike(st: StormStrike) {
    const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xaff6ff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
    line.frustumCulled = false;
    const ring = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: 0x8ff6ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    const mark = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.28, 3), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    mark.rotation.x = -Math.PI / 2;
    this.group.add(line, ring, mark);
    void st;
    return { line, ring, mark };
  }

  /** lightning bolt from the sky onto lane/target */
  strikeBolt(lane: Lane, target: PlayerId): void {
    const x = this.layout.laneX(lane);
    const z = this.layout.zOf(target);
    const lines: THREE.Line[] = [];
    const mk = (x0: number, y0: number, z0: number, depth: number) => {
      const pts: THREE.Vector3[] = [new THREE.Vector3(x0, y0, z0)];
      let cx = x0;
      let cz = z0;
      const n = 12;
      for (let i = 1; i <= n; i++) {
        cx += (Math.random() - 0.5) * 1.0;
        cz += (Math.random() - 0.5) * 1.0;
        pts.push(new THREE.Vector3(i === n ? x : cx, y0 - (y0 / n) * i, i === n ? z : cz));
        if (depth < 2 && Math.random() < 0.28) mk(cx, y0 - (y0 / n) * i, cz, depth + 1);
      }
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xe8ffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
      this.group.add(l);
      lines.push(l);
    };
    mk(x + (Math.random() - 0.5) * 1.5, 16, z, 0);
    this.bolts.push({ line: lines, life: 0.22 });
  }

  private syncWard(p: PlayerId, ward: { hp: number; max: number } | null, dt: number): void {
    let v = this.wards[p];
    if (!ward) {
      if (v) {
        this.group.remove(v.g);
        this.wards[p] = null;
      }
      return;
    }
    if (!v) {
      const g = new THREE.Group();
      const mats: THREE.MeshStandardMaterial[] = [];
      const edgeMat = new THREE.LineBasicMaterial({ color: 0xeaf8ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending });
      for (let i = 0; i < 13; i++) {
        const row = i % 2;
        const h = 2.4 + ((i * 7) % 5) * 0.45;
        const geo = new THREE.CylinderGeometry(0.03, 0.5 + row * 0.1, h, 6);
        const m = new THREE.MeshStandardMaterial({ color: 0xbfe6ff, emissive: 0x4ea0e0, emissiveIntensity: 0.8, transparent: true, opacity: 0.62, roughness: 0.1, metalness: 0.3, flatShading: true });
        mats.push(m);
        const c = new THREE.Mesh(geo, m);
        c.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat));
        c.position.set((i - 6) * 0.72 + row * 0.2, h / 2, row * 0.45 - 0.2);
        c.rotation.set(((i * 13) % 5 - 2) * 0.03, i, ((i * 11) % 5 - 2) * 0.04);
        g.add(c);
      }
      g.position.z = this.layout.zOf(p) + this.layout.fwd(p) * 2.5;
      g.scale.y = 0.01;
      this.group.add(g);
      const base = new THREE.Mesh(new THREE.PlaneGeometry(10, 1.6), new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }));
      base.rotation.x = -Math.PI / 2;
      base.position.y = 0.05;
      g.add(base);
      v = { g, mats, grow: 0, lastHp: ward.hp };
      this.wards[p] = v;
      this.vfx.burst({ pos: new THREE.Vector3(0, 0.2, g.position.z), color: 0xbfe6ff, count: 60, speed: 2.5, life: 0.9, size: 0.12, gravity: -0.5, spread: 1 });
    }
    v.grow = Math.min(1, v.grow + dt * 5);
    v.g.scale.y = 0.01 + 0.99 * (1 - Math.pow(1 - v.grow, 3));
    const f = Math.max(0, ward.hp / ward.max);
    for (const m of v.mats) {
      m.opacity = 0.28 + f * 0.4;
      m.emissiveIntensity = 0.3 + f * 0.6 + Math.max(0, (v.lastHp - ward.hp) / 6);
      m.color.setRGB(0.6 + f * 0.1, 0.8 + f * 0.1, 1);
    }
    v.lastHp = ward.hp;
    if (Math.random() < dt * 3 && !settings.clarity) this.vfx.burst({ pos: new THREE.Vector3((Math.random() - 0.5) * 8, 2.5, v.g.position.z), color: 0xdff4ff, count: 2, speed: 0.3, life: 1, size: 0.08, gravity: 0.3 });
  }

  wardCenter(p: PlayerId): THREE.Vector3 {
    return new THREE.Vector3(0, 1.4, this.layout.zOf(p) + this.layout.fwd(p) * 2.5);
  }

  private syncMirror(p: PlayerId, on: boolean, lane: number, dt: number): void {
    let v = this.mirrors[p];
    if (!on) {
      if (v) {
        this.group.remove(v.g);
        this.mirrors[p] = null;
      }
      return;
    }
    if (!v) {
      const g = new THREE.Group();
      const diamond = new THREE.Mesh(
        new THREE.OctahedronGeometry(1, 0),
        new THREE.ShaderMaterial({
          transparent: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
          uniforms: { uTime: { value: 0 } },
          vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vN = normalize(normalMatrix*normal); vec4 mv = modelViewMatrix*vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }',
          fragmentShader: 'varying vec3 vN; varying vec3 vV; uniform float uTime; void main(){ float f = pow(1.0-abs(dot(vN,vV)),1.6); float s = 0.5+0.5*sin(vN.x*9.0+vN.y*7.0+uTime*4.0); vec3 c = mix(vec3(0.65,0.75,0.95), vec3(1.0), s); gl_FragColor = vec4(c*(0.45+f*1.4), 0.35+f*0.6); }',
        }),
      );
      diamond.scale.set(1.5, 2.1, 0.22);
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.OctahedronGeometry(1, 0)), new THREE.LineBasicMaterial({ color: 0xffffff }));
      edge.scale.copy(diamond.scale);
      g.add(diamond, edge);
      g.position.set(this.layout.laneX(lane), 1.7, this.layout.zOf(p) + this.layout.fwd(p) * 1.7);
      this.group.add(g);
      v = { g, t: 0 };
      this.mirrors[p] = v;
    }
    v.t += dt;
    v.g.rotation.y = Math.sin(v.t * 3) * 0.35;
    v.g.position.x = this.layout.laneX(lane);
    ((v.g.children[0] as THREE.Mesh).material as THREE.ShaderMaterial).uniforms.uTime!.value = v.t;
  }

  mirrorCenter(p: PlayerId, lane: number): THREE.Vector3 {
    return new THREE.Vector3(this.layout.laneX(lane), 1.7, this.layout.zOf(p) + this.layout.fwd(p) * 1.7);
  }

  private syncWell(wl: Well, s: DuelState, dt: number): void {
    let v = this.wells.get(wl.id);
    if (!v) {
      const mat = new THREE.ShaderMaterial({ vertexShader: QUAD_V, fragmentShader: WELL_F, transparent: true, depthWrite: false, side: THREE.DoubleSide, uniforms: { uTime: { value: 0 } } });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      m.renderOrder = 20;
      this.group.add(m);
      v = { m, mat, t: 0 };
      this.wells.set(wl.id, v);
    }
    v.t += dt;
    const owner = wl.owner;
    const lane = s.w[owner].lane;
    const pos = new THREE.Vector3(this.layout.laneX(lane), 1.5, this.layout.zOf(owner) + this.layout.fwd(owner) * 3.4);
    v.m.position.copy(pos);
    v.m.lookAt(this.world.camera.position);
    const k = Math.min(1, v.t * 4);
    v.m.scale.setScalar(4.2 * k * (1 - Math.max(0, (v.t - 0.8)) * 1.5));
    v.mat.uniforms.uTime!.value = v.t;
    if (!settings.clarity) this.vfx.burst({ pos, color: 0x8a4dff, count: 6, speed: 4, life: 0.5, size: 0.12, inward: true, radius: 3.2 });
  }

  private syncEclipse(p: PlayerId, on: boolean, dt: number): void {
    let v = this.eclipse[p];
    if (!on) {
      if (v) {
        this.group.remove(v.g);
        this.eclipse[p] = null;
      }
      return;
    }
    if (!v) {
      const g = new THREE.Group();
      g.add(
        new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 14), new THREE.MeshBasicMaterial({ color: 0x020005 })),
        new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.03, 8, 48), new THREE.MeshBasicMaterial({ color: 0xffc23a, blending: THREE.AdditiveBlending, transparent: true })),
        new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.02, 8, 48), new THREE.MeshBasicMaterial({ color: 0xa36bff, blending: THREE.AdditiveBlending, transparent: true })),
        makeGlow(0xffb020, 3.6, 0.5),
      );
      this.group.add(g);
      v = { g, t: 0 };
      this.eclipse[p] = v;
    }
    v.t += dt;
    const k = Math.min(1, v.t / 2.5);
    g_scale(v.g, 0.25 + k * 1.1);
    v.g.position.set(this.layout.laneX(1) * 0 + (p === this.layout.seat ? 0 : 0), 1.8, this.layout.zOf(p) + this.layout.fwd(p) * 1.9);
    v.g.children[1]!.rotation.x += dt * 2;
    v.g.children[2]!.rotation.y += dt * 3;
  }

  channelPos(p: PlayerId, lane: number): THREE.Vector3 {
    return new THREE.Vector3(this.layout.laneX(lane), 1.8, this.layout.zOf(p) + this.layout.fwd(p) * 1.9);
  }
}

function g_scale(g: THREE.Object3D, s: number): void {
  g.scale.setScalar(s);
}
