import { Client, Room } from 'colyseus.js';
import type { Cmd, DuelState, MatchState, PlayerId, SimEvent } from '@sigilfall/sim';
import type { AppApi } from './app';
import type { Driver } from './driver';
import { settings, store } from './settings';
import { OATH_INFO } from './theme';

interface Snap {
  phase: 'waiting' | 'draft' | 'countdown' | 'fight' | 'roundEnd' | 'matchEnd';
  countdown: number;
  round: number;
  wins: [number, number];
  state: DuelState;
  events: SimEvent[];
  winner: PlayerId | null;
  rematch: [boolean, boolean];
  connected: [boolean, boolean];
}

const urlStore = store<string>('server.url', '');

function defaultUrl(): string {
  const saved = urlStore.get();
  if (saved) return saved;
  const secure = location.protocol === 'https:';
  return `${secure ? 'wss' : 'ws'}://${location.hostname || 'localhost'}:2567`;
}

/** Driver whose truth lives on the server; the client only renders snapshots and sends inputs. */
export class NetDriver implements Driver {
  seat: PlayerId = 0;
  state: DuelState;
  alpha = 0;
  ping: number | null = null;
  timeScale = 1;
  match: MatchState | null = null;
  snap: Snap | null = null;
  private queue: SimEvent[] = [];
  private at = performance.now();
  private pendingStroke: number[] | null = null;
  private pingTimer = 0;

  constructor(private room: Room, init: Snap) {
    this.state = init.state;
    this.apply(init);
    this.pingTimer = window.setInterval(() => room.send('ping', { t: performance.now() }), 2000);
    room.onMessage('pong', (m: { t: number }) => {
      const rtt = performance.now() - m.t;
      this.ping = this.ping === null ? rtt : this.ping * 0.7 + rtt * 0.3;
    });
  }

  apply(s: Snap): void {
    this.snap = s;
    this.state = s.state;
    this.at = performance.now();
    this.match = { round: s.round, wins: s.wins, oaths: [null, null], seed: 0, duel: s.state, winner: s.winner, done: s.phase === 'matchEnd' };
    if (s.events.length) this.queue.push(...s.events);
  }

  update(): SimEvent[] {
    // interpolate ~one snapshot behind so entities glide between 30 Hz updates
    this.alpha = Math.min(1, (performance.now() - this.at) / (1000 / 30));
    const out = this.queue;
    this.queue = [];
    return out;
  }

  sendStroke(packed: number[]): void {
    this.pendingStroke = packed;
  }

  send(c: Cmd): void {
    if (c.t === 'cast') {
      if (c.quick && c.spell) this.room.send('cast', { quick: c.spell });
      else if (c.spell === null) this.room.send('cast', { fizzle: true });
      else if (this.pendingStroke) this.room.send('cast', { stroke: this.pendingStroke });
      this.pendingStroke = null;
      return;
    }
    if (c.t === 'oath') return;
    this.room.send('cmd', c);
  }

  dispose(): void {
    clearInterval(this.pingTimer);
  }
}

export class Online {
  private room: Room | null = null;
  private driver: NetDriver | null = null;
  private phase = '';
  private round = -1;
  private inDuel = false;

  constructor(private app: AppApi) {}

  open(): void {
    const el = this.app.show(`<div class="menu lobby"><div class="panel" style="width:min(560px,94vw);text-align:center"><h2>Multiplayer</h2>
      <p>Best of 3 against another wizard. The server judges every sigil.</p>
      <div class="row" style="flex-direction:column;align-items:center">
        <button class="btn primary" data-a="quick">Quick match</button>
        <button class="btn" data-a="create">Create private room</button>
        <div class="row"><input id="code" maxlength="6" placeholder="CODE" autocomplete="off"><button class="btn" data-a="join">Join</button></div>
      </div>
      <div class="setting" style="margin-top:14px"><span>Server</span><input id="srv" style="width:230px;font-size:13px;letter-spacing:0;text-transform:none" value="${defaultUrl()}"></div>
      <p id="msg" style="min-height:22px"></p>
      <div class="row"><button class="btn small" data-a="back">Back</button></div></div></div>`);
    const msg = (t: string) => ((el.querySelector('#msg') as HTMLElement).textContent = t);
    const url = () => {
      const v = (el.querySelector('#srv') as HTMLInputElement).value.trim();
      urlStore.set(v);
      return v;
    };
    const run = async (fn: (c: Client) => Promise<Room>) => {
      msg('Connecting…');
      try {
        const room = await fn(new Client(url()));
        await this.attach(room);
      } catch (e) {
        msg('Could not connect: ' + ((e as Error).message || 'is the server running? (npm run dev:server)'));
      }
    };
    const opts = () => ({ custom: this.app.scene.custom.map((t) => ({ shape: t.shape, pts: t.pts })), quick: settings.quickCast });
    el.querySelector('[data-a=quick]')!.addEventListener('click', () => run((c) => c.joinOrCreate('duel', opts())));
    el.querySelector('[data-a=create]')!.addEventListener('click', () => run((c) => c.create('duel', { ...opts(), private: true })));
    el.querySelector('[data-a=join]')!.addEventListener('click', () => {
      const code = (el.querySelector('#code') as HTMLInputElement).value.trim().toUpperCase();
      if (code.length !== 6) return msg('Enter the 6-character room code');
      void run((c) => c.joinById(code, opts()));
    });
    el.querySelector('[data-a=back]')!.addEventListener('click', () => this.app.menu());
  }

  private async attach(room: Room): Promise<void> {
    this.room = room;
    this.phase = '';
    this.round = -1;
    this.inDuel = false;
    let code = room.roomId;
    let seat: PlayerId = 0;
    let driver: NetDriver | null = null;
    let first: Snap | null = null;
    room.onMessage('seat', (m: { seat: PlayerId; code: string }) => {
      seat = m.seat;
      code = m.code;
      if (driver) driver.seat = seat;
      if (!this.driver && !first) this.waiting(code, false);
    });
    room.onMessage('snap', (s: Snap) => {
      if (!driver) {
        first = s;
        driver = new NetDriver(room, s);
        driver.seat = seat;
        this.driver = driver;
      } else {
        driver.apply(s);
      }
      this.onSnap(s, driver);
    });
    room.onLeave((c: number) => {
      if (c !== 1000 && this.room === room) this.tryReconnect(room);
    });
    this.waiting(code, false);
  }

  private async tryReconnect(old: Room): Promise<void> {
    const token = old.reconnectionToken;
    this.app.scene.hud.note('Connection lost — reconnecting…', 'warn');
    const deadline = Date.now() + 20000;
    const client = new Client((document.querySelector('#srv') as HTMLInputElement | null)?.value || defaultUrl());
    while (Date.now() < deadline && this.room === old) {
      try {
        const room = await client.reconnect(token);
        this.room = room;
        const d = this.driver;
        room.onMessage('snap', (s: Snap) => {
          d?.apply(s);
          if (d) this.onSnap(s, d);
        });
        room.onMessage('seat', () => {});
        room.onLeave((c: number) => {
          if (c !== 1000 && this.room === room) void this.tryReconnect(room);
        });
        this.app.scene.hud.note('Reconnected', 'good');
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    this.app.toast('Disconnected from the server');
    this.leave();
    this.app.menu();
  }

  private waiting(code: string, quick: boolean): void {
    void quick;
    const isPrivate = code.length === 6 && /^[A-Z0-9]{6}$/.test(code);
    const el = this.app.show(`<div class="menu"><div class="panel" style="text-align:center;width:min(480px,94vw)"><h2>Waiting for an opponent</h2>
      ${isPrivate ? `<p>Share this room code:</p><div class="code">${code}</div>` : '<p>Searching for another wizard…</p>'}
      <div class="row"><button class="btn" data-a="leave">Cancel</button></div></div></div>`);
    el.querySelector('[data-a=leave]')!.addEventListener('click', () => {
      this.leave();
      this.app.menu();
    });
  }

  private onSnap(s: Snap, d: NetDriver): void {
    const changed = s.phase !== this.phase || s.round !== this.round;
    const scene = this.app.scene;
    if (s.phase === 'countdown') {
      if (changed) {
        if (!this.inDuel) {
          this.inDuel = true;
          this.app.runDuel(d, { online: true, enemyName: 'Rival Wizard' });
        } else {
          scene.newRound();
          this.app.clear();
          this.addToolbar();
        }
        scene.input.enabled = false;
      }
      const n = Math.ceil(s.countdown / 30);
      if (n > 0 && n !== this.lastCount) {
        this.lastCount = n;
        scene.hud.callout(String(n), '#cfe0ff');
      }
    } else if (s.phase === 'fight') {
      if (changed) {
        scene.input.enabled = true;
        scene.hud.callout('FIGHT', '#ffd76a');
      }
    } else if (s.phase === 'draft' && changed) {
      this.inDuel = this.inDuel && false;
      scene.stop();
      this.app.oathDraft((o) => {
        this.room?.send('pickOath', { oath: o });
        this.app.show(`<div class="menu"><div class="panel" style="text-align:center"><h2>${OATH_INFO[o].name}</h2><p>Waiting for your opponent to choose…</p></div></div>`);
      });
    } else if (s.phase === 'matchEnd' && changed) {
      // wait for the killcam callback; if the match ended by forfeit there is no 'over' event
      window.setTimeout(() => {
        if (this.phase === 'matchEnd' && !document.querySelector('.result')) this.matchEnd(s, d);
      }, 3500);
    }
    if (!s.connected[0] || !s.connected[1]) {
      if (s.phase === 'fight' || s.phase === 'countdown') scene.hud.note('Opponent disconnected — waiting up to 20s…', 'warn');
    }
    this.phase = s.phase;
    this.round = s.round;
  }
  private lastCount = 0;

  private addToolbar(): void {
    const tb = document.createElement('div');
    tb.className = 'toolbar';
    tb.innerHTML = '<button class="btn small">Menu</button>';
    tb.querySelector('button')!.addEventListener('click', () => this.app.pause());
    this.app.screen.appendChild(tb);
  }

  roundOver(winner: PlayerId | null, reason: string): void {
    const d = this.driver;
    if (!d) return;
    const s = d.snap!;
    if (s.phase === 'matchEnd') return this.matchEnd(s, d);
    const me = d.seat;
    const won = winner === me;
    this.app.show(`<div class="result"><p class="bigtext" style="color:${winner === null ? '#cfe0ff' : won ? '#8fd4ff' : '#ff9aa6'}">${winner === null ? 'DRAW' : won ? 'ROUND WON' : 'ROUND LOST'}</p>
      <p>${reason === 'timeout' ? 'Time expired — higher Vitality wins.' : 'Knockout.'}</p><div class="kv"><span>Score</span><b>${s.wins[me]} – ${s.wins[me === 0 ? 1 : 0]}</b></div><p>Next round starting…</p></div>`);
  }

  private matchEnd(s: Snap, d: NetDriver): void {
    const me = d.seat;
    const champ = s.winner === me;
    const el = this.app.show(`<div class="result"><p class="bigtext" style="color:${champ ? '#ffd76a' : '#ff7a8a'}">${champ ? 'VICTORY' : 'DEFEAT'}</p>
      <div class="kv"><span>Match</span><b>${s.wins[me]} – ${s.wins[me === 0 ? 1 : 0]}</b></div>
      <div class="row"><button class="btn primary" data-a="again">Rematch</button><button class="btn" data-a="menu">Menu</button></div></div>`);
    el.querySelector('[data-a=again]')!.addEventListener('click', () => {
      this.room?.send('rematch', {});
      (el.querySelector('[data-a=again]') as HTMLButtonElement).textContent = 'Waiting for opponent…';
    });
    el.querySelector('[data-a=menu]')!.addEventListener('click', () => {
      this.leave();
      this.app.menu();
    });
  }

  leave(): void {
    const r = this.room;
    this.room = null;
    this.driver?.dispose();
    this.driver = null;
    this.inDuel = false;
    this.phase = '';
    try {
      void r?.leave();
    } catch {
      /* already closed */
    }
  }
}
