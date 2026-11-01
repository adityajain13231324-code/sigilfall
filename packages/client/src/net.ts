import type { AppApi } from './app';
export class Online {
  constructor(private app: AppApi) {}
  open(): void { this.app.menu(); }
  leave(): void {}
  roundOver(_w: number | null, _r: string): void {}
}
