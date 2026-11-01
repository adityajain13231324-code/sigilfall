import type { Oath, PlayerId } from '@sigilfall/sim';
import { OATHS } from '@sigilfall/sim';
import { DuelScene } from './duel';
import { SynthAudio } from './audio';
import { Driver, LocalDriver } from './driver';
import { settings, saveSettings, Difficulty, store } from './settings';
import { OATH_INFO } from './theme';
import { Practice } from './practice';
import { Online } from './net';

export interface AppApi {
  scene: DuelScene;
  audio: SynthAudio;
  screen: HTMLElement;
  menu(): void;
  show(html: string): HTMLElement;
  clear(): void;
  runDuel(driver: Driver, opts?: { enemyName?: string; online?: boolean }): void;
  toast(text: string, ms?: number): void;
}

const stats = store('stats.v1', { wins: 0, losses: 0, rounds: 0 });

export class App implements AppApi {
  scene: DuelScene;
  audio = new SynthAudio();
  screen = document.getElementById('screen')!;
  private driver: Driver | null = null;
  private practice: Practice;
  private online: Online;
  private last = performance.now();
  private paused = false;
  private inDuel = false;
  private isOnline = false;
  private difficulty: Difficulty = settings.difficulty;

  constructor() {
    const canvas = document.getElementById('c') as HTMLCanvasElement;
    this.scene = new DuelScene(canvas, document.getElementById('hud')!, document.getElementById('captions')!, this.audio);
    this.practice = new Practice(this);
    this.online = new Online(this);
    this.scene.cb.onPause = () => this.pause();
    this.scene.cb.onRoundOver = (w, r) => this.roundOver(w, r);
    this.applySettings();
    window.addEventListener('pointerdown', () => this.audio.unlock(), { once: false });
    window.addEventListener('keydown', () => this.audio.unlock());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.inDuel && !this.isOnline) this.pause();
    });
    this.menu();
    requestAnimationFrame(this.loop);
    (window as unknown as { __sigil: App }).__sigil = this;
  }

  private loop = (t: number): void => {
    const frameMs = t - this.last;
    const dt = Math.min(0.1, frameMs / 1000);
    this.last = t;
    this.scene.frame(dt, frameMs);
    this.scene.world.render();
    requestAnimationFrame(this.loop);
  };

  applySettings(): void {
    document.body.classList.toggle('clarity', settings.clarity);
    document.body.classList.toggle('reduced', settings.reducedMotion);
    document.documentElement.style.setProperty('--ui', String(settings.uiScale));
    this.scene.world.applySettings();
    this.scene.plane.layout();
  }

  // ---- screens -------------------------------------------------------------------------------

  clear(): void {
    this.screen.innerHTML = '';
  }

  show(html: string): HTMLElement {
    this.screen.innerHTML = html;
    const root = this.screen.firstElementChild as HTMLElement;
    root.querySelectorAll('button, .card').forEach((b) => {
      b.addEventListener('mouseenter', () => this.audio.play('uiHover'));
      b.addEventListener('click', () => this.audio.play('uiClick'));
    });
    return root;
  }

  toast(text: string, ms = 2200): void {
    const el = document.getElementById('toast')!;
    el.innerHTML = `<div class="toast">${text}</div>`;
    setTimeout(() => (el.innerHTML = ''), ms);
  }

  menu(): void {
    this.inDuel = false;
    this.scene.stop();
    this.scene.setIdleVisible(true);
    this.audio.music('menu');
    const el = this.show(`<div class="menu">
      <h1>SIGILFALL</h1><div class="sub">draw the sigil &middot; read your rival &middot; break the Hollow</div>
      <button class="btn primary" data-a="play">Duel the Magister</button>
      <button class="btn" data-a="practice">Practice Sanctum</button>
      <button class="btn" data-a="online">Multiplayer</button>
      <button class="btn" data-a="settings">Settings</button>
      <button class="btn" data-a="credits">Credits</button>
      <div class="sub" style="margin-top:14px;font-size:11px;letter-spacing:.2em">${stats.get().wins} wins &middot; ${stats.get().losses} losses</div>
    </div>`);
    el.querySelector('[data-a=play]')!.addEventListener('click', () => this.chooseDifficulty());
    el.querySelector('[data-a=practice]')!.addEventListener('click', () => this.practice.open());
    el.querySelector('[data-a=online]')!.addEventListener('click', () => this.online.open());
    el.querySelector('[data-a=settings]')!.addEventListener('click', () => this.settingsPanel(() => this.menu()));
    el.querySelector('[data-a=credits]')!.addEventListener('click', () => this.credits());
  }

  private chooseDifficulty(): void {
    const el = this.show(`<div class="menu"><div class="panel"><h2>Choose your opponent</h2>
      <div class="cards">
        ${(['apprentice', 'adept', 'archmage'] as Difficulty[]).map((d) => `<button class="card ${d === this.difficulty ? 'sel' : ''}" data-d="${d}"><span class="g">${d === 'apprentice' ? '✦' : d === 'adept' ? '✶' : '☽'}</span><h3>${d[0]!.toUpperCase() + d.slice(1)}</h3>
          <p>${d === 'apprentice' ? 'Slow, predictable, never feints.' : d === 'adept' ? 'Reads you and punishes repeated spells.' : 'Fast reads, feints, baits Mirrorveil.'}</p></button>`).join('')}
      </div><p style="text-align:center;margin-top:14px">Best of 3 &middot; Magister Corvane Vael, the Hollow Magister</p>
      <div class="row"><button class="btn small" data-a="back">Back</button></div></div></div>`);
    el.querySelectorAll('[data-d]').forEach((b) =>
      b.addEventListener('click', () => {
        this.difficulty = (b as HTMLElement).dataset.d as Difficulty;
        settings.difficulty = this.difficulty;
        saveSettings();
        this.oathDraft((o) => this.startSolo(o));
      }),
    );
    el.querySelector('[data-a=back]')!.addEventListener('click', () => this.menu());
  }

  oathDraft(cb: (o: Oath) => void, title = 'Swear an Oath'): void {
    const el = this.show(`<div class="menu"><div class="panel"><h2>${title}</h2><p style="text-align:center">One passive for the whole match.</p>
      <div class="cards">${OATHS.map((o) => `<button class="card" data-o="${o}"><span class="g">${OATH_INFO[o].glyph}</span><h3>${OATH_INFO[o].name}</h3><p>${OATH_INFO[o].text}</p></button>`).join('')}</div></div></div>`);
    el.querySelectorAll('[data-o]').forEach((b) => b.addEventListener('click', () => cb((b as HTMLElement).dataset.o as Oath)));
  }

  private startSolo(oath: Oath): void {
    const driver = new LocalDriver({ difficulty: this.difficulty, oath });
    this.runDuel(driver);
  }

  runDuel(driver: Driver, opts: { enemyName?: string; online?: boolean } = {}): void {
    this.clear();
    this.driver = driver;
    this.isOnline = !!opts.online;
    this.inDuel = true;
    this.paused = false;
    this.scene.start(driver, { enemyName: opts.enemyName });
    this.scene.setIdleVisible(true);
    const tb = document.createElement('div');
    tb.className = 'toolbar';
    tb.innerHTML = `<button class="btn small" id="pausebtn">Pause</button>`;
    this.screen.appendChild(tb);
    tb.querySelector('button')!.addEventListener('click', () => this.pause());
    this.audio.play('roundStart');
    this.scene.hud.callout('FIGHT', '#cfe0ff');
    this.scene.hud.note('Hold to draw ▲ Cinder Bolt  ·  A / D to Blink', 'hint');
  }

  pause(): void {
    if (!this.inDuel || this.paused) return;
    this.paused = true;
    const online = this.isOnline;
    if (this.driver instanceof LocalDriver) this.driver.paused = true;
    this.scene.input.enabled = false;
    const el = this.show(`<div class="menu"><div class="panel" style="text-align:center"><h2>Paused</h2><div class="row" style="flex-direction:column;align-items:center">
      <button class="btn primary" data-a="resume">Resume</button>
      <button class="btn" data-a="settings">Settings</button>
      <button class="btn" data-a="quit">${online ? 'Leave match' : 'Forfeit to menu'}</button></div>
      ${online ? '<p>Online matches keep running while this menu is open.</p>' : ''}</div></div>`);
    el.querySelector('[data-a=resume]')!.addEventListener('click', () => this.resume());
    el.querySelector('[data-a=settings]')!.addEventListener('click', () => this.settingsPanel(() => this.pauseAgain()));
    el.querySelector('[data-a=quit]')!.addEventListener('click', () => this.quit());
  }

  private pauseAgain(): void {
    this.paused = false;
    this.pause();
  }

  private resume(): void {
    this.paused = false;
    if (this.driver instanceof LocalDriver) this.driver.paused = false;
    this.scene.input.enabled = !this.driver?.state.over;
    this.clear();
    const tb = document.createElement('div');
    tb.className = 'toolbar';
    tb.innerHTML = `<button class="btn small">Pause</button>`;
    this.screen.appendChild(tb);
    tb.querySelector('button')!.addEventListener('click', () => this.pause());
  }

  quit(): void {
    this.online.leave();
    this.practice.close();
    this.menu();
  }

  private roundOver(winner: PlayerId | null, reason: string): void {
    const d = this.driver;
    if (!d) return;
    if (this.isOnline) {
      this.online.roundOver(winner, reason);
      return;
    }
    if (!(d instanceof LocalDriver)) return;
    const seat = d.seat;
    const outcome = d.endRound();
    const m = d.match;
    const won = winner === seat;
    const title = winner === null ? 'DRAW' : won ? 'ROUND WON' : 'ROUND LOST';
    this.scene.hud.setPips(m.wins, seat, m.round);
    if (outcome === 'done') {
      const champ = m.winner === seat;
      const s = stats.get();
      stats.set({ wins: s.wins + (champ ? 1 : 0), losses: s.losses + (champ ? 0 : 1), rounds: s.rounds + m.round });
      const ds = d.state.w[seat].stats;
      const el = this.show(`<div class="result"><p class="bigtext" style="color:${champ ? '#ffd76a' : '#ff7a8a'}">${champ ? 'VICTORY' : 'DEFEAT'}</p>
        <div class="panel"><div class="kv"><span>Match</span><b>${m.wins[seat]} – ${m.wins[seat === 0 ? 1 : 0]}</b><span>Rounds</span><b>${m.round}</b><span>Last round damage dealt</span><b>${Math.round(ds.damageDealt)}</b>
        <span>Opponent</span><b>Corvane Vael · ${this.difficulty}</b></div></div>
        <div class="row"><button class="btn primary" data-a="again">Rematch</button><button class="btn" data-a="menu">Menu</button></div></div>`);
      el.querySelector('[data-a=again]')!.addEventListener('click', () => this.oathDraft((o) => this.startSolo(o)));
      el.querySelector('[data-a=menu]')!.addEventListener('click', () => this.menu());
      return;
    }
    const el = this.show(`<div class="result"><p class="bigtext" style="color:${winner === null ? '#cfe0ff' : won ? '#8fd4ff' : '#ff9aa6'}">${title}</p>
      <p>${reason === 'timeout' ? 'Time expired — higher Vitality wins.' : reason === 'ko' ? 'Knockout.' : ''}</p>
      <div class="kv"><span>Score</span><b>${m.wins[seat]} – ${m.wins[seat === 0 ? 1 : 0]}</b></div>
      <button class="btn primary" data-a="next">Next round</button></div>`);
    el.querySelector('[data-a=next]')!.addEventListener('click', () => {
      d.startNext();
      this.scene.newRound();
      this.resume();
    });
  }

  // ---- settings & credits ----------------------------------------------------------------------

  settingsPanel(back: () => void): void {
    const slider = (k: 'master' | 'sfx' | 'music', label: string) =>
      `<div class="setting"><span>${label}</span><input type="range" min="0" max="1" step="0.05" value="${settings[k]}" data-k="${k}"></div>`;
    const check = (k: 'mute' | 'clarity' | 'reducedMotion' | 'colorBlind' | 'clickToDraw' | 'pauseCast' | 'quickCast' | 'captions', label: string, hint = '') =>
      `<div class="setting"><span>${label}${hint ? `<br><small style="color:var(--dim)">${hint}</small>` : ''}</span><input type="checkbox" data-k="${k}" ${settings[k] ? 'checked' : ''}></div>`;
    const el = this.show(`<div class="menu"><div class="panel" style="width:min(640px,94vw)"><h2>Settings</h2>
      ${slider('master', 'Master volume')}${slider('sfx', 'Effects')}${slider('music', 'Music')}${check('mute', 'Mute')}
      ${check('captions', 'Sound captions', 'Subtitles for audio cues')}
      ${check('clarity', 'Clarity mode', 'Less bloom, shake and particles; stronger outlines')}
      ${check('reducedMotion', 'Reduced motion', 'Calms camera shake, slow-motion and flashes')}
      ${check('colorBlind', 'Colour-blind shapes', 'Adds shape icons to spells and telegraphs')}
      <div class="setting"><span>UI scale</span><input type="range" min="0.8" max="1.5" step="0.05" value="${settings.uiScale}" data-k="uiScale"></div>
      <div class="setting"><span>Sigil plane size</span><input type="range" min="0.8" max="1.5" step="0.05" value="${settings.planeScale}" data-k="planeScale"></div>
      ${check('clickToDraw', 'Click to start / click to finish', 'Instead of hold-to-draw')}
      ${check('pauseCast', 'Cast when the wand pauses', 'Releases the sigil after 250 ms of stillness')}
      ${check('quickCast', 'Quick-cast keys 1–8', 'Casts without drawing: +30% Aether, always Rough. Disabled online unless enabled by both')}
      <div class="setting"><span>Recognizer strictness</span><input type="range" min="0.85" max="1.15" step="0.01" value="${settings.strictness}" data-k="strictness"></div>
      <div class="row" style="margin-top:14px"><button class="btn" data-a="back">Back</button></div></div></div>`);
    el.querySelectorAll('input').forEach((inp) =>
      inp.addEventListener('input', () => {
        const k = inp.dataset.k as keyof typeof settings;
        (settings as unknown as Record<string, unknown>)[k] = inp.type === 'checkbox' ? inp.checked : Number(inp.value);
        saveSettings();
        this.applySettings();
      }),
    );
    el.querySelector('[data-a=back]')!.addEventListener('click', back);
  }

  private credits(): void {
    const el = this.show(`<div class="menu"><div class="panel" style="width:min(640px,94vw)"><h2>Credits</h2>
      <p><b>SIGILFALL</b> is an original game: characters, spells, symbols, art and audio are original or procedurally generated.</p>
      <div class="kv"><span>three.js</span><b>MIT</b><span>postprocessing (pmndrs)</span><b>Zlib</b><span>colyseus / colyseus.js</span><b>MIT</b><span>Vite · Vitest · TypeScript</span><b>MIT / Apache-2.0</b>
      <span>Gesture matching</span><b>$P point-cloud recognizer (Vatavu, Anthony, Wobbrock), re-implemented</b>
      <span>Audio</span><b>Procedural Web Audio synthesis (no third-party samples shipped)</b></div>
      <p>Full list with licences: CREDITS.md in the repository.</p>
      <div class="row"><button class="btn" data-a="back">Back</button></div></div></div>`);
    el.querySelector('[data-a=back]')!.addEventListener('click', () => this.menu());
  }
}
