import type { Pt } from '@sigilfall/recognizer';
import type { SpellId } from '@sigilfall/sim';
import type { SigilPlane } from './trail';
import { settings } from './settings';

export interface InputCallbacks {
  onDrawStart(): void;
  onDrawPoint(p: Pt, t: number): void;
  onDrawEnd(stroke: Pt[], cancelled: boolean): void;
  onBlink(visualDir: -1 | 1): void;
  onOrb(which: 'aurum' | 'umbra'): void;
  onQuick(spell: SpellId): void;
  onPause(): void;
  onLook(nx: number, ny: number): void;
}

const QUICK: Record<string, SpellId> = { '1': 'cinder', '2': 'storm', '3': 'ward', '4': 'mirror', '5': 'gravewell', '6': 'aurum', '7': 'umbra', '8': 'eclipse' };

export class Input {
  enabled = false;
  private drawing = false;
  private pointerId = -1;
  private stroke: Pt[] = [];
  private t0 = 0;
  private lastMove = 0;
  private pauseTimer = 0;
  private edgeStart: { x: number; id: number } | null = null;
  private lastPx = { x: 0, y: 0 };

  constructor(private el: HTMLElement, private plane: SigilPlane, private cb: InputCallbacks) {
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.move);
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.key);
  }

  dispose(): void {
    this.el.removeEventListener('pointerdown', this.down);
    this.el.removeEventListener('pointermove', this.move);
    this.el.removeEventListener('pointerup', this.up);
    this.el.removeEventListener('pointercancel', this.up);
    window.removeEventListener('keydown', this.key);
  }

  get isDrawing(): boolean {
    return this.drawing;
  }

  /** abort any stroke in progress without casting (e.g. when a round ends) */
  abort(): void {
    if (this.drawing) {
      this.drawing = false;
      this.stroke = [];
      this.cb.onDrawEnd([], true);
    }
  }

  private begin(e: PointerEvent): void {
    this.drawing = true;
    this.pointerId = e.pointerId;
    this.stroke = [];
    this.t0 = performance.now();
    try { this.el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    this.cb.onDrawStart();
    this.push(e.clientX, e.clientY, e.timeStamp);
  }

  private push(x: number, y: number, ts: number): void {
    const t = performance.now() - this.t0;
    void ts;
    const p = this.plane.toPlane(x, y);
    p.t = t;
    this.lastPx = { x, y };
    this.stroke.push(p);
    this.lastMove = performance.now();
    this.cb.onDrawPoint(p, t);
  }

  private finish(cancelled: boolean): void {
    if (!this.drawing) return;
    this.drawing = false;
    clearTimeout(this.pauseTimer);
    const s = this.stroke;
    this.stroke = [];
    this.cb.onDrawEnd(s, cancelled);
  }

  private down = (e: PointerEvent): void => {
    if (!this.enabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if ((e.target as HTMLElement).closest('button, a, input, select, .panel')) return;
    if (settings.clickToDraw && this.drawing) {
      this.finish(!this.plane.inside(e.clientX, e.clientY, 1.05));
      return;
    }
    if (this.plane.inside(e.clientX, e.clientY, 1.45)) {
      this.begin(e);
    } else if (e.pointerType === 'touch' && (e.clientX < innerWidth * 0.14 || e.clientX > innerWidth * 0.86)) {
      this.edgeStart = { x: e.clientX, id: e.pointerId };
    }
  };

  private move = (e: PointerEvent): void => {
    this.cb.onLook((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
    if (this.edgeStart && e.pointerId === this.edgeStart.id) {
      const dx = e.clientX - this.edgeStart.x;
      if (Math.abs(dx) > 56) {
        this.cb.onBlink(dx < 0 ? -1 : 1);
        this.edgeStart = null;
      }
      return;
    }
    if (!this.drawing || e.pointerId !== this.pointerId && !settings.clickToDraw) return;
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    if (list.length) for (const c of list) this.push(c.clientX, c.clientY, c.timeStamp);
    else this.push(e.clientX, e.clientY, e.timeStamp);
    if (settings.pauseCast) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = window.setTimeout(() => {
        if (this.drawing && this.stroke.length > 12) this.finish(false);
      }, 250);
    }
  };

  private up = (e: PointerEvent): void => {
    if (this.edgeStart && e.pointerId === this.edgeStart.id) this.edgeStart = null;
    if (!this.drawing || settings.clickToDraw) return;
    if (e.pointerId !== this.pointerId) return;
    const out = !this.plane.inside(e.clientX, e.clientY, 1.08);
    this.finish(out && this.stroke.length > 3);
  };

  private key = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') return this.cb.onPause();
    if (!this.enabled) return;
    if (k === 'a' || k === 'arrowleft') this.cb.onBlink(-1);
    else if (k === 'd' || k === 'arrowright') this.cb.onBlink(1);
    else if (k === 'q') this.cb.onOrb('aurum');
    else if (k === 'e') this.cb.onOrb('umbra');
    else if (QUICK[k]) this.cb.onQuick(QUICK[k]!);
  };

  get pointerPx(): { x: number; y: number } {
    return this.lastPx;
  }
  get lastMoveAt(): number {
    return this.lastMove;
  }
}
