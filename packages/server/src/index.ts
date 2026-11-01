import http from 'node:http';
import { Server, Room, Client, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { PlayerId, TICK_RATE } from '@sigilfall/sim';
import { DuelHost } from './duelcore';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const makeCode = (): string => Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

export class DuelRoom extends Room {
  override maxClients = 2;
  private host = new DuelHost();
  private seats = new Map<string, PlayerId>();

  override onCreate(options: { private?: boolean }): void {
    if (options?.private) {
      this.roomId = makeCode(); // the room code doubles as the room id
      this.setPrivate(true);
    }
    this.setMetadata({ private: !!options?.private });
    this.onMessage('*', (client: Client, type: string | number, message: unknown) => {
      if (type === 'ping') {
        client.send('pong', { t: (message as { t?: number } | null)?.t ?? 0 });
        return;
      }
      const seat = this.seats.get(client.sessionId);
      if (seat === undefined || typeof type !== 'string') return;
      this.host.message(seat, type, message);
    });
    this.setSimulationInterval(() => {
      const snap = this.host.tick();
      this.broadcast('snap', snap);
    }, 1000 / TICK_RATE);
  }

  override onJoin(client: Client, options: { custom?: unknown; quick?: boolean } = {}): void {
    const taken = new Set(this.seats.values());
    const seat: PlayerId = taken.has(0) ? 1 : 0;
    this.seats.set(client.sessionId, seat);
    this.host.join(seat, options);
    client.send('seat', { seat, code: this.roomId });
    if (this.clients.length >= 2) void this.lock();
  }

  override async onLeave(client: Client, consented: boolean): Promise<void> {
    const seat = this.seats.get(client.sessionId);
    if (seat === undefined) return;
    this.host.leave(seat);
    if (!consented && this.host.match && this.host.phase !== 'matchEnd') {
      try {
        await this.allowReconnection(client, 20);
        this.host.join(seat);
        client.send('seat', { seat, code: this.roomId });
        return;
      } catch {
        /* did not come back */
      }
    }
    this.host.forfeit(seat);
    this.seats.delete(client.sessionId);
  }
}

export function start(port = Number(process.env.PORT ?? 2567)): Server {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200).end('ok');
      return;
    }
  });
  const gameServer = new Server({ transport: new WebSocketTransport({ server }) });
  gameServer.define('duel', DuelRoom);
  void gameServer.listen(port).then(() => console.log(`SIGILFALL server listening on :${port}`));
  void matchMaker;
  return gameServer;
}

if (process.argv[1] && /server[\\/]src[\\/]index\.ts$/.test(process.argv[1].replace(/\\/g, '/').replace(/\//g, '/'))) start();
