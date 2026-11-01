export type Difficulty = 'apprentice' | 'adept' | 'archmage';

export interface Settings {
  master: number;
  sfx: number;
  music: number;
  mute: boolean;
  clarity: boolean;
  reducedMotion: boolean;
  colorBlind: boolean;
  uiScale: number;
  planeScale: number;
  clickToDraw: boolean;
  pauseCast: boolean;
  quickCast: boolean;
  captions: boolean;
  strictness: number;
  difficulty: Difficulty;
  view: 'third' | 'first';
}

const DEFAULTS: Settings = {
  master: 0.8, sfx: 0.9, music: 0.5, mute: false, clarity: false,
  reducedMotion: typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  colorBlind: false, uiScale: 1, planeScale: 1, clickToDraw: false, pauseCast: false, quickCast: false,
  captions: false, strictness: 1, difficulty: 'apprentice', view: 'third',
};

const KEY = 'sigilfall.settings.v1';
const listeners = new Set<() => void>();

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* private mode */
  }
  return { ...DEFAULTS };
}

export const settings: Settings = load();

export function saveSettings(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
  for (const l of listeners) l();
}

export function onSettings(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function store<T>(key: string, fallback: T): { get(): T; set(v: T): void } {
  const k = 'sigilfall.' + key;
  return {
    get() {
      try {
        const raw = localStorage.getItem(k);
        return raw ? (JSON.parse(raw) as T) : fallback;
      } catch {
        return fallback;
      }
    },
    set(v: T) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {
        /* ignore */
      }
    },
  };
}
