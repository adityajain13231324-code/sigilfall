import * as THREE from 'three';
import type { DuelState, PlayerId, Projectile, StormStrike } from '@sigilfall/sim';
import { B } from '@sigilfall/sim';
import { canonical } from '@sigilfall/recognizer';
import { SPELL_INFO, SPELL_ORDER, TIER_COLOR, TIER_NAMES } from './theme';
import { settings } from './settings';

const ARC = 2 * Math.PI * 44;

const KIND_COLOR: Record<string, string> = { cinder: '#ff7a2a', blast: '#ffcf4a', lance: '#a36bff', shard: '#bfe6ff', eclipse: '#ffb020', storm: '#8ff6ff', dart: '#aaf6ff', riptide: '#3fd0c0', crescent: '#f2e6a0', fang: '#ff5a6a', meteor: '#ffa040' };
const KIND_ICON: Record<string, string> = { cinder: '▲', blast: '●', lance: '◉', shard: '⬡', eclipse: '∞', storm: 'ϟ', dart: 'V', riptide: '∿', crescent: '☾', fang: 'M', meteor: '★' };

function bracer(cls: string, label: string, color: string): string {
  return `<div class="bracer ${cls}">
    <svg viewBox="0 0 100 100"><circle class="bg" cx="50" cy="50" r="44"/><circle class="arc" cx="50" cy="50" r="44" stroke="${color}" stroke-dasharray="${ARC}" stroke-dashoffset="0"/></svg>
    <div class="val"><b>100</b><i>${label}</i></div><div class="cracks"></div>
  </div>`;
}

/** Mini SVG of a sigil with a dot at its start, for the in-duel cheat sheet. */
export function sigilSvg(sp: keyof typeof SPELL_INFO, size = 44): string {
  const info = SPELL_INFO[sp];
  const pts = canonical(info.shape, sp === 'umbra' ? 'ccw' : 'cw');
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${(6 + p.x * 32).toFixed(1)} ${(6 + p.y * 32).toFixed(1)}`).join(' ');
  const s0 = pts[0]!;
  return `<svg viewBox="0 0 44 44" width="${size}" height="${size}"><path d="${d}" fill="none" stroke="${info.css}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${(6 + s0.x * 32).toFixed(1)}" cy="${(6 + s0.y * 32).toFixed(1)}" r="3" fill="#fff"/></svg>`;
}

export function sigilSheetHtml(): string {
  return `<div class="sheet"><h2>Sigils</h2><div class="sheetgrid">${SPELL_ORDER.map((sp) => {
    const i = SPELL_INFO[sp];
    return `<div class="sig">${sigilSvg(sp)}<div><b style="color:${i.css}">${i.name}</b><small>${i.blurb.split('. ')[0]}.</small></div></div>`;
  }).join('')}</div><p class="sheethint">Hold to draw, release to cast. The white dot is a good place to start.</p></div>`;
}

export class Hud {
  private root: HTMLElement;
  private cap: HTMLElement;
  private els: Record<string, HTMLElement> = {};
  private chips = new Map<string, HTMLElement>();
  private lastCallout = 0;

  constructor(root: HTMLElement, captions: HTMLElement) {
    this.root = root;
    this.cap = captions;
    root.innerHTML = `
      <div class="enemybar"><div class="nm"><span id="h-name">Magister Corvane Vael</span><span class="orbsE" id="h-eorbs"></span></div>
        <div class="bar vit"><i id="h-evit"></i></div><div class="bar poise"><i id="h-epoise"></i></div><div class="fx" id="h-efx"></div></div>
      <div class="roundbox"><div class="pips" id="h-pips"></div><div class="clock" id="h-clock">2:00</div><div class="tide" id="h-tide"></div></div>
      ${bracer('left', 'VITALITY', '#ff6f7f')}
      ${bracer('right', 'AETHER', '#6fc2ff')}
      <div class="streak" id="h-streak"><b></b><b></b><b></b></div>
      <div class="orbslots"><button id="h-aurum" class="orb aurum" aria-label="Release Aurum orb (Q)"><b>●</b><i>Q</i></button><button id="h-umbra" class="orb umbra" aria-label="Release Umbra orb (E)"><b>○</b><i>E</i></button></div>
      <div class="lanes" id="h-lanes"><div class="lane"></div><div class="lane"></div><div class="lane"></div></div>
      <div class="statusrow" id="h-status"></div>
      <div class="ping" id="h-ping"></div>
      <div class="blinkpad"><button id="h-bl" aria-label="Blink left">◀</button><button id="h-br" aria-label="Blink right">▶</button></div>
      <div class="dmgfloat" id="h-float"></div>
      <div class="hurt" id="h-hurt"></div><div class="flashfx" id="h-flash"></div>`;
    for (const id of ['h-name', 'h-eorbs', 'h-evit', 'h-epoise', 'h-efx', 'h-pips', 'h-clock', 'h-tide', 'h-aurum', 'h-umbra', 'h-lanes', 'h-status', 'h-ping', 'h-float', 'h-hurt', 'h-flash', 'h-bl', 'h-br', 'h-streak']) {
      this.els[id] = root.querySelector('#' + id) as HTMLElement;
    }
    this.els.vit = root.querySelector('.bracer.left') as HTMLElement;
    this.els.aeth = root.querySelector('.bracer.right') as HTMLElement;
  }

  show(on: boolean): void {
    this.root.classList.toggle('hidden', !on);
  }

  bindActions(a: { orb: (w: 'aurum' | 'umbra') => void; blink: (visualDir: -1 | 1) => void }): void {
    this.els['h-aurum']!.onclick = () => a.orb('aurum');
    this.els['h-umbra']!.onclick = () => a.orb('umbra');
    this.els['h-bl']!.onclick = () => a.blink(-1);
    this.els['h-br']!.onclick = () => a.blink(1);
  }

  setEnemyName(n: string): void {
    this.els['h-name']!.textContent = n;
  }

  caption(spell: string, tier: string | null, extra = ''): void {
    const el = document.createElement('div');
    el.className = 'cap';
    const info = (SPELL_INFO as Record<string, { name: string; css: string; icon: string }>)[spell];
    const name = info ? info.name : spell;
    const col = info ? info.css : '#cfd8ee';
    el.innerHTML = `<span style="color:${col}">${settings.colorBlind && info ? info.icon + ' ' : ''}${name}</span>${tier ? ` <em style="color:${TIER_COLOR[tier as keyof typeof TIER_COLOR]}">${TIER_NAMES[tier as keyof typeof TIER_NAMES]}</em>` : ''}${extra ? `<small>${extra}</small>` : ''}`;
    this.cap.appendChild(el);
    setTimeout(() => el.classList.add('out'), 900);
    setTimeout(() => el.remove(), 1400);
    while (this.cap.children.length > 3) this.cap.firstElementChild?.remove();
  }

  note(text: string, kind = ''): void {
    const el = document.createElement('div');
    el.className = 'cap note ' + kind;
    el.textContent = text;
    this.cap.appendChild(el);
    setTimeout(() => el.classList.add('out'), 1100);
    setTimeout(() => el.remove(), 1700);
    while (this.cap.children.length > 3) this.cap.firstElementChild?.remove();
  }

  callout(text: string, color = '#ffd76a'): void {
    const now = performance.now();
    if (now - this.lastCallout < 200) return;
    this.lastCallout = now;
    const el = document.createElement('div');
    el.className = 'callout';
    el.style.color = color;
    el.textContent = text;
    this.root.appendChild(el);
    setTimeout(() => el.remove(), 1500);
  }

  hurt(amount: number): void {
    const el = this.els['h-hurt']!;
    el.style.opacity = String(Math.min(0.7, 0.25 + amount / 40));
    requestAnimationFrame(() => (el.style.transition = 'opacity .5s', (el.style.opacity = '0')));
    el.style.transition = 'none';
  }

  flash(color: string, a = 0.5): void {
    const el = this.els['h-flash']!;
    el.style.transition = 'none';
    el.style.background = color;
    el.style.opacity = String(a);
    requestAnimationFrame(() => requestAnimationFrame(() => (el.style.transition = 'opacity .35s', (el.style.opacity = '0'))));
  }

  floatText(text: string, world: THREE.Vector3, camera: THREE.Camera, color = '#fff'): void {
    const v = world.clone().project(camera);
    if (v.z > 1) return;
    const el = document.createElement('div');
    el.className = 'float';
    el.textContent = text;
    el.style.color = color;
    el.style.left = ((v.x * 0.5 + 0.5) * 100).toFixed(1) + '%';
    el.style.top = ((-v.y * 0.5 + 0.5) * 100).toFixed(1) + '%';
    this.els['h-float']!.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  setPing(ms: number | null): void {
    this.els['h-ping']!.textContent = ms === null ? '' : `${Math.round(ms)} ms`;
    this.els['h-ping']!.className = 'ping ' + (ms === null ? '' : ms < 80 ? 'good' : ms < 160 ? 'ok' : 'bad');
  }

  setPips(wins: [number, number], seat: PlayerId, round: number): void {
    const me = wins[seat];
    const foe = wins[seat === 0 ? 1 : 0];
    const pip = (n: number, cls: string) => Array.from({ length: B.roundsToWin }, (_, i) => `<b class="${cls} ${i < n ? 'on' : ''}"></b>`).join('');
    this.els['h-pips']!.innerHTML = `${pip(me, 'me')}<span>R${round}</span>${pip(foe, 'foe')}`;
  }

  update(s: DuelState, seat: PlayerId, viewTick: number, extras: { enemyOrbs: boolean }): void {
    const me = s.w[seat];
    const foe = s.w[seat === 0 ? 1 : 0];
    const setArc = (el: HTMLElement, f: number, text: string) => {
      (el.querySelector('.arc') as SVGElement).setAttribute('stroke-dashoffset', String(ARC * (1 - Math.max(0, Math.min(1, f)) * 0.75)));
      (el.querySelector('.val b') as HTMLElement).textContent = text;
    };
    setArc(this.els.vit!, me.vit / B.vitality, String(Math.ceil(me.vit)));
    setArc(this.els.aeth!, me.aether / B.aether, String(Math.floor(me.aether)));
    this.els['h-streak']!.querySelectorAll('b').forEach((b, i) => b.classList.toggle('on', me.overcharge || i < me.streak));
    this.els['h-streak']!.classList.toggle('full', me.overcharge);
    this.els.vit!.classList.toggle('low', me.vit < 30);
    this.els.aeth!.classList.toggle('low', me.aether < 20);
    // fatigue cracks + spellweave glow
    const stacks = me.fatigue;
    this.els.aeth!.dataset.cracks = String(Math.min(3, stacks));
    this.els.aeth!.classList.toggle('weave', s.tick < me.weaveUntil);
    (this.els['h-evit']!.style as CSSStyleDeclaration).width = `${Math.max(0, (foe.vit / B.vitality) * 100)}%`;
    (this.els['h-epoise']!.style as CSSStyleDeclaration).width = `${Math.max(0, (foe.poise / B.poise) * 100)}%`;
    this.els['h-epoise']!.parentElement!.classList.toggle('broken', foe.brokenUntil > s.tick);
    this.els['h-eorbs']!.innerHTML = (foe.orbs.aurum > s.tick ? '<b class="a">●</b>' : '') + (foe.orbs.umbra > s.tick ? '<b class="u">●</b>' : '');
    const fx: string[] = [];
    if (s.tick < foe.burnUntil) fx.push('<span style="color:#ff7a2a">BURN</span>');
    if (s.tick < foe.chillUntil) fx.push('<span style="color:#9fd8ff">CHILL</span>');
    if (s.tick < foe.aegisUntil) fx.push('<span style="color:#ffe08a">AEGIS</span>');
    if (foe.heal) fx.push('<span style="color:#7dffb0">MENDING</span>');
    if (foe.ward) fx.push('<span style="color:#9fd8ff">WARD</span>');
    if (foe.mirror) fx.push('<span style="color:#dfe8f5">MIRROR</span>');
    this.els['h-efx']!.innerHTML = fx.join(' ');
    const left = Math.max(0, Math.ceil((s.roundTicks - s.tick) / B.tickRate));
    this.els['h-clock']!.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    if (s.tide && s.tick < s.tide.until) {
      const i = SPELL_INFO[s.tide.spell];
      this.els['h-tide']!.innerHTML = `<span style="color:${i.css}">${settings.colorBlind ? i.icon + ' ' : ''}${i.short} Tide  −30% cost</span>`;
    } else {
      const next = Math.max(0, Math.ceil((s.nextTide - s.tick) / B.tickRate));
      this.els['h-tide']!.innerHTML = `<small>Tide in ${next}s</small>`;
    }
    this.els['h-aurum']!.classList.toggle('held', me.orbs.aurum > s.tick);
    this.els['h-umbra']!.classList.toggle('held', me.orbs.umbra > s.tick);
    const status: string[] = [];
    if (s.tick < me.burnUntil) status.push('<span style="color:#ff7a2a">BURNING</span>');
    if (s.tick < me.chillUntil) status.push('<span style="color:#9fd8ff">CHILLED</span>');
    if (me.brokenUntil > s.tick) status.push('<span style="color:#ff6f7f">POISE BROKEN</span>');
    if (s.tick < me.weaveUntil) status.push('<span style="color:#8fffb0">SPELLWEAVE</span>');
    if (me.overcharge) status.push('<span style="color:#ffd76a">OVERCHARGED</span>');
    if (s.tick < me.focusUntil) status.push('<span style="color:#9fe8ff">FOCUS</span>');
    if (s.tick < me.aegisUntil) status.push('<span style="color:#ffe08a">AEGIS</span>');
    if (me.heal) status.push('<span style="color:#7dffb0">MENDING</span>');
    if (stacks > 0) status.push(`<span style="color:#ffb86f">FATIGUE ×${stacks}</span>`);
    this.els['h-status']!.innerHTML = status.join('');

    // incoming-attack telegraphs: lane highlight + icon + shrinking countdown ring
    const lanesEl = this.els['h-lanes']!;
    const seen = new Set<string>();
    const add = (key: string, lane: number, etaTicks: number, total: number, kind: string) => {
      seen.add(key);
      let el = this.chips.get(key);
      if (!el) {
        el = document.createElement('div');
        el.className = 'chip';
        el.innerHTML = `<svg viewBox="0 0 40 40"><circle class="bg" cx="20" cy="20" r="17"/><circle class="rg" cx="20" cy="20" r="17" stroke-dasharray="107"/></svg><b>${KIND_ICON[kind] ?? '!'}</b>`;
        el.style.setProperty('--c', KIND_COLOR[kind] ?? '#fff');
        this.chips.set(key, el);
      }
      const col = seat === 0 ? lane : 2 - lane;
      if (el.parentElement !== lanesEl.children[col]) lanesEl.children[col]!.appendChild(el);
      (el.querySelector('.rg') as SVGElement).setAttribute('stroke-dashoffset', String(107 * (1 - Math.max(0, Math.min(1, etaTicks / total)))));
      el.classList.toggle('urgent', etaTicks < 9);
      el.classList.toggle('mine', lane === me.lane);
      if (!settings.colorBlind) (el.querySelector('b') as HTMLElement).style.opacity = '0.0';
    };
    for (const pr of s.projectiles as Projectile[]) {
      if (pr.owner === seat) continue;
      add('p' + pr.id, pr.lane, pr.arrive - viewTick, pr.arrive - pr.born, pr.kind);
    }
    for (const st of s.strikes as StormStrike[]) {
      if (st.owner === seat) continue;
      add('s' + st.id, st.lane, st.hit - viewTick, st.hit - st.born, st.meteor ? 'meteor' : 'storm');
    }
    for (const [k, el] of this.chips) {
      if (!seen.has(k)) {
        el.remove();
        this.chips.delete(k);
      }
    }
    lanesEl.querySelectorAll('.lane').forEach((l, i) => l.classList.toggle('me', (seat === 0 ? me.lane : 2 - me.lane) === i));
    void extras;
  }
}
