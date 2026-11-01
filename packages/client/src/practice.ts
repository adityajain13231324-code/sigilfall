import type { AppApi } from './app';
export class Practice {
  constructor(private app: AppApi) {}
  open(): void { this.app.menu(); }
  close(): void {}
}
