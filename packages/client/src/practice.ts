import type { Bot, Cmd, DuelState, PlayerId, SimEvent, SpellId } from '@sigilfall/sim';
import { B, WizardAI } from '@sigilfall/sim';
import {
  canonical, makeTemplate, recognize, scoreAgainst, spellToShape, validateTemplates, Pt, Template, RecognitionResult, bounds,
} from '@sigilfall/recognizer';
import type { AppApi } from './app';
import { DummyBot, LocalDriver } from './driver';
import { SPELL_INFO, SPELL_ORDER } from './theme';
import { settings, store } from './settings';

interface SpellStat { att: number; ok: number; ms: number }
interface Stats { spells: Record<string, SpellStat>; confused: Record<string, number>; best: Record<string, number> }

const progress = store<string[]>('practice.done.v1', []);
const statsStore = store<Stats>('practice.stats.v1', { spells: {}, confused: {}, best: {} });
const tplStore = store<Template[]>('practice.templates.v1', []);

const winding = (sp: SpellId) => (sp === 'umbra' ? 'ccw' : 'cw');

/** Fires cinder / storm volleys into random lanes so the player can rehearse Blink timing. */
class LaneBot implements Bot {
  private next = 40;
  private plan: Cmd[] = [];
  constructor(public me: PlayerId) {}
  observe(): void {}
  act(s: DuelState): Cmd[] {
    const w = s.w[this.me];
    if (this.plan.length && (w.state === 'idle' || w.state === 'drawing')) return [this.plan.shift()!];
    if (s.tick >= this.next && w.state === 'idle') {
      this.next = s.tick + 50 + Math.floor(Math.random() * 40);
      const spell: SpellId = Math.random() < 0.5 ? 'cinder' : 'storm';
      const aim = Math.floor(Math.random() * 3) as 0 | 1 | 2;
      this.plan = [{ t: 'drawStart' }, { t: 'cast', spell, tier: 'clean', aim }];
      w.aether = 100;
    }
    return [];
  }
}

export class Practice {
  private done = new Set(progress.get());
  private overlay: HTMLElement | null = null;
  private active = false;

  constructor(private app: AppApi) {
    app.scene.custom = tplStore.get();
  }

  // ---- shell -------------------------------------------------------------------------------

  private begin(): void {
    const sc = this.app.scene;
    sc.stop();
    sc.setIdleVisible(true);
    sc.input.enabled = true;
    sc.onlyShapes = null;
    this.active = true;
    this.app.audio.music('menu');
  }

  close(): void {
    const sc = this.app.scene;
    sc.free = null;
    sc.onEvent = null;
    sc.plane.showGhost(null);
    sc.plane.cancel();
    this.overlay?.remove();
    this.overlay = null;
    this.active = false;
  }

  private hud(html: string): HTMLElement {
    this.overlay?.remove();
    const el = document.createElement('div');
    el.className = 'lesson';
    el.innerHTML = html;
    this.app.screen.appendChild(el);
    this.overlay = el;
    return el;
  }

  private bar(buttons: [string, () => void][]): HTMLElement {
    this.app.screen.querySelectorAll('.lessonbtns').forEach((e) => e.remove());
    const el = document.createElement('div');
    el.className = 'lessonbtns';
    buttons.forEach(([label, fn]) => {
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = label;
      b.onclick = () => {
        this.app.audio.play('uiClick');
        fn();
      };
      el.appendChild(b);
    });
    this.app.screen.appendChild(el);
    return el;
  }

  private stage(): void {
    // keep the 3D scene, drop menu panels
    this.app.clear();
    this.begin();
  }

  open(): void {
    this.close();
    this.begin();
    const done = this.done.size;
    const el = this.app.show(`<div class="menu"><div class="panel" style="width:min(640px,94vw)"><h2>Practice Sanctum</h2>
      <p style="text-align:center">Learn the sigils with the Hollow Effigy. ${done}/${SPELL_ORDER.length} lessons complete.</p>
      <div class="row" style="flex-direction:column;align-items:center">
        <button class="btn primary" data-a="lessons">Guided lessons</button>
        <button class="btn" data-a="grimoire">Grimoire</button>
        <button class="btn" data-a="drills">Drills</button>
        <button class="btn" data-a="dummy">Hollow Effigy sparring</button>
        <button class="btn" data-a="tune">Recognizer &amp; my sigils</button>
        <button class="btn" data-a="stats">Stats</button>
        <button class="btn small" data-a="back">Back</button></div></div></div>`);
    const go: Record<string, () => void> = {
      lessons: () => this.lessonList(), grimoire: () => this.grimoire(), drills: () => this.drills(), dummy: () => this.dummyMenu(),
      tune: () => this.tuning(), stats: () => this.statsPanel(), back: () => { this.close(); this.app.menu(); },
    };
    el.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => go[(b as HTMLElement).dataset.a!]!()));
  }

  private record(spell: SpellId, ok: boolean, ms: number, result: RecognitionResult): void {
    const s = statsStore.get();
    const st = (s.spells[spell] ??= { att: 0, ok: 0, ms: 0 });
    st.att++;
    if (ok) {
      st.ok++;
      st.ms += ms;
    } else if (result.spell) {
      const k = `${spell}>${result.spell}`;
      s.confused[k] = (s.confused[k] ?? 0) + 1;
    }
    statsStore.set(s);
  }

  // ---- lessons -----------------------------------------------------------------------------

  private lessonList(): void {
    const el = this.app.show(`<div class="menu"><div class="panel"><h2>Guided lessons</h2><div class="cards">${SPELL_ORDER.map((sp, i) => {
      const i2 = SPELL_INFO[sp];
      return `<button class="card ${this.done.has(sp) ? 'sel' : ''}" data-l="${sp}"><span class="g" style="color:${i2.css}">${i2.icon}</span><h3>${i + 1}. ${i2.name}${this.done.has(sp) ? ' ✓' : ''}</h3><p>${sp === 'eclipse' ? 'The combo finisher' : sp === 'aurum' ? 'Circle, clockwise' : sp === 'umbra' ? 'Circle, counter-clockwise' : i2.blurb.split('.')[0]}</p></button>`;
    }).join('')}</div><div class="row" style="margin-top:12px"><button class="btn small" data-a="back">Back</button></div></div></div>`);
    el.querySelectorAll('[data-l]').forEach((b) => b.addEventListener('click', () => this.lesson((b as HTMLElement).dataset.l as SpellId)));
    el.querySelector('[data-a=back]')!.addEventListener('click', () => this.open());
  }

  private lesson(spell: SpellId): void {
    this.stage();
    const sc = this.app.scene;
    const info = SPELL_INFO[spell];
    const shape = spellToShape(spell);
    const ghost = canonical(shape, winding(spell)).map((p) => ({ x: 200 + p.x * 600, y: 200 + p.y * 600 }));
    let ok = 0;
    let fails = 0;
    let last = '';
    sc.plane.setColor(info.color);
    sc.plane.showGhost(ghost);
    const start = ghost[0]!;
    const render = () => {
      this.hud(`<h3 style="color:${info.css}">${info.icon} ${info.name}</h3>
        <p>${spell === 'eclipse' ? 'In a duel you need both orbs first. Here, just learn the figure-eight.' : info.blurb}</p>
        <p>Start where the ghost wand starts and follow its path. Hold to draw, release to cast.</p>
        <div class="dots">${[0, 1, 2].map((i) => `<b class="${i < ok ? 'on' : ''}"></b>`).join('')}</div><div class="acc">${last}</div>`);
    };
    render();
    const next = () => {
      const i = SPELL_ORDER.indexOf(spell);
      const n = SPELL_ORDER[i + 1];
      if (n) this.lesson(n);
      else this.open();
    };
    this.bar([['Lessons', () => this.lessonList()], ['Replay ghost', () => sc.plane.showGhost(ghost)], ['Skip', next]]);
    sc.free = {
      stroke: (stroke, ms, cancelled) => {
        if (cancelled) return sc.plane.unravel();
        const result = recognize(stroke, { custom: sc.custom, strictness: settings.strictness });
        const acc = Math.round(scoreAgainst(stroke, shape, { custom: [] }) * 100);
        const good = result.spell === spell;
        this.record(spell, good, ms, result);
        if (result.spell) {
          sc.showRecognised(result, stroke);
        } else {
          sc.plane.fizzle();
          sc.audio.play('fizzle');
        }
        if (good) {
          ok++;
          fails = 0;
          last = `${acc}% match · ${result.tier}`;
          if (ok === 1) sc.plane.showGhost(null);
          if (ok >= 3) {
            this.done.add(spell);
            progress.set([...this.done]);
            last = `Lesson complete! ${SPELL_INFO[spell].name} added to your Grimoire.`;
            sc.audio.play('roundWin');
            render();
            this.bar([['Lessons', () => this.lessonList()], ['Again', () => this.lesson(spell)], ['Next lesson', next]]);
            return;
          }
        } else {
          fails++;
          last = result.spell ? `That was ${SPELL_INFO[result.spell].name} (${acc}% match)` : `${acc}% match — keep the shape clear`;
          if (fails >= 2) {
            sc.plane.showGhost(ghost);
            last += ' · hint shown';
          }
        }
        render();
      },
    };
  }

  // ---- grimoire ----------------------------------------------------------------------------

  private grimoire(sel: SpellId = 'cinder'): void {
    const info = SPELL_INFO[sel];
    const spec = (B.spells as Record<string, Record<string, number>>)[sel]!;
    const locked = (sp: SpellId) => !this.done.has(sp) && sp !== 'cinder';
    const el = this.app.show(`<div class="menu"><div class="panel" style="width:min(820px,94vw)"><h2>Grimoire</h2><div class="grim">
      <div class="list">${SPELL_ORDER.map((sp) => `<button class="card ${sp === sel ? 'sel' : ''} ${locked(sp) ? 'locked' : ''}" data-s="${sp}" style="padding:8px 12px"><h3 style="margin:0;color:${SPELL_INFO[sp].css}">${locked(sp) ? '🔒 ???' : SPELL_INFO[sp].icon + ' ' + SPELL_INFO[sp].name}</h3></button>`).join('')}</div>
      <div>${locked(sel) ? '<p>Complete this spell\'s lesson to unlock the entry.</p>' : `
        <canvas id="gsym" width="220" height="220"></canvas>
        <h3 style="font-family:var(--serif);color:${info.css}">${info.name}</h3>
        <div class="kv"><span>Aether</span><b>${spec.aether}</b><span>Windup</span><b>${spec.windup}s</b>${spec.cooldown ? `<span>Cooldown</span><b>${spec.cooldown}s</b>` : ''}${spec.damage ? `<span>Damage</span><b>${spec.damage}</b>` : ''}${spec.poise ? `<span>Poise damage</span><b>${spec.poise}</b>` : ''}</div>
        <p>${info.blurb}</p><p><b>Counters:</b> ${info.counters}</p>
        <p>${sel === 'cinder' ? 'Combo: Stormfork on a burning foe is <b>Thunderburn</b> (+60%).' : sel === 'ward' ? 'Combo: Ward while holding Umbra is <b>Wellspring</b>.' : sel === 'mirror' ? 'Combo: reflect while holding Aurum is <b>Prism Return</b>.' : sel === 'eclipse' ? 'Hold Aurum + Umbra, then draw ∞. Counter it with Gravewell, interrupts, or a late Blink.' : ''}</p>`}</div></div>
      <div class="row" style="margin-top:12px"><button class="btn small" data-a="back">Back</button></div></div></div>`);
    el.querySelectorAll('[data-s]').forEach((b) => b.addEventListener('click', () => this.grimoire((b as HTMLElement).dataset.s as SpellId)));
    el.querySelector('[data-a=back]')!.addEventListener('click', () => this.open());
    const cv = el.querySelector('#gsym') as HTMLCanvasElement | null;
    if (cv) {
      const g = cv.getContext('2d')!;
      const pts = canonical(spellToShape(sel), winding(sel));
      let t = 0;
      const tick = () => {
        if (!cv.isConnected) return;
        t = (t + 0.012) % 1.3;
        g.clearRect(0, 0, 220, 220);
        g.strokeStyle = info.css;
        g.lineWidth = 5;
        g.lineCap = 'round';
        g.shadowColor = info.css;
        g.shadowBlur = 14;
        g.beginPath();
        const n = Math.floor(pts.length * Math.min(1, t));
        pts.slice(0, Math.max(2, n)).forEach((p, i) => (i ? g.lineTo(30 + p.x * 160, 30 + p.y * 160) : g.moveTo(30 + p.x * 160, 30 + p.y * 160)));
        g.stroke();
        const s = pts[0]!;
        g.fillStyle = '#fff';
        g.beginPath();
        g.arc(30 + s.x * 160, 30 + s.y * 160, 6, 0, 7);
        g.fill();
        requestAnimationFrame(tick);
      };
      tick();
    }
  }

  // ---- drills ------------------------------------------------------------------------------

  private drills(): void {
    const el = this.app.show(`<div class="menu"><div class="panel"><h2>Drills</h2><div class="cards">
      <button class="card" data-d="speed"><span class="g">⏱</span><h3>Speed Draw</h3><p>Draw the called-out sigil as fast as you can. Best: ${statsStore.get().best.speed ?? '—'} ms avg</p></button>
      <button class="card" data-d="counter"><span class="g">⚔</span><h3>Counter Drill</h3><p>The Effigy telegraphs a spell. Draw (or Blink) the right answer.</p></button>
      <button class="card" data-d="fusion"><span class="g">∞</span><h3>Orb Fusion</h3><p>Aurum, Umbra, then Eclipse — against the clock. Best: ${statsStore.get().best.fusion ?? '—'} ms</p></button>
      <button class="card" data-d="lane"><span class="g">⇆</span><h3>Lane Dance</h3><p>Dodge a stream of bolts and lightning with A / D.</p></button></div>
      <div class="row" style="margin-top:12px"><button class="btn small" data-a="back">Back</button></div></div></div>`);
    el.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => {
      const d = (b as HTMLElement).dataset.d;
      if (d === 'speed') this.speedDraw();
      else if (d === 'counter') this.counterDrill();
      else if (d === 'fusion') this.fusionDrill();
      else this.laneDance();
    }));
    el.querySelector('[data-a=back]')!.addEventListener('click', () => this.open());
  }

  private speedDraw(): void {
    this.stage();
    const sc = this.app.scene;
    const pool = SPELL_ORDER.filter((s) => s !== 'eclipse');
    const rounds = 5;
    const times: number[] = [];
    let round = 0;
    let target: SpellId = 'cinder';
    let shown = performance.now();
    const call = () => {
      target = pool[Math.floor(Math.random() * pool.length)]!;
      shown = performance.now();
      const i = SPELL_INFO[target];
      this.hud(`<h3>Speed Draw ${round + 1}/${rounds}</h3><p class="acc" style="color:${i.css}">${i.icon} ${i.name}</p><p>${times.length ? 'Last: ' + times[times.length - 1] + ' ms' : 'Draw it!'}</p>`);
    };
    call();
    this.bar([['Drills', () => this.drills()]]);
    sc.free = {
      stroke: (stroke, ms, cancelled) => {
        if (cancelled) return sc.plane.unravel();
        const result = recognize(stroke, { custom: sc.custom, strictness: settings.strictness });
        const good = result.spell === target;
        this.record(target, good, ms, result);
        if (result.spell) sc.showRecognised(result, stroke);
        else sc.plane.fizzle();
        if (!good) {
          sc.hud.note(result.spell ? `That was ${SPELL_INFO[result.spell].name}` : 'Fizzle', 'warn');
          return;
        }
        times.push(Math.round(performance.now() - shown));
        round++;
        if (round >= rounds) {
          const avg = Math.round(times.reduce((a, b) => a + b, 0) / rounds);
          const s = statsStore.get();
          const prev = s.best.speed;
          if (!prev || avg < prev) s.best.speed = avg;
          statsStore.set(s);
          this.hud(`<h3>Done!</h3><p class="acc">${avg} ms average</p><p>${prev && avg >= prev ? `Best: ${prev} ms` : 'New personal best!'}</p>`);
          this.bar([['Again', () => this.speedDraw()], ['Drills', () => this.drills()]]);
          sc.free = null;
          return;
        }
        setTimeout(call, 500);
      },
    };
  }

  private counterDrill(): void {
    this.stage();
    const sc = this.app.scene;
    const scenarios: { say: string; ok: (SpellId | 'blink')[]; tip: string }[] = [
      { say: 'Corvane hurls a Cinder Bolt!', ok: ['ward', 'mirror', 'blink'], tip: 'Ward absorbs it, Mirrorveil returns it, Blink dodges it.' },
      { say: 'Lightning marks your lane!', ok: ['blink'], tip: 'Press A or D (or the arrows) to leave the lane.' },
      { say: 'Corvane raises a Glacier Ward!', ok: ['storm'], tip: 'Stormfork punches through half the Ward.' },
      { say: 'Corvane channels Eclipse Rend!', ok: ['gravewell', 'storm'], tip: 'Gravewell collapses it, Stormfork interrupts the channel.' },
      { say: 'Corvane holds both orbs!', ok: ['gravewell'], tip: 'Gravewell pops enemy orbs before they fuse.' },
    ];
    let score = 0;
    let n = 0;
    let cur = scenarios[0]!;
    let deadline = 0;
    let open = false;
    const next = () => {
      if (n >= 6) {
        this.hud(`<h3>Counter Drill</h3><p class="acc">${score}/6 correct</p>`);
        this.bar([['Again', () => this.counterDrill()], ['Drills', () => this.drills()]]);
        sc.free = null;
        return;
      }
      cur = scenarios[Math.floor(Math.random() * scenarios.length)]!;
      deadline = performance.now() + 5000;
      open = true;
      this.hud(`<h3 style="color:#ff9a7a">${cur.say}</h3><p>Answer within 5 seconds (${n + 1}/6) — draw a counter sigil or Blink.</p><p class="acc">${score} correct</p>`);
      sc.audio.play('stormMark');
    };
    const answer = (what: SpellId | 'blink' | null) => {
      if (!open) return;
      open = false;
      n++;
      const good = !!what && cur.ok.includes(what);
      if (good) score++;
      sc.hud.note(good ? 'Correct!' : what ? 'Wrong counter' : 'Too slow', good ? 'good' : 'warn');
      sc.hud.note(cur.tip, 'hint');
      setTimeout(next, 1400);
    };
    next();
    this.bar([['Drills', () => this.drills()]]);
    const timer = setInterval(() => {
      if (!sc.free || !this.active) return clearInterval(timer);
      if (open && performance.now() > deadline) answer(null);
    }, 200);
    sc.free = {
      blink: () => answer('blink'),
      stroke: (stroke, _ms, cancelled) => {
        if (cancelled) return sc.plane.unravel();
        const r = recognize(stroke, { custom: sc.custom, strictness: settings.strictness });
        if (r.spell) sc.showRecognised(r, stroke);
        else sc.plane.fizzle();
        answer(r.spell);
      },
    };
  }

  private fusionDrill(): void {
    this.stage();
    const sc = this.app.scene;
    const seq: SpellId[] = ['aurum', 'umbra', 'eclipse'];
    let step = 0;
    let t0 = 0;
    const show = () => {
      const i = SPELL_INFO[seq[step]!];
      this.hud(`<h3>Orb Fusion</h3><p class="acc" style="color:${i.css}">${i.icon} ${i.name}</p><div class="dots">${seq.map((_, k) => `<b class="${k < step ? 'on' : ''}"></b>`).join('')}</div><p>Clockwise circle, counter-clockwise circle, then ∞.</p>`);
    };
    show();
    this.bar([['Drills', () => this.drills()]]);
    sc.free = {
      stroke: (stroke, _ms, cancelled) => {
        if (cancelled) return sc.plane.unravel();
        const r = recognize(stroke, { custom: sc.custom, strictness: settings.strictness });
        if (r.spell) sc.showRecognised(r, stroke);
        else sc.plane.fizzle();
        if (r.spell !== seq[step]) return;
        if (step === 0) t0 = performance.now();
        step++;
        if (step >= seq.length) {
          const ms = Math.round(performance.now() - t0);
          const s = statsStore.get();
          if (!s.best.fusion || ms < s.best.fusion) s.best.fusion = ms;
          statsStore.set(s);
          this.hud(`<h3>Fused!</h3><p class="acc">${ms} ms from first orb to Eclipse</p>`);
          this.bar([['Again', () => this.fusionDrill()], ['Drills', () => this.drills()]]);
          sc.free = null;
          return;
        }
        show();
      },
    };
  }

  private laneDance(): void {
    this.startSpar(() => new LaneBot(1), 'Lane Dance', true);
  }

  // ---- sparring ----------------------------------------------------------------------------

  private dummyMenu(): void {
    const el = this.app.show(`<div class="menu"><div class="panel"><h2>Hollow Effigy</h2><div class="cards">
      <button class="card" data-m="static"><span class="g">☐</span><h3>Static</h3><p>Stands still. Practise casting and combos.</p></button>
      <button class="card" data-m="scripted"><span class="g">⌖</span><h3>Scripted</h3><p>Casts when you press the cue buttons, so you can rehearse counters.</p></button>
      <button class="card" data-m="aggressive"><span class="g">⚔</span><h3>Aggressive</h3><p>Fights back like an Adept.</p></button></div>
      <div class="row" style="margin-top:12px"><button class="btn small" data-a="back">Back</button></div></div></div>`);
    el.querySelectorAll('[data-m]').forEach((b) =>
      b.addEventListener('click', () => {
        const mode = (b as HTMLElement).dataset.m as 'static' | 'scripted' | 'aggressive';
        this.startSpar(() => this.makeDummy(mode), 'Hollow Effigy', false, mode === 'scripted');
      }),
    );
    el.querySelector('[data-a=back]')!.addEventListener('click', () => this.open());
  }

  private makeDummy(mode: 'static' | 'scripted' | 'aggressive'): Bot {
    this.dummy = new DummyBot(1, mode, mode === 'aggressive' ? new WizardAI(1, 'adept', 7) : undefined);
    return this.dummy;
  }
  private dummy: DummyBot | null = null;

  private startSpar(bot: (s: DuelState) => Bot, name: string, lane: boolean, cues = false): void {
    this.app.clear();
    this.close();
    const sc = this.app.scene;
    sc.free = null;
    const driver = new LocalDriver({ difficulty: 'adept', oath: 'echoes', bot: (s) => bot(s), endless: true });
    this.app.runDuel(driver, { enemyName: name });
    this.active = true;
    sc.quickAllowed = true;
    let dodged = 0;
    let hits = 0;
    const bar = document.createElement('div');
    bar.className = 'lessonbtns';
    bar.style.bottom = 'auto';
    bar.style.top = '60px';
    bar.style.left = '12px';
    bar.style.transform = 'none';
    const mk = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = label;
      b.onclick = fn;
      bar.appendChild(b);
    };
    mk('Exit', () => {
      sc.onEvent = null;
      this.close();
      this.app.scene.stop();
      this.open();
    });
    if (cues && this.dummy) {
      mk('Cue Cinder', () => this.dummy!.cueCast('cinder'));
      mk('Cue Stormfork', () => this.dummy!.cueCast('storm'));
      mk('Cue Orb', () => this.dummy!.cueCast('aurum'));
    }
    this.app.screen.appendChild(bar);
    sc.onEvent = (e: SimEvent) => {
      if (!lane) return;
      if (e.type === 'dodge' && e.p === 0) dodged++;
      if (e.type === 'stormStrike' && e.p === 1 && !e.hit) dodged++;
      if (e.type === 'hit' && e.p === 0 && e.kind !== 'burn') hits++;
      if (e.type === 'dodge' || e.type === 'hit' || e.type === 'stormStrike') sc.hud.note(`Dodged ${dodged} · Hit ${hits}`, 'hint');
    };
  }

  // ---- recognizer tuning, custom sigils ----------------------------------------------------

  private tuning(): void {
    this.stage();
    const sc = this.app.scene;
    let target: SpellId | null = null;
    let lastRank = 'Draw any sigil to see how the recognizer reads it.';
    const render = () => {
      const tpl = sc.custom.reduce<Record<string, number>>((m, t) => ((m[t.shape] = (m[t.shape] ?? 0) + 1), m), {});
      this.hud(`<h3>Recognizer &amp; my sigils</h3><p>${target ? `Recording: <b style="color:${SPELL_INFO[target].css}">${SPELL_INFO[target].name}</b> — draw your own version` : 'Pick a spell below to record your own version (max 3 each).'}</p>
        <p class="acc" style="font-size:15px">${lastRank}</p><p>Custom variants: ${Object.entries(tpl).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none'} · Strictness ${settings.strictness.toFixed(2)}</p>`);
    };
    render();
    const bar = this.bar([
      ['Menu', () => this.open()],
      ['Stricter', () => { settings.strictness = Math.min(1.15, settings.strictness + 0.03); render(); }],
      ['Looser', () => { settings.strictness = Math.max(0.85, settings.strictness - 0.03); render(); }],
      ['Clear mine', () => { sc.custom = []; tplStore.set([]); render(); }],
      ['Export', () => { void navigator.clipboard?.writeText(JSON.stringify(sc.custom)); this.app.toast('Custom sigils copied to clipboard'); }],
      ['Import', () => {
        const raw = prompt('Paste exported sigil JSON');
        if (!raw) return;
        try {
          sc.custom = validateTemplates(JSON.parse(raw));
          tplStore.set(sc.custom);
          render();
        } catch {
          this.app.toast('Invalid sigil data');
        }
      }],
    ]);
    bar.style.flexWrap = 'wrap';
    bar.style.width = '94vw';
    bar.style.justifyContent = 'center';
    bar.style.bottom = '4%';
    const picker = document.createElement('div');
    picker.className = 'lessonbtns';
    picker.style.bottom = '16%';
    picker.style.flexWrap = 'wrap';
    picker.style.width = '94vw';
    picker.style.justifyContent = 'center';
    for (const sp of SPELL_ORDER) {
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = SPELL_INFO[sp].icon + ' ' + SPELL_INFO[sp].short;
      b.onclick = () => { target = target === sp ? null : sp; render(); };
      picker.appendChild(b);
    }
    this.app.screen.appendChild(picker);
    sc.free = {
      stroke: (stroke, _ms, cancelled) => {
        if (cancelled) return sc.plane.unravel();
        if (target) {
          const shape = spellToShape(target);
          const r = recognize(stroke, { custom: [], strictness: settings.strictness });
          const want = target;
          if (r.spell !== want) {
            sc.plane.fizzle();
            lastRank = `That reads as ${r.spell ? SPELL_INFO[r.spell].name : 'nothing'} — a custom version must still be recognised as ${SPELL_INFO[want].name}.`;
            return render();
          }
          const b = bounds(stroke);
          void b;
          const tpl = makeTemplate(shape, stroke);
          const same = sc.custom.filter((t) => t.shape === shape);
          if (same.length >= 3) sc.custom = sc.custom.filter((t) => t !== same[0]);
          sc.custom = validateTemplates([...sc.custom, tpl]);
          tplStore.set(sc.custom);
          sc.showRecognised(r, stroke);
          lastRank = `Saved your ${SPELL_INFO[want].name}.`;
          return render();
        }
        const r = recognize(stroke, { custom: sc.custom, strictness: settings.strictness });
        if (r.spell) sc.showRecognised(r, stroke);
        else sc.plane.fizzle();
        lastRank = `${r.spell ? SPELL_INFO[r.spell].name + ' · ' + r.tier : 'Fizzle (' + (r.reason ?? 'no match') + ')'} — ` + r.ranked.slice(0, 3).map((x) => `${x.shape} ${(x.score * 100).toFixed(0)}%`).join(', ');
        render();
      },
    };
  }

  private statsPanel(): void {
    const s = statsStore.get();
    const rows = SPELL_ORDER.map((sp) => {
      const st = s.spells[sp];
      return `<tr><td style="color:${SPELL_INFO[sp].css}">${SPELL_INFO[sp].icon} ${SPELL_INFO[sp].name}</td><td>${st?.att ?? 0}</td><td>${st && st.att ? Math.round((st.ok / st.att) * 100) + '%' : '—'}</td><td>${st && st.ok ? Math.round(st.ms / st.ok) + ' ms' : '—'}</td></tr>`;
    }).join('');
    const conf = Object.entries(s.confused).sort((a, b) => b[1] - a[1])[0];
    const el = this.app.show(`<div class="menu"><div class="panel" style="width:min(640px,94vw)"><h2>Stats</h2>
      <table class="stats"><tr><th>Spell</th><th>Attempts</th><th>Success</th><th>Avg draw</th></tr>${rows}</table>
      <p>Most confused pair: <b>${conf ? conf[0].replace('>', ' → ') + ' (' + conf[1] + '×)' : 'none yet'}</b></p>
      <div class="row"><button class="btn small" data-a="reset">Reset</button><button class="btn small" data-a="back">Back</button></div></div></div>`);
    el.querySelector('[data-a=back]')!.addEventListener('click', () => this.open());
    el.querySelector('[data-a=reset]')!.addEventListener('click', () => { statsStore.set({ spells: {}, confused: {}, best: {} }); this.statsPanel(); });
  }
}
