import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, VignetteEffect, ChromaticAberrationEffect, NoiseEffect, BlendFunction,
} from 'postprocessing';
import { ParticleVfx } from './vfx';
import { settings } from './settings';

export const LANE_SPACING = 2.4;
export const WIZ_Z = 5.6;

const SKY_V = /* glsl */ `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const SKY_F = /* glsl */ `
varying vec3 vP; uniform float uDark;
float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }
void main(){
  float y = normalize(vP).y;
  vec3 top = vec3(0.012,0.02,0.07);
  vec3 mid = vec3(0.04,0.09,0.17);
  vec3 low = vec3(0.07,0.2,0.26);
  vec3 c = mix(low, mid, smoothstep(-0.1,0.35,y));
  c = mix(c, top, smoothstep(0.3,0.9,y));
  vec3 q = floor(normalize(vP)*180.0);
  float star = step(0.9965, h(q)) * smoothstep(0.05,0.4,y);
  c += vec3(star) * 0.9;
  gl_FragColor = vec4(c * (1.0 - uDark*0.75), 1.0);
}`;
const AURORA_F = /* glsl */ `
varying vec2 vUv; uniform float uTime; uniform vec3 uColor;
float n(vec2 p){ return sin(p.x*3.1+uTime*0.3)*0.5+sin(p.x*7.3-uTime*0.5+p.y*2.0)*0.3+sin(p.x*13.0+uTime*0.7)*0.2; }
void main(){
  float band = smoothstep(0.0,0.35,vUv.y) * (1.0 - smoothstep(0.55,1.0,vUv.y));
  float w = 0.5 + 0.5 * n(vec2(vUv.x*4.0, vUv.y));
  float streak = pow(0.5+0.5*sin(vUv.x*60.0 + n(vec2(vUv.x*3.0,0.0))*6.0), 3.0);
  float a = band * w * (0.25 + 0.75*streak) * 0.55;
  gl_FragColor = vec4(uColor * a, a);
}`;
const AURORA_V = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;

function runeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d')!;
  g.translate(512, 512);
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  g.lineCap = 'round';
  const ring = (r: number, w: number) => { g.lineWidth = w; g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke(); };
  ring(500, 6); ring(470, 2); ring(360, 3); ring(250, 2); ring(120, 4);
  g.font = '34px serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const glyphs = '△ϟ∩◇◉○●∞☽✶⌖⍟';
  for (let i = 0; i < 36; i++) {
    g.save();
    g.rotate((i / 36) * Math.PI * 2);
    g.translate(0, -418);
    g.fillText(glyphs[i % glyphs.length]!, 0, 0);
    g.restore();
  }
  for (let i = 0; i < 12; i++) {
    g.save();
    g.rotate((i / 12) * Math.PI * 2);
    g.beginPath(); g.moveTo(0, -250); g.lineTo(0, -360); g.lineWidth = 2; g.stroke();
    g.translate(0, -305);
    g.font = '26px serif';
    g.fillText(glyphs[(i * 5) % glyphs.length]!, 0, 0);
    g.restore();
  }
  g.lineWidth = 3;
  for (const n of [3, 4]) {
    g.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(a) * 240; const y = Math.sin(a) * 240;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.05, 600);
  readonly vfx = new ParticleVfx();
  readonly composer: EffectComposer;
  private bloom: BloomEffect;
  private vignette: VignetteEffect;
  private ca: ChromaticAberrationEffect;
  private grain: NoiseEffect;
  private fxPass: EffectPass;
  private rune: THREE.Mesh;
  private runeMat: THREE.MeshBasicMaterial;
  private astrolabe = new THREE.Group();
  private braziers: { flame: THREE.Sprite; light: THREE.PointLight; seed: number }[] = [];
  private crystals: THREE.Mesh[] = [];
  private arcs: THREE.InstancedMesh;
  private arcData: { r: number; a: number; y: number; s: number; sp: number }[] = [];
  private motes: THREE.Points;
  private skyMat: THREE.ShaderMaterial;
  private auroras: THREE.ShaderMaterial[] = [];
  readonly flash: THREE.PointLight;
  readonly laneGlow: THREE.Mesh[] = [];
  private runeTarget = new THREE.Color(0x4a6aa8);
  private runeCur = new THREE.Color(0x4a6aa8);
  private runePulse = 0;
  private hemi: THREE.HemisphereLight;
  private moon: THREE.DirectionalLight;
  private darkness = 0;
  private trauma = 0;
  private caPulse = 0;
  private time = 0;
  private quality = 1;
  private frameEma = 16;
  private slowFor = 0;
  private baseFov = 62;
  fovKick = 0;
  private pixelRatioBase: number;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.pixelRatioBase = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.pixelRatioBase);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene.fog = new THREE.FogExp2(0x07122a, 0.011);

    // lighting
    this.hemi = new THREE.HemisphereLight(0x7a9ce0, 0x1c2244, 1.5);
    this.moon = new THREE.DirectionalLight(0xbcd2ff, 1.2);
    this.moon.position.set(-8, 14, -6);
    this.flash = new THREE.PointLight(0xffffff, 0, 30, 1.6);
    this.flash.position.set(0, 3, 0);
    const key = new THREE.PointLight(0xa8c4ff, 40, 20, 1.6);
    key.position.set(0, 4.5, -2.5);
    const rim = new THREE.PointLight(0x7affd8, 14, 14, 1.6);
    rim.position.set(0, 3, -11.5);
    this.scene.add(this.hemi, this.moon, this.flash, key, rim);

    // sky
    this.skyMat = new THREE.ShaderMaterial({ vertexShader: SKY_V, fragmentShader: SKY_F, side: THREE.BackSide, depthWrite: false, fog: false, uniforms: { uDark: { value: 0 } } });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(320, 32, 16), this.skyMat);
    sky.renderOrder = -10;
    this.scene.add(sky);

    // aurora curtains
    for (const [x, z, rot, col] of [[-60, -140, 0.25, 0x47ffb8], [50, -150, -0.2, 0x6a7bff], [0, -190, 0, 0x30e0d0]] as const) {
      const m = new THREE.ShaderMaterial({
        vertexShader: AURORA_V, fragmentShader: AURORA_F, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
        uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(col) } },
      });
      const p = new THREE.Mesh(new THREE.PlaneGeometry(220, 70, 1, 1), m);
      p.position.set(x, 55, z);
      p.rotation.y = rot;
      this.auroras.push(m);
      this.scene.add(p);
    }

    // platform
    const stone = new THREE.MeshStandardMaterial({ color: 0x2b3453, roughness: 0.85, metalness: 0.05, flatShading: true });
    const plat = new THREE.Mesh(new THREE.CylinderGeometry(13, 14.2, 1.4, 56, 1), stone);
    plat.position.y = -0.7;
    this.scene.add(plat);
    const under = new THREE.Mesh(new THREE.ConeGeometry(14.2, 10, 20, 1, true), new THREE.MeshStandardMaterial({ color: 0x1b2038, flatShading: true, roughness: 1 }));
    under.rotation.x = Math.PI;
    under.position.y = -6.4;
    this.scene.add(under);
    const trim = new THREE.Mesh(new THREE.TorusGeometry(13.1, 0.16, 8, 80), new THREE.MeshStandardMaterial({ color: 0x6f86c8, emissive: 0x1a2a5a, roughness: 0.4 }));
    trim.rotation.x = Math.PI / 2;
    trim.position.y = 0.02;
    this.scene.add(trim);

    // rune circle
    this.runeMat = new THREE.MeshBasicMaterial({ map: runeTexture(), color: this.runeCur, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.55 });
    this.rune = new THREE.Mesh(new THREE.PlaneGeometry(25, 25), this.runeMat);
    this.rune.rotation.x = -Math.PI / 2;
    this.rune.position.y = 0.03;
    this.scene.add(this.rune);

    // lane strips (also used as danger highlights)
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1.5, 15),
        new THREE.MeshBasicMaterial({ color: 0x8aa8ff, transparent: true, opacity: 0.06, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.set((i - 1) * LANE_SPACING, 0.05, 0);
      m.renderOrder = 2;
      this.laneGlow.push(m);
      this.scene.add(m);
    }

    // broken columns
    const colMat = new THREE.MeshStandardMaterial({ color: 0x3a4466, flatShading: true, roughness: 0.9 });
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + 0.3;
      if (Math.abs(Math.cos(a)) < 0.3 || Math.abs(Math.sin(a) + 1) < 0.35) continue;
      const h = 4 + (i * 37 % 7);
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, h, 7), colMat);
      c.position.set(Math.cos(a) * 12.2, h / 2, Math.sin(a) * 12.2);
      c.rotation.z = ((i % 3) - 1) * 0.04;
      this.scene.add(c);
    }

    // observatory gate framing the opposing wizard
    const gateMat = new THREE.MeshStandardMaterial({ color: 0x4a5578, flatShading: true, roughness: 0.8 });
    const glowRune = new THREE.MeshBasicMaterial({ color: 0x7fb0ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending });
    for (const sx of [-1, 1]) {
      const pil = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.75, 7.5, 8), gateMat);
      pil.position.set(sx * 5.2, 3.75, -9.4);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.45, 1.5), gateMat);
      cap.position.set(sx * 5.2, 7.6, -9.4);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.08, 6, 0.08), glowRune);
      stripe.position.set(sx * 5.2, 3.8, -8.7);
      this.scene.add(pil, cap, stripe);
    }
    const arch = new THREE.Mesh(new THREE.TorusGeometry(5.2, 0.4, 8, 32, Math.PI), gateMat);
    arch.position.set(0, 7.7, -9.4);
    const archGlow = new THREE.Mesh(new THREE.TorusGeometry(4.6, 0.05, 6, 48, Math.PI), glowRune);
    archGlow.position.set(0, 7.7, -8.9);
    this.scene.add(arch, archGlow);

    // braziers
    const bowlMat = new THREE.MeshStandardMaterial({ color: 0x2a2f45, flatShading: true, roughness: 0.7 });
    const flameTex = new THREE.CanvasTexture((() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d')!; const gr = g.createRadialGradient(32, 40, 2, 32, 36, 30); gr.addColorStop(0, 'rgba(255,240,180,1)'); gr.addColorStop(0.4, 'rgba(255,140,40,0.8)'); gr.addColorStop(1, 'rgba(255,60,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return c; })());
    for (const [bx, bz] of [[-8, 4], [8, 4], [-8.5, -6], [8.5, -6]] as const) {
      const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.28, 1.1, 6), bowlMat);
      stand.position.set(bx, 0.55, bz);
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.3, 0.35, 8), bowlMat);
      bowl.position.set(bx, 1.25, bz);
      const flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      flame.scale.set(1.2, 1.8, 1);
      flame.position.set(bx, 1.95, bz);
      const light = new THREE.PointLight(0xff9040, 6, 11, 1.8);
      light.position.set(bx, 2, bz);
      this.braziers.push({ flame, light, seed: bx * 3 + bz });
      this.scene.add(stand, bowl, flame, light);
    }

    // floating crystals orbiting the astrolabe
    const crystalMat = new THREE.MeshStandardMaterial({ color: 0x9fd0ff, emissive: 0x3a7acc, emissiveIntensity: 1.2, flatShading: true, transparent: true, opacity: 0.9 });
    for (let i = 0; i < 9; i++) {
      const c = new THREE.Mesh(new THREE.OctahedronGeometry(0.6 + (i % 3) * 0.3, 0), crystalMat);
      c.scale.y = 1.8;
      c.userData = { a: (i / 9) * Math.PI * 2, r: 9 + (i % 3) * 3, y: 30 + (i % 4) * 2.5 };
      this.crystals.push(c);
      this.scene.add(c);
    }

    // inlaid platform rings
    for (const r of [4, 8.5, 11.5]) {
      const inlay = new THREE.Mesh(new THREE.TorusGeometry(r, 0.05, 6, 80), new THREE.MeshBasicMaterial({ color: 0x5f86d8, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending }));
      inlay.rotation.x = Math.PI / 2;
      inlay.position.y = 0.045;
      this.scene.add(inlay);
    }

    // astrolabe
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x8aa0d8, emissive: 0x2a4a8a, emissiveIntensity: 0.8, metalness: 0.6, roughness: 0.35 });
    const specs: [number, number, number, number][] = [[18, 0.35, 0.0, 5.2], [14, 0.28, 0.9, 4.6], [10.5, 0.24, 1.9, 4.0], [7, 0.2, 2.7, 3.5], [24, 0.45, 0.5, Math.PI * 1.5]];
    specs.forEach(([r, t, tilt, arc], i) => {
      const m = new THREE.Mesh(new THREE.TorusGeometry(r, t, 8, 90, arc), ringMat);
      m.rotation.set(tilt, i * 0.8, 0);
      m.userData.sp = (i % 2 ? -1 : 1) * (0.04 + i * 0.012);
      this.astrolabe.add(m);
    });
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(2.6, 1), new THREE.MeshStandardMaterial({ color: 0xcfe0ff, emissive: 0x6a8aff, emissiveIntensity: 1.4, flatShading: true }));
    this.astrolabe.add(core);
    this.astrolabe.position.set(0, 42, -30);
    this.scene.add(this.astrolabe);

    // drifting arcs
    this.arcs = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x38425f, flatShading: true, roughness: 0.9 }), 22);
    for (let i = 0; i < 22; i++) {
      this.arcData.push({ r: 22 + Math.random() * 30, a: Math.random() * Math.PI * 2, y: -4 + Math.random() * 22, s: 1 + Math.random() * 3.5, sp: (Math.random() - 0.5) * 0.03 });
    }
    this.scene.add(this.arcs);

    // dust
    const mg = new THREE.BufferGeometry();
    const mp = new Float32Array(240 * 3);
    for (let i = 0; i < 240; i++) {
      mp[i * 3] = (Math.random() - 0.5) * 30; mp[i * 3 + 1] = Math.random() * 9; mp[i * 3 + 2] = (Math.random() - 0.5) * 30;
    }
    mg.setAttribute('position', new THREE.BufferAttribute(mp, 3));
    this.motes = new THREE.Points(mg, new THREE.PointsMaterial({ color: 0x9fc0ff, size: 0.025, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.scene.add(this.motes);

    this.scene.add(this.vfx.group);

    // post FX
    this.composer = new EffectComposer(this.renderer, { multisampling: 4, frameBufferType: THREE.HalfFloatType });
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new BloomEffect({ intensity: 0.9, luminanceThreshold: 0.62, luminanceSmoothing: 0.25, mipmapBlur: true, radius: 0.7 });
    this.vignette = new VignetteEffect({ offset: 0.3, darkness: 0.55 });
    this.ca = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0, 0), radialModulation: true, modulationOffset: 0.2 });
    this.grain = new NoiseEffect({ blendFunction: BlendFunction.SOFT_LIGHT });
    this.grain.blendMode.opacity.value = 0.18;
    this.fxPass = new EffectPass(this.camera, this.bloom, this.ca, this.vignette, this.grain);
    this.composer.addPass(this.fxPass);

    this.camera.position.set(0, 1.7, WIZ_Z);
    this.scene.add(this.camera);
    this.resize();
    this.applySettings();
  }

  applySettings(): void {
    const clarity = settings.clarity;
    this.bloom.intensity = clarity ? 0.35 : 0.9 * (this.quality > 0.5 ? 1 : 0.5);
    this.grain.blendMode.opacity.value = clarity ? 0 : 0.18;
    this.vfx.setCap(clarity ? 1400 : Math.round(3600 * Math.max(0.35, this.quality)));
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(this.pixelRatioBase * this.quality);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.vfx.setScale(h * this.renderer.getPixelRatio() * 0.45);
  }

  setRune(color: number, pulse = 1): void {
    this.runeTarget.setHex(color);
    this.runePulse = Math.max(this.runePulse, pulse);
  }

  shake(amount: number): void {
    if (settings.reducedMotion) amount *= 0.2;
    if (settings.clarity) amount *= 0.4;
    this.trauma = Math.min(1, this.trauma + amount);
  }

  chroma(amount: number): void {
    if (settings.clarity || settings.reducedMotion) return;
    this.caPulse = Math.min(1, this.caPulse + amount);
  }

  setDarkness(d: number): void {
    this.darkness = d;
  }

  setVignette(lowHealth: number): void {
    this.vignette.darkness = 0.5 + lowHealth * 0.55;
  }

  /** screen-space look direction offset in radians (cursor parallax) */
  parallax = { x: 0, y: 0 };

  update(dt: number): void {
    this.time += dt;
    const t = this.time;
    this.skyMat.uniforms.uDark!.value += (this.darkness - this.skyMat.uniforms.uDark!.value) * Math.min(1, dt * 3);
    for (const a of this.auroras) a.uniforms.uTime!.value = t;
    this.astrolabe.children.forEach((c) => {
      if (c.userData.sp) c.rotation.z += c.userData.sp * dt;
    });
    const d = new THREE.Object3D();
    this.arcData.forEach((a, i) => {
      a.a += a.sp * dt;
      d.position.set(Math.cos(a.a) * a.r, a.y + Math.sin(t * 0.3 + i) * 0.5, Math.sin(a.a) * a.r - 8);
      d.scale.set(a.s * 2.2, a.s * 0.45, a.s * 0.9);
      d.rotation.set(0, -a.a, Math.sin(t * 0.2 + i) * 0.1);
      d.updateMatrix();
      this.arcs.setMatrixAt(i, d.matrix);
    });
    this.arcs.instanceMatrix.needsUpdate = true;
    for (const b of this.braziers) {
      const f = 0.8 + Math.sin(t * 11 + b.seed) * 0.12 + Math.sin(t * 23 + b.seed * 2) * 0.08;
      b.flame.scale.set(1.1 * f, 1.8 * f, 1);
      b.light.intensity = 6 * f;
    }
    for (const c of this.crystals) {
      const u = c.userData as { a: number; r: number; y: number };
      const a = u.a + t * 0.08;
      c.position.set(Math.cos(a) * u.r, u.y + Math.sin(t * 0.7 + u.a * 3) * 0.8, -30 + Math.sin(a) * u.r);
      c.rotation.y += dt * 0.6;
    }
    this.motes.rotation.y += dt * 0.01;
    this.motes.position.y = Math.sin(t * 0.2) * 0.3;

    this.runePulse = Math.max(0, this.runePulse - dt * 1.4);
    this.runeCur.lerp(this.runeTarget, Math.min(1, dt * 6));
    this.runeMat.color.copy(this.runeCur).multiplyScalar(0.6 + this.runePulse * 1.6);
    this.rune.rotation.z += dt * 0.02;
    this.flash.intensity = Math.max(0, this.flash.intensity - dt * 60);
    this.hemi.intensity = 1.5 * (1 - this.darkness * 0.6);
    this.moon.intensity = 1.2 * (1 - this.darkness * 0.7);

    this.trauma = Math.max(0, this.trauma - dt * 1.3);
    this.caPulse = Math.max(0, this.caPulse - dt * 3);
    this.ca.offset.set(0.0022 * this.caPulse, 0.0016 * this.caPulse);
    this.fovKick *= Math.max(0, 1 - dt * 5);
    this.vfx.update(dt);
  }

  /** place the camera at a lane x with shake + parallax applied */
  placeCamera(x: number, z: number, lookZ: number, dt: number): void {
    const sh = this.trauma * this.trauma;
    const nx = (Math.sin(this.time * 41) + Math.sin(this.time * 23.7)) * 0.5;
    const ny = (Math.sin(this.time * 37 + 1.7) + Math.sin(this.time * 19.1)) * 0.5;
    this.camera.position.set(x + nx * sh * 0.22, 1.72 + ny * sh * 0.16 + Math.sin(this.time * 1.4) * 0.012, z);
    this.camera.lookAt(x * 0.15 + this.parallax.x * 1.4, 1.5 + this.parallax.y * 0.8, lookZ);
    this.camera.rotateZ(nx * sh * 0.03);
    const fov = this.baseFov + this.fovKick;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    void dt;
  }

  /** over-the-shoulder camera: explicit position and look target, with shake applied */
  placeThird(pos: THREE.Vector3, target: THREE.Vector3): void {
    const sh = this.trauma * this.trauma;
    const nx = (Math.sin(this.time * 41) + Math.sin(this.time * 23.7)) * 0.5;
    const ny = (Math.sin(this.time * 37 + 1.7) + Math.sin(this.time * 19.1)) * 0.5;
    this.camera.position.set(pos.x + nx * sh * 0.25 + this.parallax.x * 0.6, pos.y + ny * sh * 0.18 + Math.sin(this.time * 1.2) * 0.02, pos.z);
    this.camera.lookAt(target.x + this.parallax.x * 1.2, target.y + this.parallax.y * 0.8, target.z);
    this.camera.rotateZ(nx * sh * 0.03);
    const fov = this.baseFov + this.fovKick;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** adaptive quality: lower resolution/bloom/particles when frames get slow */
  adapt(frameMs: number): void {
    this.frameEma = this.frameEma * 0.95 + Math.min(100, frameMs) * 0.05;
    if (this.frameEma > 24 && this.quality > 0.5) {
      this.slowFor += frameMs;
      if (this.slowFor > 1500) {
        this.quality = Math.max(0.5, this.quality - 0.15);
        this.slowFor = 0;
        this.resize();
        this.applySettings();
      }
    } else {
      this.slowFor = 0;
    }
  }

  render(): void {
    this.composer.render();
  }

}
