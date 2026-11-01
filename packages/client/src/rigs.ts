import * as THREE from 'three';
import type { SpellId, Wizard } from '@sigilfall/sim';
import { canonical } from '@sigilfall/recognizer';
import type { ParticleVfx } from './vfx';
import { FAMILY_COLOR, SPELL_INFO } from './theme';
import { settings } from './settings';

let glowTex: THREE.CanvasTexture | null = null;
export function glowTexture(): THREE.CanvasTexture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

export function makeGlow(color: number, size: number, opacity = 0.9): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity }));
  s.scale.setScalar(size);
  return s;
}

/** An orbiting Aurum/Umbra orb. Aurum radiates outward pulses; Umbra sucks particles inward. */
export class OrbVisual {
  readonly group = new THREE.Group();
  private core: THREE.Mesh;
  private glow: THREE.Sprite;
  private t = Math.random() * 10;
  constructor(readonly kind: 'aurum' | 'umbra', size = 0.14) {
    const color = kind === 'aurum' ? 0xffcf4a : 0x8a4dff;
    this.core = new THREE.Mesh(new THREE.SphereGeometry(size, 20, 14), new THREE.MeshBasicMaterial({ color: kind === 'aurum' ? 0xfff0b0 : 0x2a0a55 }));
    const shell = new THREE.Mesh(new THREE.SphereGeometry(size * 1.35, 18, 12), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.glow = makeGlow(color, size * 7, 0.8);
    this.group.add(this.core, shell, this.glow);
  }
  update(dt: number, vfx: ParticleVfx, emit = true): void {
    this.t += dt;
    const k = 1 + Math.sin(this.t * 6) * 0.12;
    this.core.scale.setScalar(k);
    this.glow.material.opacity = 0.6 + Math.sin(this.t * 5) * 0.2;
    if (emit && !settings.clarity && Math.random() < dt * 14) {
      const p = this.group.getWorldPosition(new THREE.Vector3());
      if (this.kind === 'aurum') vfx.burst({ pos: p, color: 0xffd45e, count: 1, speed: 0.7, life: 0.7, size: 0.05 });
      else vfx.burst({ pos: p, color: 0xa36bff, count: 1, speed: 0.6, life: 0.5, size: 0.05, inward: true, radius: 0.45 });
    }
  }
}

function toon(color: number, emissive = 0x000000, e = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: e, roughness: 0.7, metalness: 0.1, flatShading: true });
}

export interface RigPose {
  raise: number;
  wind: number;
  thrust: number;
  flinch: number;
  stagger: number;
  shudder: number;
  dead: number;
  blinkX: number;
}

export class PoseState {
  p: RigPose = { raise: 0, wind: 0, thrust: 0, flinch: 0, stagger: 0, shudder: 0, dead: 0, blinkX: 0 };
  thrust(v = 1): void { this.p.thrust = v; }
  flinch(v = 1): void { this.p.flinch = v; }
  step(w: Wizard, dt: number): void {
    const s = this.p;
    const k = (a: number, t: number, r: number) => a + (t - a) * Math.min(1, dt * r);
    s.raise = k(s.raise, w.state === 'drawing' || w.state === 'windup' || w.state === 'channeling' ? 1 : 0, 10);
    s.wind = k(s.wind, w.state === 'windup' || w.state === 'channeling' ? 1 : 0, 8);
    s.stagger = k(s.stagger, w.state === 'staggered' ? 1 : 0, 9);
    s.shudder = k(s.shudder, w.state === 'exhausted' ? 1 : 0, 12);
    s.dead = k(s.dead, w.state === 'dead' ? 1 : 0, 3);
    s.thrust = Math.max(0, s.thrust - dt * 4.5);
    s.flinch = Math.max(0, s.flinch - dt * 5);
  }
}

export interface Palette {
  coat: number;
  coatEmissive: number;
  trim: number;
  collar: number;
  hood: number;
  glow: number;
  eye: number;
  skin: number;
}
export const CORVANE: Palette = { coat: 0x6a7a9c, coatEmissive: 0x1a2440, trim: 0xc9a24a, collar: 0x2d3648, hood: 0x20283a, glow: 0x8fd4ff, eye: 0x8ff6ff, skin: 0xd8d2cc };
export const APPRENTICE: Palette = { coat: 0x2f6f78, coatEmissive: 0x0e3a40, trim: 0xe6d7a0, collar: 0x1f4a52, hood: 0x173a42, glow: 0xffd88a, eye: 0xffe6a8, skin: 0xe8c9a8 };

/** A duelling wizard built from primitives. Corvane Vael (the Hollow Magister) uses CORVANE; the player's avatar uses APPRENTICE. */
export class EnemyRig {
  readonly group = new THREE.Group();
  readonly pose = new PoseState();
  private body = new THREE.Group();
  private armR = new THREE.Group();
  private armL = new THREE.Group();
  private halo = new THREE.Group();
  private wandTip = new THREE.Object3D();
  private handL = new THREE.Object3D();
  private eyeMat = new THREE.MeshBasicMaterial({ color: 0x8ff6ff });
  private fragments: THREE.Mesh[] = [];
  private orbA = new OrbVisual('aurum', 0.16);
  private orbU = new OrbVisual('umbra', 0.16);
  private tellGroup = new THREE.Group();
  private tellLine: THREE.Line;
  private tellGlow: THREE.Sprite;
  private tellFamily = '';
  private tellSpell: SpellId | '' = '';
  private t = 0;
  private tipGlow: THREE.Sprite;
  private cape: THREE.Mesh;
  private taunt = 0;
  /** boss phase 1-3: later phases burn hotter */
  rage = 1;
  private nextTaunt = 7;

  constructor(private vfx: ParticleVfx, private pal: Palette = CORVANE) {
    const coat = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.9, 2.1, 12, 1), toon(pal.coat, pal.coatEmissive, 0.35));
    coat.position.y = 1.05;
    const trim = new THREE.Mesh(new THREE.TorusGeometry(0.74, 0.04, 6, 24), toon(pal.trim, 0x6a4a10, 0.4));
    trim.rotation.x = Math.PI / 2;
    trim.position.y = 0.32;
    const collar = new THREE.Mesh(new THREE.ConeGeometry(0.62, 0.8, 8, 1, true), new THREE.MeshStandardMaterial({ color: pal.collar, side: THREE.DoubleSide, flatShading: true }));
    collar.position.y = 2.2;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 14, 12), toon(pal.skin));
    head.scale.set(0.9, 1.15, 0.95);
    head.position.y = 2.38;
    const hood = new THREE.Mesh(new THREE.SphereGeometry(0.31, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), toon(pal.hood));
    hood.position.y = 2.46;
    hood.scale.set(1, 1.1, 1.05);
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.025, 0.03), this.eyeMat);
      eye.position.set(sx * 0.09, 2.4, 0.25);
      this.body.add(eye);
    }
    this.cape = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.9, 1, 6), new THREE.MeshStandardMaterial({ color: 0x2c3548, side: THREE.DoubleSide, flatShading: true }));
    this.cape.position.set(0, 1.2, -0.34);
    this.body.add(coat, trim, collar, head, hood, this.cape);
    this.eyeMat.color.setHex(pal.eye);

    // layered robe, belt, mantle, boots, chest sigil: more silhouette, less cone
    const robeMat = toon(pal.coat, pal.coatEmissive, 0.25);
    for (const [r0, r1, h, y] of [[0.5, 1.05, 0.9, 0.5], [0.4, 0.82, 0.7, 0.9]] as const) {
      const tier = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, h, 12, 1, true), robeMat);
      tier.position.y = y;
      (tier.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
      this.body.add(tier);
    }
    const hem = new THREE.Mesh(new THREE.TorusGeometry(1.03, 0.025, 6, 40), new THREE.MeshBasicMaterial({ color: pal.glow, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending }));
    hem.rotation.x = Math.PI / 2;
    hem.position.y = 0.08;
    this.body.add(hem);
    const belt = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.05, 6, 20), toon(0x2a2118));
    belt.rotation.x = Math.PI / 2;
    belt.position.y = 1.18;
    const buckle = new THREE.Mesh(new THREE.OctahedronGeometry(0.08, 0), new THREE.MeshBasicMaterial({ color: pal.glow }));
    buckle.position.set(0, 1.18, 0.47);
    const mantle = new THREE.Mesh(new THREE.SphereGeometry(0.62, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), toon(pal.collar, pal.coatEmissive, 0.2));
    mantle.scale.set(1.1, 0.55, 0.85);
    mantle.position.y = 1.95;
    const sigil = new THREE.Mesh(new THREE.CircleGeometry(0.15, 3), new THREE.MeshBasicMaterial({ color: pal.glow, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending }));
    sigil.position.set(0, 1.7, 0.34);
    sigil.rotation.z = Math.PI / 2;
    const beard = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.34, 6), toon(pal === CORVANE ? 0x8a8f9e : 0x6b4a2c));
    beard.rotation.x = Math.PI;
    beard.position.set(0, 2.15, 0.2);
    for (const sx of [-1, 1]) {
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.42), toon(0x15171f));
      boot.position.set(sx * 0.28, 0.07, 0.62);
      this.body.add(boot);
    }
    this.body.add(belt, buckle, mantle, sigil, beard);
    mantle.scale.set(1.45, 0.6, 0.95);
    if (pal === CORVANE) {
      const spire = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.75, 8), toon(pal.hood));
      spire.position.set(0, 2.95, -0.04);
      spire.rotation.x = -0.12;
      this.body.add(spire);
    } else {
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.05, 16), toon(pal.hood));
      brim.position.set(0, 2.6, 0);
      const hat = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.95, 10), toon(pal.coat, pal.coatEmissive, 0.3));
      hat.position.set(0, 3.1, -0.05);
      hat.rotation.x = -0.18;
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.33, 0.1, 10), toon(pal.trim, 0x6a4a10, 0.4));
      band.position.set(0, 2.66, 0);
      this.body.add(brim, hat, band);
    }
    const fragMat = new THREE.MeshBasicMaterial({ color: pal.glow, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending });
    for (let i = 0; i < 6; i++) {
      const f = new THREE.Mesh(new THREE.OctahedronGeometry(0.07 + (i % 3) * 0.02, 0), fragMat);
      f.userData.a = (i / 6) * Math.PI * 2;
      f.userData.h = 0.6 + (i % 3) * 0.55;
      this.fragments.push(f);
      this.body.add(f);
    }
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(1.1, 24), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45 }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.04;
    const under = new THREE.Mesh(new THREE.RingGeometry(0.95, 1.12, 40), new THREE.MeshBasicMaterial({ color: pal.glow, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    under.rotation.x = -Math.PI / 2;
    under.position.y = 0.05;
    this.group.add(shadow, under);

    // arms
    const mkArm = (g: THREE.Group, sx: number) => {
      const up = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.17, 0.7, 8), toon(pal.coat, pal.coatEmissive, 0.3));
      up.position.y = -0.35;
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), toon(pal.skin));
      hand.position.y = -0.74;
      g.add(up, hand);
      g.position.set(sx * 0.5, 1.95, 0.05);
      this.body.add(g);
    };
    mkArm(this.armR, 1);
    mkArm(this.armL, -1);
    const wand = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.03, 0.9, 6), toon(0x2b2018));
    wand.position.set(0, -0.74, 0.45);
    wand.rotation.x = Math.PI / 2;
    this.armR.add(wand);
    this.wandTip.position.set(0, -0.74, 0.92);
    this.armR.add(this.wandTip);
    this.tipGlow = makeGlow(0xffffff, 0.45, 0);
    this.wandTip.add(this.tipGlow);
    this.handL.position.set(0, -0.74, 0.1);
    this.armL.add(this.handL);
    this.handL.add(this.orbA.group, this.orbU.group);
    this.orbA.group.visible = this.orbU.group.visible = false;

    // halo of broken astrolabe rings
    const hm = new THREE.MeshBasicMaterial({ color: pal.glow, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending });
    [[0.75, 3.8], [0.98, 4.4], [1.22, 3.2]].forEach(([r, arc], i) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r!, 0.018, 6, 48, arc), hm);
      ring.rotation.set(0.9 + i * 0.5, i * 1.1, 0);
      ring.userData.sp = (i % 2 ? -1 : 1) * (0.5 + i * 0.25);
      this.halo.add(ring);
    });
    this.halo.position.y = 2.55;
    this.body.add(this.halo);

    // tell ghost in front of the wizard
    this.tellGlow = makeGlow(0xffffff, 1.6, 0);
    this.tellGlow.position.set(0, 2.1, 1.4);
    const geo = new THREE.BufferGeometry();
    this.tellLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.tellLine.position.set(0, 2.1, 1.4);
    this.tellGroup.add(this.tellGlow, this.tellLine);
    this.group.add(this.body, this.tellGroup);
    this.body.scale.setScalar(1.12);
    this.group.rotation.y = 0;
  }

  setFacing(awayZ: number): void {
    this.group.rotation.y = awayZ > 0 ? 0 : Math.PI;
  }

  tip(out = new THREE.Vector3()): THREE.Vector3 {
    return this.wandTip.getWorldPosition(out);
  }

  hand(out = new THREE.Vector3()): THREE.Vector3 {
    return this.handL.getWorldPosition(out);
  }

  head(out = new THREE.Vector3()): THREE.Vector3 {
    return this.group.localToWorld(out.set(0, 2.2, 0));
  }

  doTaunt(): void {
    this.taunt = 1;
  }

  private setTell(family: string | null, spell: SpellId | null): void {
    const mat = this.tellLine.material as THREE.LineBasicMaterial;
    if (!family) {
      this.tellFamily = '';
      this.tellSpell = '';
      this.tellGlow.material.opacity = 0;
      mat.opacity = 0;
      return;
    }
    if (family !== this.tellFamily) {
      this.tellFamily = family;
      this.tellGlow.material.color.setHex(FAMILY_COLOR[family] ?? 0xffffff);
    }
    this.tellGlow.material.opacity = 0.75;
    if (spell && spell !== this.tellSpell) {
      this.tellSpell = spell;
      const info = SPELL_INFO[spell];
      const pts = canonical(info.shape, spell === 'umbra' ? 'ccw' : 'cw').map((p) => new THREE.Vector3((p.x - 0.5) * 1.5, -(p.y - 0.5) * 1.5, 0));
      this.tellLine.geometry.setFromPoints(pts);
      mat.color.setHex(info.color);
    }
    mat.opacity = spell ? 0.55 : 0;
  }

  update(dt: number, w: Wizard, laneX: number, z: number, now: number, holds: { aurum: boolean; umbra: boolean }, tellsOn = true): void {
    this.t += dt;
    this.pose.step(w, dt);
    const p = this.pose.p;
    const facing = z > 0 ? Math.PI : 0;
    this.group.rotation.y = facing;
    this.group.position.set(laneX + p.blinkX, 0, z);
    const bob = Math.sin(this.t * 1.5) * 0.04;
    this.body.position.y = bob - p.stagger * 0.55 - p.dead * 1.0;
    this.body.rotation.x = -p.stagger * 0.35 - p.flinch * 0.22 - p.dead * 1.3 + p.thrust * 0.12;
    this.body.rotation.z = Math.sin(this.t * 60) * 0.03 * p.shudder + p.flinch * 0.1;
    this.body.position.z = -p.flinch * 0.25 + p.thrust * 0.18;
    this.halo.children.forEach((c) => { c.rotation.z += c.userData.sp * dt * (1 + (this.rage - 1) * 1.2); });
    this.fragments.forEach((f, i) => {
      const a = f.userData.a + this.t * (0.7 + (i % 2) * 0.3);
      f.position.set(Math.cos(a) * 1.0, f.userData.h + Math.sin(this.t * 2 + i) * 0.08, Math.sin(a) * 1.0);
      f.rotation.set(a, a * 1.3, 0);
    });
    this.halo.position.y = 2.55 + Math.sin(this.t * 1.2) * 0.05;
    this.cape.rotation.x = 0.1 + Math.sin(this.t * 1.7) * 0.05 - p.thrust * 0.2;

    // arms: right raises the wand when drawing/casting, left gathers
    this.taunt = Math.max(0, this.taunt - dt * 0.8);
    this.nextTaunt -= dt;
    if (this.nextTaunt <= 0 && w.state === 'idle') {
      this.taunt = 1;
      this.nextTaunt = 9 + Math.random() * 8;
    }
    const flourish = Math.sin(this.taunt * Math.PI) * 1.2;
    this.armR.rotation.x = -0.15 - p.raise * 1.7 + p.thrust * 1.1 - flourish * 0.6 + Math.sin(this.t * 1.5) * 0.03;
    this.armR.rotation.z = -0.1 - flourish * 0.5;
    this.armL.rotation.x = -0.1 - p.wind * 1.2 + Math.sin(this.t * 1.3 + 1) * 0.03;
    this.armL.rotation.z = 0.1 + p.wind * 0.35;
    this.eyeMat.color.setHex(w.state === 'dead' ? 0x333333 : p.wind > 0.5 ? 0xffb347 : this.rage >= 3 ? 0xff3a2a : this.rage === 2 ? 0xffa040 : this.pal.eye);

    // orbs
    this.orbA.group.visible = holds.aurum;
    this.orbU.group.visible = holds.umbra;
    this.orbA.group.position.set(Math.cos(this.t * 2.4) * 0.28, 0.1 + Math.sin(this.t * 3) * 0.06, Math.sin(this.t * 2.4) * 0.28 + 0.1);
    this.orbU.group.position.set(Math.cos(this.t * 2.4 + Math.PI) * 0.28, 0.1 + Math.sin(this.t * 3 + 2) * 0.06, Math.sin(this.t * 2.4 + Math.PI) * 0.28 + 0.1);
    if (holds.aurum) this.orbA.update(dt, this.vfx);
    if (holds.umbra) this.orbU.update(dt, this.vfx);

    // wand glow while gathering
    let col = 0xffffff;
    const wu = w.windup;
    if (wu) col = SPELL_INFO[wu.spell].color;
    this.tipGlow.material.color.setHex(col);
    this.tipGlow.material.opacity = Math.min(1, p.raise * 0.5 + p.wind * 0.6);
    this.tipGlow.scale.setScalar(0.3 + p.wind * 0.7 + (wu?.spell === 'eclipse' ? 0.8 * Math.min(1, (now - wu.start) / 75) : 0));
    if (wu && !settings.clarity && Math.random() < dt * 40) {
      this.vfx.burst({ pos: this.tip(), color: col, count: 1, speed: 1.2, life: 0.45, size: 0.09, inward: true, radius: wu.spell === 'eclipse' ? 2.2 : 0.9 });
    }

    // tell (what the opponent sees while this wizard draws)
    if (tellsOn && w.state === 'drawing' && w.draw) {
      this.setTell(w.draw.family, w.draw.spell);
      this.tellGroup.position.y = Math.sin(this.t * 4) * 0.03;
      this.tellLine.rotation.y = Math.sin(this.t * 3) * 0.2;
    } else {
      this.setTell(null, null);
    }
  }
}

/** First-person hands, wand, bracers and held orbs; parented to the camera. */
export class PlayerRig {
  readonly group = new THREE.Group();
  readonly pose = new PoseState();
  private armR = new THREE.Group();
  private handL = new THREE.Group();
  private wand: THREE.Mesh;
  private tip = new THREE.Object3D();
  private tipGlow: THREE.Sprite;
  private rest = new THREE.Vector3(0.62, -0.55, -1.05);
  private cur = new THREE.Vector3(0.62, -0.55, -1.05);
  private orbA = new OrbVisual('aurum', 0.075);
  private orbU = new OrbVisual('umbra', 0.075);
  private bracerMats: THREE.MeshStandardMaterial[] = [];
  private t = 0;
  private sleeveR: THREE.Mesh;

  constructor(private vfx: ParticleVfx) {
    const skin = toon(0xd8d2cc);
    const sleeve = toon(0x3b4a66);
    // right hand + sleeve (the wand tip is positioned each frame; the sleeve points at it)
    this.sleeveR = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.1, 0.9, 8), sleeve);
    const handR = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), skin);
    this.wand = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.016, 0.55, 6), toon(0x2b2018));
    this.tipGlow = makeGlow(0xffffff, 0.2, 0.7);
    this.armR.add(this.sleeveR, handR, this.wand, this.tip);
    this.tip.add(this.tipGlow);
    for (let i = 0; i < 3; i++) {
      const m = new THREE.MeshStandardMaterial({ color: 0x223, emissive: 0x6aa8ff, emissiveIntensity: 1.0 });
      this.bracerMats.push(m);
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.1 + i * 0.002, 0.008, 5, 18), m);
      band.position.y = -0.1 - i * 0.14;
      band.rotation.x = Math.PI / 2;
      this.sleeveR.add(band);
    }
    // left hand holding orbs
    const sleeveL = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.1, 0.9, 8), sleeve);
    sleeveL.position.set(0, -0.45, 0.2);
    sleeveL.rotation.x = Math.PI / 2.4;
    const handL = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), skin);
    this.handL.add(sleeveL, handL, this.orbA.group, this.orbU.group);
    this.handL.position.set(-0.6, -0.55, -1.0);
    this.group.add(this.armR, this.handL);
    this.orbA.group.visible = this.orbU.group.visible = false;
  }

  /** world position of the wand tip */
  tipWorld(out = new THREE.Vector3()): THREE.Vector3 {
    return this.tip.getWorldPosition(out);
  }

  handWorld(out = new THREE.Vector3()): THREE.Vector3 {
    return this.handL.getWorldPosition(out);
  }

  /** target: camera-local tip position when drawing, else null for the rest pose */
  update(dt: number, w: Wizard, target: THREE.Vector3 | null, holds: { aurum: boolean; umbra: boolean }, aether: number, vit: number, now: number): void {
    this.t += dt;
    this.pose.step(w, dt);
    const p = this.pose.p;
    const goal = target ?? this.rest.clone().add(new THREE.Vector3(-p.raise * 0.18, p.raise * 0.45 + p.thrust * 0.1, -p.thrust * 0.6));
    if (!target) {
      goal.x += Math.sin(this.t * 1.2) * 0.012;
      goal.y += Math.sin(this.t * 1.7) * 0.012 - p.stagger * 0.25 + Math.sin(this.t * 60) * 0.01 * p.shudder;
    }
    goal.z += -p.thrust * 0.5;
    this.cur.lerp(goal, Math.min(1, dt * (target ? 28 : 9)));
    // hand sits near the tip; the wand extends forward-up from the hand
    const hand = this.cur.clone().add(new THREE.Vector3(0.05, -0.1, 0.4));
    this.armR.position.copy(hand);
    this.sleeveR.position.set(0.12, -0.5, 0.25);
    this.sleeveR.rotation.set(Math.PI / 2.6, 0, -0.35);
    const dir = this.cur.clone().sub(hand);
    const len = dir.length();
    this.wand.position.copy(dir.clone().multiplyScalar(0.5));
    this.wand.scale.set(1, Math.max(0.2, len / 0.55), 1);
    this.wand.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    this.tip.position.copy(dir);
    const wu = w.windup;
    const col = wu ? SPELL_INFO[wu.spell].color : 0xbfe0ff;
    this.tipGlow.material.color.setHex(col);
    this.tipGlow.scale.setScalar(0.16 + p.wind * 0.45 + (target ? 0.08 : 0));
    this.tipGlow.material.opacity = 0.6 + p.wind * 0.4;
    if (wu && !settings.clarity && Math.random() < dt * 45) {
      this.vfx.burst({ pos: this.tipWorld(), color: col, count: 1, speed: 0.9, life: 0.4, size: 0.06, inward: true, radius: wu.spell === 'eclipse' ? 1.8 : 0.7 });
    }

    // left hand: gathers when winding up; orbs orbit it
    this.handL.position.set(-0.6 + p.wind * 0.35, -0.55 + p.wind * 0.3 - p.stagger * 0.2, -1.0 - p.thrust * 0.3);
    this.handL.rotation.z = Math.sin(this.t * 60) * 0.03 * p.shudder;
    this.orbA.group.visible = holds.aurum;
    this.orbU.group.visible = holds.umbra;
    const r = 0.17;
    this.orbA.group.position.set(Math.cos(this.t * 2.2) * r, 0.14 + Math.sin(this.t * 3) * 0.02, Math.sin(this.t * 2.2) * r);
    this.orbU.group.position.set(Math.cos(this.t * 2.2 + Math.PI) * r, 0.14 + Math.sin(this.t * 3 + 2) * 0.02, Math.sin(this.t * 2.2 + Math.PI) * r);
    if (holds.aurum) this.orbA.update(dt, this.vfx);
    if (holds.umbra) this.orbU.update(dt, this.vfx);

    // bracer glyphs show aether; flicker when vitality is low
    const a = aether / 100;
    this.bracerMats.forEach((m, i) => {
      m.emissiveIntensity = (a > (i + 1) / 3 - 0.3 ? 1.1 : 0.15) * (vit < 30 ? 0.6 + Math.sin(this.t * 10) * 0.4 : 1);
      m.emissive.setHex(a > 0.3 ? 0x6aa8ff : 0xff6a6a);
    });
    void now;
  }
}
