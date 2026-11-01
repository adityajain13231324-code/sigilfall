import * as THREE from 'three';
import {
  candidateSpells, PlayerId, SimEvent, SpellId, Wizard, B, T, TICK_RATE, DuelState,
} from '@sigilfall/sim';
import {
  recognize, RecognitionResult, Shape, spellToShape, canonical, packStroke, predictPrefix, Template, Pt, pathLength, bounds,
} from '@sigilfall/recognizer';
import { World, WIZ_Z } from './world';
import { SigilPlane } from './trail';
import { EnemyRig, PlayerRig, APPRENTICE } from './rigs';
import { Layout, SpellFx } from './spellfx';
import { Hud } from './hud';
import { Input } from './input';
import type { AudioManager, LoopHandle } from './audio';
import type { Driver } from './driver';
import { settings } from './settings';
import { SPELL_INFO } from './theme';

const SCHOOL: Record<SpellId, string> = { cinder: 'fire', storm: 'storm', ward: 'ice', mirror: 'mirror', gravewell: 'grav', aurum: 'orb', umbra: 'orb', eclipse: 'eclipse', dart: 'storm', riptide: 'ice', heal: 'orb', aegis: 'ice', crescent: 'mirror', starfall: 'fire', fangs: 'fire' };
const WHY: Record<string, string> = {
  tooShort: 'Draw a longer stroke', tooSmall: 'Draw bigger', tooSlow: 'Too slow', line: 'Not a sigil', scribble: 'Too shaky', noMatch: 'No sigil recognised',
  smudged: 'Smudged sigil', notReady: 'Not ready',
};

export interface CastRecord {
  spell: SpellId | null;
  expected?: Shape;
  result: RecognitionResult;
  ms: number;
  stroke: Pt[];
}

export interface FreeMode {
  stroke(s: Pt[], ms: number, cancelled: boolean): void;
  blink?(dir: -1 | 1): void;
}

export interface DuelCallbacks {
  onRoundOver?: (winner: PlayerId | null, reason: string) => void;
  onPause?: () => void;
  onCast?: (c: CastRecord) => void;
}

/** Binds a Driver (local sim or network) to the 3D scene, HUD, input and audio. */
export class DuelScene {
  readonly world: World;
  readonly plane: SigilPlane;
  readonly player: PlayerRig;
  readonly enemy: EnemyRig;
  /** the player's own wizard, only visible in third person (killcam) */
  readonly avatar: EnemyRig;
  readonly fx: SpellFx;
  readonly hud: Hud;
  readonly input: Input;
  driver: Driver | null = null;
  layout = new Layout(0);
  cb: DuelCallbacks = {};
  custom: Template[] = [];
  /** when set, casts are limited to these spells (lessons / drills) */
  onlyShapes: Shape[] | null = null;
  quickAllowed = true;
  /** sim-less drawing (lessons, drills, tuning): strokes go to this handler instead of the duel */
  free: FreeMode | null = null;
  onEvent: ((e: SimEvent) => void) | null = null;
  tellsOn = true;

  private stroke: Pt[] = [];
  private drawAt = 0;
  private told1 = false;
  private told2 = false;
  private lastPredict = 0;
  private trailLoop: LoopHandle | null = null;
  private projLoops = new Map<number, { h: LoopHandle; kind: string }>();
  private channelLoop: LoopHandle | null = null;
  private hitStopUntil = 0;
  private slowUntil = 0;
  private killcam: { t: number; target: PlayerId; angle: number } | null = null;
  private overFired = false;
  private heartbeat = 0;
  private tideSeen = -1;
  private time = 0;
  private lookX = 0;
  private lookY = 0;
  private active = false;
  private pendingDraw = false;
  private lastRejectAt = 0;
  private fizzles = 0;
  private darkness = 0;
  private wasChanneling = false;
  private tmp = new THREE.Vector3();
  private lastHurtLow = 0;

  constructor(canvas: HTMLCanvasElement, hudRoot: HTMLElement, captions: HTMLElement, readonly audio: AudioManager) {
    this.world = new World(canvas);
    this.plane = new SigilPlane(this.world.camera, this.world.vfx);
    this.player = new PlayerRig(this.world.vfx);
    this.world.camera.add(this.player.group);
    this.enemy = new EnemyRig(this.world.vfx);
    this.world.scene.add(this.enemy.group);
    this.avatar = new EnemyRig(this.world.vfx, APPRENTICE);
    this.avatar.group.visible = false;
    this.world.scene.add(this.avatar.group);
    this.fx = new SpellFx(this.world, this.world.vfx, this.layout);
    this.fx.tipOf = (p) => (this.driver && p === this.me ? this.myTip(new THREE.Vector3()) : this.enemy.tip(new THREE.Vector3()));
    this.hud = new Hud(hudRoot, captions);
    this.input = new Input(canvas.parentElement!, this.plane, {
      onDrawStart: () => this.drawStart(),
      onDrawPoint: (p, t) => this.drawPoint(p, t),
      onDrawEnd: (s, c) => this.drawEnd(s, c),
      onBlink: (d) => this.blink(d),
      onOrb: (w) => this.releaseOrb(w),
      onQuick: (sp) => this.quick(sp),
      onPause: () => this.cb.onPause?.(),
      onLook: (x, y) => { this.lookX = x; this.lookY = y; },
    });
    this.hud.bindActions({ orb: (w) => this.releaseOrb(w), blink: (d) => this.blink(d) });
    this.audio.onCaption = (t) => this.hud.note(t, 'sub');
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.player.group.position.z = 0;
    this.world.camera.position.set(0, 1.7, WIZ_Z);
  }

  resize(): void {
    this.world.resize();
    this.plane.layout();
  }

  // ---- lifecycle -----------------------------------------------------------------------------

  start(driver: Driver, opts: { enemyName?: string; hud?: boolean } = {}): void {
    this.driver = driver;
    this.layout = new Layout(driver.seat);
    this.fx.setLayout(this.layout);
    this.fx.reset();
    this.world.vfx.clear();
    this.overFired = false;
    this.killcam = null;
    this.phaseSeen = 1;
    this.active = true;
    this.input.enabled = true;
    this.hud.show(opts.hud !== false);
    this.hud.setEnemyName(opts.enemyName ?? 'Magister Corvane Vael');
    this.world.camera.position.set(0, 1.7, WIZ_Z);
    this.enemy.group.visible = true;
    this.clearLoops();
    this.audio.music('duel');
    this.plane.setColor(0x9fd0ff);
    if (driver.match) this.hud.setPips(driver.match.wins, driver.seat, driver.match.round);
    this.world.setRune(0x4a6aa8, 0.6);
  }

  newRound(): void {
    if (!this.driver) return;
    this.fx.reset();
    this.world.vfx.clear();
    this.overFired = false;
    this.killcam = null;
    this.phaseSeen = 1;
    this.clearLoops();
    this.input.enabled = true;
    if (this.driver.match) this.hud.setPips(this.driver.match.wins, this.driver.seat, this.driver.match.round);
    this.hud.callout(`ROUND ${this.driver.match?.round ?? 1}`, '#cfe0ff');
    this.audio.play('roundStart');
  }

  stop(): void {
    this.active = false;
    this.input.enabled = false;
    this.input.abort();
    this.clearLoops();
    this.driver?.dispose();
    this.driver = null;
    this.hud.show(false);
    this.fx.reset();
    this.world.vfx.clear();
    this.plane.cancel();
    this.plane.showGhost(null);
    this.world.setDarkness(0);
    this.world.fovKick = 0;
  }

  private clearLoops(): void {
    this.trailLoop?.stop();
    this.trailLoop = null;
    this.channelLoop?.stop();
    this.channelLoop = null;
    for (const l of this.projLoops.values()) l.h.stop();
    this.projLoops.clear();
  }

  private get third(): boolean {
    return settings.view === 'third' && !!this.driver;
  }

  /** world position of my wand tip: the avatar's in third person, the first-person wand otherwise */
  private myTip(out: THREE.Vector3): THREE.Vector3 {
    return this.third ? this.avatar.tip(out) : this.player.tipWorld(out);
  }

  get me(): PlayerId {
    return this.driver?.seat ?? 0;
  }
  get foe(): PlayerId {
    return this.me === 0 ? 1 : 0;
  }
  get myWizard(): Wizard | null {
    return this.driver ? this.driver.state.w[this.me] : null;
  }

  // ---- input handlers ------------------------------------------------------------------------

  private canSend(): boolean {
    return !!this.driver && !this.driver.state.over && this.active;
  }

  private drawStart(): void {
    if (this.free) {
      this.audio.unlock();
      this.stroke = [];
      this.drawAt = performance.now();
      this.plane.begin();
      this.plane.setColor(0x9fd0ff);
      this.audio.play('drawStart');
      this.trailLoop?.stop();
      this.trailLoop = this.audio.loop('trail', { gain: 0.05 });
      return;
    }
    if (!this.canSend()) return;
    this.audio.unlock();
    const w = this.myWizard!;
    this.stroke = [];
    this.drawAt = performance.now();
    this.told1 = this.told2 = false;
    this.pendingDraw = false;
    this.plane.begin();
    this.plane.setColor(0x9fd0ff);
    this.audio.play('drawStart');
    this.trailLoop?.stop();
    this.trailLoop = this.audio.loop('trail', { gain: 0.05 });
    this.world.setRune(0x7aa4ff, 0.5);
    if (w.state === 'idle') this.driver!.send({ t: 'drawStart' });
    else this.pendingDraw = true;
  }

  private drawPoint(p: Pt, t: number): void {
    this.stroke.push(p);
    this.plane.addPoint(p, t);
    this.plane.setTimer(1 - t / (B.drawWindow * 1000));
    const len = pathLength(this.stroke) / 1000;
    this.trailLoop?.set({ rate: 0.8 + Math.min(1.8, len * 0.9), gain: 0.04 + Math.min(0.06, len * 0.03) });
    const now = performance.now();
    if (this.pendingDraw && this.driver && this.driver.state.w[this.me].state === 'idle') {
      this.driver.send({ t: 'drawStart' });
      this.pendingDraw = false;
    }
    if (this.tellsOn && now - this.lastPredict > 90 && this.stroke.length > 8 && !(this.told1 && this.told2)) {
      this.lastPredict = now;
      const allowed = this.allowedShapes();
      const pr = predictPrefix(this.stroke, allowed);
      if (pr) {
        if (pr.frac >= 0.4 && !this.told1) {
          this.told1 = true;
          this.driver?.send({ t: 'tell', stage: 1, spell: pr.spell });
          this.plane.setColor(SPELL_INFO[pr.spell].color);
        }
        if (pr.frac >= 0.7 && !this.told2) {
          this.told2 = true;
          this.driver?.send({ t: 'tell', stage: 2, spell: pr.spell });
        }
      }
    }
  }

  private allowedShapes(): Shape[] {
    if (this.onlyShapes) return this.onlyShapes;
    const s = this.driver ? candidateSpells(this.driver.state, this.me) : [];
    return [...new Set(s.map(spellToShape))];
  }

  private drawEnd(stroke: Pt[], cancelled: boolean): void {
    this.trailLoop?.stop();
    this.trailLoop = null;
    if (this.free) {
      if (stroke.length) this.free.stroke(stroke, performance.now() - this.drawAt, cancelled);
      else this.plane.cancel();
      return;
    }
    const d = this.driver;
    if (!d || !this.active) {
      this.plane.cancel();
      return;
    }
    if (stroke.length === 0) {
      this.plane.cancel();
      return;
    }
    const ms = performance.now() - this.drawAt;
    const w = d.state.w[this.me];
    if (cancelled) {
      // feint: lift the wand outside the plane
      this.plane.unravel();
      if (w.state === 'drawing') {
        d.send({ t: 'drawCancel' });
        this.hud.note('Feint', 'feint');
      } else if (this.pendingDraw) {
        this.pendingDraw = false;
      }
      return;
    }
    const result = recognize(stroke, { allowed: this.allowedShapes(), custom: this.custom, strictness: settings.strictness });
    this.cb.onCast?.({ spell: result.spell, result, ms, stroke });
    if (!result.spell) {
      this.plane.fizzle();
      this.audio.play('fizzle');
      this.hud.caption('Fizzle', null, WHY[result.reason ?? 'noMatch']);
      this.fizzles++;
      if (this.fizzles >= 2 && !this.onlyShapes) this.hud.note('Tip: ghost strokes are in the Practice Sanctum', 'hint');
      if (w.state === 'drawing' || this.pendingDraw) {
        d.send({ t: 'cast', spell: null, tier: 'rough' });
        this.pendingDraw = false;
      }
      return;
    }
    this.fizzles = 0;
    if (this.onlyShapes) {
      // lesson / drill mode: no sim involvement for the cast itself
      this.showRecognised(result, stroke);
      this.cb.onPause && void 0;
      return;
    }
    // the sim decides whether it is castable; show feedback optimistically (client prediction)
    this.showRecognised(result, stroke);
    if (w.state === 'idle') d.send({ t: 'drawStart' });
    if (d.sendStroke) {
      // online: the server runs the recognizer on the raw stroke and decides
      d.sendStroke(packStroke(stroke));
      d.send({ t: 'cast', spell: result.spell, tier: result.tier ?? 'rough' });
    } else {
      d.send({ t: 'cast', spell: result.spell, tier: result.tier ?? 'rough' });
    }
    this.pendingDraw = false;
  }

  /** snap the trail to the clean symbol and announce the spell + quality tier */
  showRecognised(result: RecognitionResult, stroke: Pt[]): void {
    const spell = result.spell!;
    const info = SPELL_INFO[spell];
    const b = bounds(stroke);
    const size = Math.max(b.w, b.h, 120);
    const cx = b.minX + b.w / 2;
    const cy = b.minY + b.h / 2;
    const canon = canonical(result.shape!, result.winding === 'ccw' ? 'ccw' : 'cw').map((p) => ({ x: cx + (p.x - 0.5) * size, y: cy + (p.y - 0.5) * size }));
    this.plane.setColor(info.color);
    this.plane.snap(canon);
    this.world.setRune(info.color, 1);
    this.audio.play('recog_' + spell);
    this.audio.play('tier_' + (result.tier ?? 'rough'));
    this.hud.caption(spell, result.tier);
    if (result.tier === 'perfect') this.world.vfx.ring(this.plane.localToWorld({ x: cx, y: cy }), 0xffd76a, 0.2, 1.0, 0.5, 'z');
  }

  private blink(visualDir: -1 | 1): void {
    if (this.free) {
      this.free.blink?.(visualDir);
      return;
    }
    if (!this.canSend()) return;
    this.audio.unlock();
    this.driver!.send({ t: 'blink', dir: (visualDir * (this.me === 0 ? 1 : -1)) as -1 | 1 });
  }

  private releaseOrb(which: 'aurum' | 'umbra'): void {
    if (!this.canSend()) return;
    this.audio.unlock();
    this.driver!.send({ t: 'orb', which });
  }

  private quick(spell: SpellId): void {
    if (!this.canSend() || !(settings.quickCast || this.quickAllowed === false)) return;
    this.audio.unlock();
    this.driver!.send({ t: 'cast', spell, tier: 'rough', quick: true });
    this.hud.caption(spell, 'rough', 'quick-cast');
  }

  // ---- positions -----------------------------------------------------------------------------

  wizX(p: PlayerId, w: Wizard, viewTick: number): number {
    const lay = this.layout;
    if (w.state === 'blinking') {
      const total = Math.max(1, Math.ceil(B.blink.travel * TICK_RATE));
      const prog = THREE.MathUtils.clamp(1 - (w.stateUntil - viewTick) / total, 0, 1);
      return lay.laneX(w.blinkFrom) + (lay.laneX(w.blinkTo) - lay.laneX(w.blinkFrom)) * prog;
    }
    return lay.laneX(w.lane);
  }

  /** a point on a wizard's body in world space (for hit effects) */
  bodyPos(p: PlayerId, lane: number, y = 1.5): THREE.Vector3 {
    return new THREE.Vector3(this.layout.laneX(lane), y, this.layout.zOf(p) + (p === this.me ? 0 : 0.9));
  }

  // ---- events --------------------------------------------------------------------------------

  private hitStop(ms: number): void {
    this.hitStopUntil = Math.max(this.hitStopUntil, performance.now() + (settings.reducedMotion ? 0 : ms));
  }
  private slowmo(ms: number): void {
    if (settings.reducedMotion) return;
    this.slowUntil = Math.max(this.slowUntil, performance.now() + ms);
  }

  private handle(e: SimEvent, s: DuelState): void {
    this.onEvent?.(e);
    const me = this.me;
    const world = this.world;
    const vfx = world.vfx;
    const a = this.audio;
    const pan = (lane: number) => (this.layout.laneX(lane) / 5) * 0.6;
    switch (e.type) {
      case 'cast': {
        const info = SPELL_INFO[e.spell];
        a.play('windup_' + SCHOOL[e.spell]);
        world.setRune(info.color, 0.8);
        if (e.p !== me) this.hud.note(`${s.w[e.p].draw ? '' : ''}${info.short}…`, 'foe');
        break;
      }
      case 'fizzle':
        if (e.p === me && !this.input.isDrawing) this.plane.fizzle();
        break;
      case 'misfire': {
        a.play('fizzle', { priority: 2 });
        a.play('fatigueCrack');
        const tip = e.p === me ? this.myTip(new THREE.Vector3()) : this.enemy.tip(new THREE.Vector3());
        vfx.burst({ pos: tip, color: 0xff5a3a, count: 50, speed: 3.5, life: 0.6, size: 0.14, gravity: 2 });
        vfx.ring(tip, 0xff5a3a, 0.1, 1.2, 0.4, 'z');
        world.shake(e.p === me ? 0.35 : 0.1);
        if (e.p === me) {
          if (!this.input.isDrawing) this.plane.fizzle();
          this.hud.callout('MISFIRE', '#ff8a6a');
          this.hud.note('Spamming the same sigil is unstable', 'warn');
        } else {
          this.hud.note("Corvane's spell misfires!", 'good');
        }
        break;
      }
      case 'feint':
        if (e.p !== me) this.hud.note('Feint!', 'foe');
        break;
      case 'reject':
        if (e.p === me) {
          const now = performance.now();
          if (now - this.lastRejectAt > 250) {
            this.lastRejectAt = now;
            if (!this.input.isDrawing) this.plane.unravel();
            a.play('fizzle');
            const msg: Record<string, string> = { cooldown: 'Not ready', aether: 'Not enough Aether', orbs: 'Need both orbs', held: 'Orb already held', noOrb: 'No orb held', blink: 'No room to Blink', busy: '', late: 'Too slow' };
            if (msg[e.reason]) this.hud.note(msg[e.reason]!, 'warn');
          }
        }
        break;
      case 'release': {
        const info = SPELL_INFO[e.spell];
        a.play('release', { pan: 0 });
        world.setRune(info.color, 1.2);
        const big = e.spell === 'eclipse' ? 1 : 0.25;
        if (e.p === me) {
          this.player.pose.thrust(1);
          this.avatar.pose.thrust(1);
          world.shake(big * 0.5 + 0.08);
          world.fovKick = e.spell === 'eclipse' ? 10 : 2.5;
        } else {
          this.enemy.pose.thrust(1);
          world.shake(big * 0.35);
        }
        const tip = e.p === me ? this.myTip(this.tmp) : this.enemy.tip(this.tmp);
        {
          const bx = this.layout.laneX(s.w[e.p].lane);
          const bz = this.layout.zOf(e.p);
          vfx.ring(new THREE.Vector3(bx, 0.1, bz), info.color, 0.5, 4.2, 0.6, 'y');
          vfx.burst({ pos: new THREE.Vector3(bx, 1.4, bz), color: info.color, count: 40, speed: 3.5, life: 0.6, size: 0.16 });
          vfx.ring(tip.clone(), info.color, 0.2, 1.8, 0.35, 'z');
          world.fovKick = Math.max(world.fovKick, e.p === me ? 4 : 2);
        }
        vfx.burst({ pos: tip.clone(), color: info.color, count: e.spell === 'eclipse' ? 80 : 24, speed: 3, life: 0.5, size: 0.14 });
        if (e.spell === 'eclipse') {
          a.play('eclipseLaunch', { priority: 2 });
          a.duck(0.2, 1500);
          this.slowmo(700);
          world.flash.color.setHex(0xffb020);
          world.flash.intensity = 40;
        }
        if (e.spell === 'ward') a.play('ward');
        if (e.spell === 'heal') {
          a.play('heal');
          vfx.burst({ pos: this.bodyPos(e.p, s.w[e.p].lane, 0.4), color: 0x7dffb0, count: 40, speed: 2, life: 1, size: 0.14, gravity: -2 });
        }
        if (e.spell === 'mirror') a.play('mirrorOn');
        if (e.spell === 'gravewell') {
          a.play('gravInhale');
          this.hud.flash('rgba(120,60,255,0.5)', 0.35);
        }
        if (e.spell === 'aurum' || e.spell === 'umbra') a.play('orbCreate');
        break;
      }
      case 'projectile':
        break;
      case 'stormMark':
        a.play('stormMark', { pan: pan(e.lane) });
        break;
      case 'stormStrike': {
        this.fx.strikeBolt(e.lane, e.p === 0 ? 1 : 0, e.meteor ? 0xffa040 : undefined);
        world.flash.color.setHex(e.meteor ? 0xffb060 : 0xcff6ff);
        world.flash.intensity = 60;
        world.flash.position.set(this.layout.laneX(e.lane), 6, this.layout.zOf(e.p === 0 ? 1 : 0));
        a.play(e.meteor ? 'impact_meteor' : 'impact_storm', { priority: 2 });
        world.shake(e.hit ? 0.45 : 0.18);
        const target: PlayerId = e.p === 0 ? 1 : 0;
        if (e.meteor) vfx.ring(new THREE.Vector3(this.layout.laneX(e.lane), 0.1, this.layout.zOf(target)), 0xffa040, 0.4, 3.2, 0.6, 'y');
        vfx.burst({ pos: this.bodyPos(target, e.lane, 0.3), color: e.meteor ? 0xffa040 : 0xaff6ff, count: 50, speed: 5, life: 0.5, size: 0.14, gravity: 3 });
        if (!e.hit && target === me) {
          this.hud.note('Dodged', 'good');
        }
        break;
      }
      case 'ward':
        world.setRune(0x9fd8ff, 1);
        break;
      case 'wardAbsorb': {
        const c = this.fx.wardCenter(e.p);
        a.play('wardAbsorb');
        if (e.crit) a.play('wardCrack');
        vfx.burst({ pos: new THREE.Vector3((Math.random() - 0.5) * 6, 1.6, c.z), color: 0xcfeeff, count: 20, speed: 3, life: 0.5, size: 0.12 });
        world.shake(0.1);
        break;
      }
      case 'wardBreak': {
        const c = this.fx.wardCenter(e.p);
        a.play('wardShatter', { priority: 2 });
        for (let i = 0; i < 4; i++) vfx.burst({ pos: new THREE.Vector3((i - 1.5) * 2, 1.5, c.z), color: 0xbfe6ff, count: 30, speed: 5, life: 1, size: 0.16, gravity: 6 });
        world.shake(0.3);
        this.hitStop(60);
        break;
      }
      case 'wardAnnihilated':
        this.fx.wardCenter(e.p);
        vfx.burst({ pos: this.fx.wardCenter(e.p), color: 0xffb020, count: 80, speed: 6, life: 0.9, size: 0.2 });
        a.play('wardShatter');
        break;
      case 'mirror':
        break;
      case 'reflect': {
        const c = this.fx.mirrorCenter(e.p, s.w[e.p].lane);
        vfx.burst({ pos: c, color: 0xffffff, count: 70, speed: 6, life: 0.5, size: 0.18 });
        vfx.ring(c, 0xdfe8f5, 0.4, 3, 0.45, 'z');
        a.play('mirrorReflect', { priority: 2 });
        world.flash.color.setHex(0xe6f0ff);
        world.flash.intensity = 25;
        world.flash.position.copy(c);
        this.hitStop(70);
        this.hud.callout(e.prism ? 'PRISM RETURN!' : 'REFLECTED!', '#e6f0ff');
        if (e.p === me) world.chroma(0.4);
        break;
      }
      case 'exhausted':
        a.play('mirrorExhaust');
        if (e.p === me) this.hud.note('Exhausted!', 'warn');
        else this.hud.note('Mirrorveil caught nothing', 'good');
        break;
      case 'gravewell': {
        break;
      }
      case 'collapse': {
        const pos = new THREE.Vector3(this.layout.laneX(e.lane), 1.5, 0);
        vfx.ring(pos, 0x9b5cff, 3, 0.2, 0.5, 'z');
        vfx.burst({ pos, color: 0x9b5cff, count: 60, speed: 5, life: 0.7, size: 0.16, inward: true, radius: 2.5 });
        a.play('gravCollapse', { priority: 2 });
        world.shake(e.kind === 'eclipse' ? 0.8 : 0.25);
        if (e.kind === 'eclipse') {
          this.hud.callout('COLLAPSED!', '#c8a4ff');
          this.hitStop(120);
          this.slowmo(600);
        }
        break;
      }
      case 'orbCreated':
        break;
      case 'orbPop': {
        const pos = e.p === me ? this.player.handWorld(new THREE.Vector3()) : this.enemy.hand(new THREE.Vector3());
        vfx.burst({ pos, color: e.which === 'aurum' ? 0xffcf4a : 0xa36bff, count: 40, speed: 3, life: 0.6, size: 0.12 });
        if (e.reason !== 'fusion') a.play('orbPop');
        if (e.reason === 'gravewell' && e.p === me) this.hud.note('Your orbs were popped', 'warn');
        break;
      }
      case 'eclipseStart':
        a.play('windup_eclipse', { priority: 2 });
        a.duck(0.25, 3000);
        if (e.p !== me) this.hud.note('ECLIPSE CHANNEL — interrupt it!', 'warn');
        break;
      case 'eclipseInterrupt':
        this.hud.callout('INTERRUPTED!', '#ffb86f');
        a.play('poiseBreak');
        world.shake(0.5);
        break;
      case 'blink': {
        const pos = this.bodyPos(e.p, e.from, 1.1);
        vfx.burst({ pos, color: 0xbfd8ff, count: 24, speed: 2, life: 0.4, size: 0.12 });
        a.play('blink', { pan: pan(e.from) });
        break;
      }
      case 'dodge':
        if (e.p === me) this.hud.note('Dodged', 'good');
        break;
      case 'hit': {
        if (e.kind === 'burn') {
          if (e.p === me) a.play('hit');
          vfx.burst({ pos: this.bodyPos(e.p, e.lane, e.p === me ? 1.9 : 1.6), color: 0xff7a2a, count: 4, speed: 1, life: 0.5, size: 0.1, gravity: -1 });
          break;
        }
        const pos = this.bodyPos(e.p, e.lane, 1.6);
        const kindColor: Record<string, number> = { dart: 0xaaf6ff, riptide: 0x3fd0c0, crescent: 0xf2e6a0, fang: 0xff5a6a, meteor: 0xffa040, cinder: 0xff7a2a, storm: 0xaff6ff, blast: 0xffcf4a, lance: 0xa36bff, shard: 0xbfe6ff, eclipse: 0xffb020, gravewell: 0x9b5cff, wellspring: 0x9fd8ff };
        const col = kindColor[e.kind] ?? 0xffffff;
        const big = Math.min(1, e.dmg / 40);
        vfx.burst({ pos, color: col, count: 30 + Math.round(big * 80), speed: 3 + big * 5, life: 0.7, size: 0.16, gravity: 2 });
        this.impactFx(e.kind, pos, e.lane, e.p, big);
        vfx.ring(pos, col, 0.3, 1.6 + big * 2, 0.45, 'z');
        a.play(e.kind === 'storm' ? 'hit' : 'impact_' + (e.kind === 'wellspring' || e.kind === 'gravewell' ? 'lance' : e.kind), { priority: 2 });
        this.hitStop(40 + big * 60);
        world.shake(0.15 + big * 0.7);
        world.chroma(0.3 + big * 0.7);
        this.hud.floatText(String(Math.round(e.dmg)), pos.clone().add(new THREE.Vector3(0, 0.5, 0)), world.camera, e.p === me ? '#ff8a8a' : '#fff4c8');
        if (e.p === me) {
          a.play('damage');
          this.hud.hurt(e.dmg);
          this.player.pose.flinch(1);
          this.avatar.pose.flinch(1);
        } else {
          this.enemy.pose.flinch(1);
        }
        world.setRune(col, 0.8);
        if (e.kind === 'eclipse') {
          a.play('impact_eclipse', { priority: 2 });
          a.play('eclipseAfter');
          a.duck(0.15, 2500);
          this.slowmo(900);
          this.hitStop(160);
          world.flash.color.setHex(0xffb020);
          world.flash.intensity = 120;
          world.flash.position.set(pos.x, 3, pos.z);
          vfx.ring(new THREE.Vector3(pos.x, 0.1, pos.z), 0xffb020, 0.5, 9, 1.1, 'y');
          this.hud.flash('rgba(255,190,60,0.8)', 0.6);
        }
        break;
      }
      case 'shove':
        this.hud.callout(e.p === me ? 'SHOVED!' : 'KNOCKBACK!', '#ffcf4a');
        break;
      case 'drawCancelled':
        if (e.p === me) {
          this.plane.unravel();
          this.input.abort();
          this.hud.note('Draw cancelled', 'warn');
        }
        break;
      case 'break':
        a.play('poiseBreak', { priority: 2 });
        this.hud.callout(e.p === me ? 'POISE BROKEN!' : 'BREAK!', '#ff9a7a');
        world.shake(0.5);
        this.hitStop(100);
        break;
      case 'stagger':
        a.play('stagger');
        break;
      case 'interrupt':
        break;
      case 'combo':
        if (e.name !== 'ECLIPSE' || true) this.hud.callout(e.name + '!', e.name === 'ECLIPSE' ? '#ffb020' : e.name === 'THUNDERBURN' ? '#8ff6ff' : e.name === 'SHATTER' ? '#bfeaff' : '#cfe0ff');
        if (e.name === 'SHATTER') a.play('shatter', { priority: 2 });
        if (e.name === 'PERFECT PARRY') a.play('parry', { priority: 2 });
        if (e.name === 'COUNTER HIT') a.play('counterHit', { priority: 2 });
        break;
      case 'heal': {
        const pos = this.bodyPos(e.p, s.w[e.p].lane, 1.4);
        vfx.ring(pos, 0x7dffb0, 0.3, 1.6, 0.6, 'y');
        this.hud.floatText('+' + Math.round(e.amount), pos.clone().add(new THREE.Vector3(0, 0.6, 0)), world.camera, '#7dffb0');
        break;
      }
      case 'aegis': {
        a.play('aegis');
        vfx.ring(this.bodyPos(e.p, s.w[e.p].lane, 0.2), 0xffe08a, 0.4, 3, 0.7, 'y');
        if (e.p === me) this.hud.note('Aegis: −40% damage', 'good');
        break;
      }
      case 'hazardWarn':
        a.play('riftWarn');
        this.hud.note('The Hollow Rift opens in the ' + ['left', 'center', 'right'][this.me === 0 ? e.lane : 2 - e.lane] + ' lane — move!', 'warn');
        break;
      case 'hazard':
        a.play('riftOpen', { priority: 2 });
        world.shake(0.25);
        break;
      case 'crystalSpawn':
        a.play('crystalSpawn');
        vfx.ring(new THREE.Vector3(this.layout.laneX(e.lane), 0.1, 0), 0x4dffc8, 0.3, 3, 0.7, 'y');
        this.hud.note('An Aether crystal appeared — step onto it', 'good');
        break;
      case 'crystal': {
        a.play('crystal', { priority: 2 });
        const cp = this.fx.crystalPos() ?? this.bodyPos(e.p, s.w[e.p].lane, 1.5);
        vfx.burst({ pos: cp, color: 0x4dffc8, count: 60, speed: 4, life: 0.8, size: 0.18 });
        vfx.ring(this.bodyPos(e.p, s.w[e.p].lane, 0.2), 0x4dffc8, 0.4, 3, 0.6, 'y');
        this.hud.floatText('+25 Aether', this.bodyPos(e.p, s.w[e.p].lane, 2.4), world.camera, '#4dffc8');
        break;
      }
      case 'perfectDodge': {
        a.play('perfectDodge', { priority: 2 });
        const pos = this.bodyPos(e.p, s.w[e.p].lane, 1.4);
        vfx.ring(pos, 0x9fe8ff, 0.3, 3.2, 0.5, 'z');
        vfx.burst({ pos, color: 0x9fe8ff, count: 40, speed: 4, life: 0.5, size: 0.14 });
        if (e.p === me) {
          this.hud.callout('PERFECT DODGE', '#9fe8ff');
          this.hud.note('Focus: your next spells charge faster', 'good');
          this.slowmo(350);
        } else this.hud.note('Corvane slipped it!', 'foe');
        break;
      }
      case 'overcharge':
        a.play('overcharge', { priority: 2 });
        if (e.p === me) {
          this.hud.callout('OVERCHARGE READY', '#ffd76a');
          this.hud.note('Your next spell hits 35% harder', 'good');
          vfx.ring(this.bodyPos(e.p, s.w[e.p].lane, 0.2), 0xffd76a, 0.4, 4.5, 0.7, 'y');
        }
        break;
      case 'weave':
        a.play('weave');
        if (e.p === me) this.hud.note('Spellweave!', 'good');
        break;
      case 'tide':
        a.play('tide');
        world.setRune(SPELL_INFO[e.spell].color, 2);
        this.hud.note(`${SPELL_INFO[e.spell].short} Tide: −30% cost`, 'good');
        vfx.ring(new THREE.Vector3(0, 0.1, 0), SPELL_INFO[e.spell].color, 1, 14, 1.4, 'y');
        break;
      case 'burn':
      case 'chill':
        if (e.type === 'chill' && e.p === me) this.hud.flash('rgba(150,210,255,0.5)', 0.4);
        break;
      case 'over':
        this.onOver(e.winner, e.reason);
        break;
      default:
        break;
    }
    void T;
  }

  private phaseSeen = 1;

  /** announce the boss growing bolder as its Vitality falls */
  private bossPhase(fw: Wizard): void {
    const ph = fw.vit < 33 ? 3 : fw.vit < 66 ? 2 : 1;
    this.enemy.rage = ph;
    if (ph > this.phaseSeen && fw.state !== 'dead') {
      this.phaseSeen = ph;
      this.hud.callout(ph === 2 ? 'THE MAGISTER GROWS BOLD' : 'THE MAGISTER IS ENRAGED', ph === 2 ? '#ffb070' : '#ff5a4a');
      this.audio.play('phaseUp', { priority: 2 });
      this.world.shake(0.5);
      this.world.chroma(0.6);
      this.world.vfx.ring(new THREE.Vector3(this.enemy.group.position.x, 0.1, this.enemy.group.position.z), ph === 2 ? 0xffa040 : 0xff3a2a, 0.5, 8, 1.0, 'y');
    }
  }

  /** big, readable impact effects per spell family */
  private impactFx(kind: string, pos: THREE.Vector3, lane: number, target: PlayerId, big: number): void {
    const vfx = this.world.vfx;
    const floor = new THREE.Vector3(pos.x, 0.1, pos.z);
    const up = new THREE.Vector3(0, 1, 0);
    switch (kind) {
      case 'cinder':
      case 'fang':
      case 'meteor':
        vfx.burst({ pos: floor, color: 0xff7a2a, count: 50 + big * 80, speed: 3 + big * 4, life: 0.9, size: 0.26, gravity: -3, dir: up, spread: 0.7 });
        vfx.burst({ pos: floor, color: 0xffe0a0, count: 20, speed: 5, life: 0.35, size: 0.18, gravity: 4 });
        vfx.ring(floor, 0xff9a3a, 0.3, 2.6 + big * 2, 0.55, 'y');
        this.fx.scorch(floor, 0xff6a20, 1.1 + big);
        if (kind === 'meteor') this.world.flash.color.setHex(0xff9a40), (this.world.flash.intensity = 50);
        break;
      case 'storm':
        vfx.burst({ pos: floor, color: 0xdffcff, count: 70, speed: 6, life: 0.4, size: 0.14, gravity: 6 });
        vfx.ring(floor, 0x8ff6ff, 0.2, 4, 0.4, 'y');
        vfx.ring(floor, 0xffffff, 0.1, 2.2, 0.25, 'y');
        this.fx.scorch(floor, 0x6fe8ff, 1.2, 2.5);
        break;
      case 'riptide':
        vfx.burst({ pos, color: 0x3fd0c0, count: 70, speed: 4, life: 0.8, size: 0.2, gravity: 5 });
        vfx.ring(floor, 0x7ffff0, 0.2, 3.2, 0.6, 'y');
        break;
      case 'crescent':
        vfx.burst({ pos, color: 0xf2e6a0, count: 60, speed: 6, life: 0.5, size: 0.18 });
        vfx.ring(pos, 0xfff2b0, 0.4, 3.4, 0.4, 'z');
        vfx.ring(pos, 0xfff2b0, 0.2, 2.2, 0.3, 'x');
        break;
      case 'dart':
        vfx.burst({ pos, color: 0xdffcff, count: 30, speed: 7, life: 0.3, size: 0.12 });
        vfx.ring(pos, 0xaaf6ff, 0.1, 1.4, 0.25, 'z');
        break;
      case 'blast':
      case 'lance':
      case 'shard':
        vfx.burst({ pos, color: kind === 'blast' ? 0xffcf4a : kind === 'lance' ? 0xa36bff : 0xbfe6ff, count: 55, speed: 5, life: 0.6, size: 0.18, gravity: 2 });
        vfx.ring(pos, kind === 'blast' ? 0xffcf4a : 0xa36bff, 0.2, 2.6, 0.45, 'z');
        break;
      default:
        break;
    }
    this.world.fovKick = Math.max(this.world.fovKick, 2 + big * 7);
    void lane;
    void target;
  }

  private onOver(winner: PlayerId | null, reason: string): void {
    this.input.abort();
    this.input.enabled = false;
    this.audio.play(winner === this.me ? 'roundWin' : 'roundLose');
    if (reason === 'ko' && winner !== null) {
      this.killcam = { t: 0, target: winner === 0 ? 1 : 0, angle: 0 };
      this.slowmo(1800);
    }
    this.killDelay = reason === 'ko' ? 2.5 : 1.2;
    this.pendingOver = { winner, reason };
  }
  private killDelay = 0;
  private pendingOver: { winner: PlayerId | null; reason: string } | null = null;

  // ---- frame ---------------------------------------------------------------------------------

  frame(dtReal: number, frameMs: number): void {
    const d = this.driver;
    this.time += dtReal;
    const world = this.world;
    if (!d) {
      this.idleFrame(dtReal);
      world.adapt(frameMs);
      return;
    }
    const now = performance.now();
    let scale = 1;
    if (now < this.hitStopUntil) scale = 0.03;
    else if (now < this.slowUntil) scale = 0.35;
    d.timeScale = scale;
    const events = d.update(dtReal);
    const s = d.state;
    for (const e of events) this.handle(e, s);

    const viewTick = s.tick + d.alpha;
    const me = this.me;
    const foe = this.foe;
    const mw = s.w[me];
    const fw = s.w[foe];
    const dt = dtReal;

    // slow-motion also slows particles/cosmetics a little
    const cosmeticDt = dt * (scale < 1 ? Math.max(0.25, scale) : 1);

    // camera
    const x = this.wizX(me, mw, viewTick);
    world.parallax.x += (this.lookX * 0.25 - world.parallax.x) * Math.min(1, dt * 4);
    world.parallax.y += (-this.lookY * 0.1 - world.parallax.y) * Math.min(1, dt * 4);
    const channelingMe = mw.state === 'channeling';
    const channelingFoe = fw.state === 'channeling';
    const chProg = channelingMe && mw.windup ? Math.min(1, (s.tick - mw.windup.start) / Math.max(1, mw.windup.end - mw.windup.start)) : channelingFoe && fw.windup ? Math.min(1, (s.tick - fw.windup.start) / Math.max(1, fw.windup.end - fw.windup.start)) : 0;
    const wantDark = channelingMe || channelingFoe ? 0.35 + chProg * 0.45 : 0;
    this.darkness += (wantDark - this.darkness) * Math.min(1, dt * 2.5);
    world.setDarkness(this.darkness);
    if (channelingMe || channelingFoe) {
      world.shake(0.012 + chProg * 0.02);
      if (channelingMe) world.fovKick = -6 * chProg;
      if (!this.channelLoop) this.channelLoop = this.audio.loop('channel', { gain: 0.05 });
      this.channelLoop.set({ rate: 0.8 + chProg * 1.6, gain: 0.05 + chProg * 0.1 });
    } else if (this.channelLoop) {
      this.channelLoop.stop(0.4);
      this.channelLoop = null;
    }
    this.wasChanneling = channelingMe || channelingFoe;

    if (this.killcam) {
      const k = this.killcam;
      k.t += dtReal;
      k.angle += dtReal * 0.9;
      const tgt = this.enemyOrMe(k.target, viewTick);
      world.camera.position.set(tgt.x + Math.cos(k.angle + 1) * 6.5, 2.8 + Math.sin(k.t) * 0.3, tgt.z + Math.sin(k.angle + 1) * 6.5);
      world.camera.lookAt(tgt.x, 1.4, tgt.z);
    } else {
      const third = this.third;
      world.baseFov = third ? 56 : 62;
      if (third) world.placeThird(new THREE.Vector3(x * 0.5 + 3.4, 5.4, WIZ_Z + 8.6), new THREE.Vector3(x * 0.2 - 0.3, 1.3, -1.2));
      else world.placeCamera(x, WIZ_Z + 0.3, -6, dt);
    }
    this.player.group.visible = !this.third;

    // rigs
    const holdsF = { aurum: fw.orbs.aurum > s.tick, umbra: fw.orbs.umbra > s.tick };
    const holdsM = { aurum: mw.orbs.aurum > s.tick, umbra: mw.orbs.umbra > s.tick };
    this.enemy.update(cosmeticDt, fw, this.wizX(foe, fw, viewTick), this.layout.zOf(foe), s.tick, holdsF, this.tellsOn);
    this.avatar.group.visible = this.third || !!this.killcam;
    if (this.avatar.group.visible) this.avatar.update(cosmeticDt, mw, x, this.layout.zOf(me), s.tick, holdsM, false);
    const drawingNow = this.input.isDrawing;
    let tipLocal: THREE.Vector3 | null = null;
    if (drawingNow && this.plane.strokeLength > 0) {
      const wp = this.plane.headWorld(this.tmp);
      tipLocal = world.camera.worldToLocal(wp.clone());
    }
    this.player.update(cosmeticDt, mw, tipLocal, holdsM, mw.aether, mw.vit, s.tick);
    this.plane.update(dt, drawingNow);
    this.fx.update(cosmeticDt, s, viewTick);
    this.fx.charge(me, mw.windup, s.tick, this.myTip(this.tmp).clone(), cosmeticDt);
    this.fx.charge(foe, fw.windup, s.tick, this.enemy.tip(this.tmp).clone(), cosmeticDt);
    this.fx.circle(me, mw.windup, s.tick, new THREE.Vector3(x, 0.07, this.layout.zOf(me)), cosmeticDt);
    this.fx.circle(foe, fw.windup, s.tick, new THREE.Vector3(this.wizX(foe, fw, viewTick), 0.07, this.layout.zOf(foe)), cosmeticDt);
    this.bossPhase(fw);

    // looping audio: incoming projectiles rise in pitch as they approach (audio telegraph)
    const seen = new Set<number>();
    let nearest = 99;
    for (const pr of s.projectiles) {
      if (pr.owner === me) continue;
      seen.add(pr.id);
      const eta = Math.max(0, pr.arrive - viewTick);
      nearest = Math.min(nearest, eta);
      let l = this.projLoops.get(pr.id);
      if (!l && this.projLoops.size < 3) {
        l = { h: this.audio.loop('proj', { gain: 0.0, pan: 0 }), kind: pr.kind };
        this.projLoops.set(pr.id, l);
      }
      if (l) {
        const f = 1 - eta / Math.max(1, pr.arrive - pr.born);
        l.h.set({ rate: 0.7 + f * 2.4, gain: (pr.kind === 'eclipse' ? 0.1 : 0.045) * (0.3 + f), pan: (this.layout.laneX(pr.lane) / 5) * 0.7 });
      }
    }
    for (const [id, l] of this.projLoops) {
      if (!seen.has(id)) {
        l.h.stop(0.05);
        this.projLoops.delete(id);
      }
    }
    // tension + heartbeat
    const lowHp = Math.max(0, 1 - mw.vit / 35);
    this.audio.tension(Math.max(lowHp, chProg, nearest < 20 ? 0.5 : 0, 1 - Math.min(fw.vit, mw.vit) / 100 * 0.6));
    if (mw.vit < 30 && mw.state !== 'dead') {
      this.heartbeat -= dtReal;
      if (this.heartbeat <= 0) {
        this.audio.play('heartbeat');
        this.heartbeat = 0.9 - lowHp * 0.4;
      }
    }
    world.setVignette(lowHp);

    // sigil plane timer ring while the sim draw window runs
    if (drawingNow && mw.draw) {
      const el = (viewTick - mw.draw.start) / (B.drawWindow * TICK_RATE);
      this.plane.setTimer(1 - el);
    }
    if (mw.fatigue > 0 && s.tick === mw.lastCastTick) this.audio.play('fatigueCrack');

    if (s.tick >= s.nextTide - 1 && this.tideSeen !== s.nextTide) this.tideSeen = s.nextTide;

    this.hud.update(s, me, viewTick, { enemyOrbs: true });
    this.hud.setPing(d.ping);

    // round over: hold for the killcam, then notify the app
    if (this.pendingOver && !this.overFired) {
      this.killDelay -= dtReal;
      if (this.killDelay <= 0) {
        this.overFired = true;
        const o = this.pendingOver;
        this.pendingOver = null;
        this.cb.onRoundOver?.(o.winner, o.reason);
      }
    }
    world.update(cosmeticDt);
    world.adapt(frameMs);
    void now;
  }

  private enemyOrMe(p: PlayerId, viewTick: number): THREE.Vector3 {
    const d = this.driver!;
    return new THREE.Vector3(this.wizX(p, d.state.w[p], viewTick), 1.4, this.layout.zOf(p));
  }

  private idleFrame(dt: number): void {
    const w = this.world;
    w.placeCamera(0, WIZ_Z + 0.3, -6, dt);
    w.camera.position.x = Math.sin(this.time * 0.15) * 1.6;
    w.camera.position.y = 2.2 + Math.sin(this.time * 0.2) * 0.3;
    w.camera.lookAt(0, 2.4, -8);
    this.plane.update(dt, this.input.isDrawing);
    this.enemy.update(dt, idleWizard, 0, -WIZ_Z, 0, { aurum: false, umbra: false }, false);
    let tip: THREE.Vector3 | null = null;
    if (this.input.isDrawing && this.plane.strokeLength > 0) tip = w.camera.worldToLocal(this.plane.headWorld(this.tmp).clone());
    this.player.update(dt, idleWizard, tip, { aurum: false, umbra: false }, 100, 100, 0);
    w.update(dt);
  }

  /** Show the sigil plane + player hands without a duel (menus, lessons) */
  setIdleVisible(enemyVisible: boolean): void {
    this.enemy.group.visible = enemyVisible;
  }

  /** time in seconds the draw timer should show, for lessons/drills without a sim */
  freeDrawTimer(on: boolean): void {
    void on;
  }
}

const idleWizard = ((): Wizard => {
  return {
    vit: 100, aether: 100, poise: 40, lane: 1, state: 'idle', stateUntil: 0, oath: null, windup: null, draw: null, cooldowns: {}, blinkReady: 0,
    blinkFrom: 1, blinkTo: 1, invulnUntil: 0, regenFrom: 0, lastHit: 0, brokenUntil: 0, openUntil: 0, orbs: { aurum: 0, umbra: 0 }, ward: null,
    mirror: null, burnUntil: 0, burnPhase: 0, aegisUntil: 0, focusUntil: 0, streak: 0, overcharge: false, heal: null, chillUntil: 0, lastSpell: null, lastCastTick: 0, fatigue: 0, recent: [], weaveUntil: 0, echoNext: false,
    casts: 0, stats: { damageDealt: 0, casts: {} },
  };
})();
