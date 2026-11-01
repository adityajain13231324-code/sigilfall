import type { SpellId } from '@sigilfall/sim';
import type { Shape } from '@sigilfall/recognizer';

export interface SpellInfo {
  id: SpellId;
  name: string;
  short: string;
  color: number;
  css: string;
  icon: string; // shape-coding glyph for the colour-blind palette
  shape: Shape;
  blurb: string;
  counters: string;
}

export const SPELL_INFO: Record<SpellId, SpellInfo> = {
  cinder: { id: 'cinder', name: 'Cinder Bolt', short: 'Cinder', color: 0xff7a2a, css: '#ff7a2a', icon: '▲', shape: 'triangle', blurb: 'Fast fire bolt along one lane. Burns for 2 damage a second.', counters: 'Beaten by Glacier Ward and a timed Blink. Mirrorveil sends it back.' },
  storm: { id: 'storm', name: 'Stormfork', short: 'Storm', color: 0x8ff6ff, css: '#8ff6ff', icon: 'ϟ', shape: 'zigzag', blurb: 'Marks a lane; lightning lands after the telegraph. Half of it ignores Ward and it staggers casters.', counters: 'Dodge by leaving the lane. Cannot be reflected.' },
  ward: { id: 'ward', name: 'Glacier Ward', short: 'Ward', color: 0x9fd8ff, css: '#9fd8ff', icon: '⬡', shape: 'arch', blurb: 'A crystal wall across all lanes that absorbs 30 damage for 4 seconds. Shatters into shards.', counters: 'Fire does x1.5. Stormfork punches through. Eclipse annihilates it.' },
  mirror: { id: 'mirror', name: 'Mirrorveil', short: 'Mirror', color: 0xdfe8f5, css: '#dfe8f5', icon: '◇', shape: 'diamond', blurb: 'Reflects the first projectile for 0.7s. Catch nothing and you are exhausted.', counters: 'Loses to feints and non-projectile effects like Stormfork.' },
  gravewell: { id: 'gravewell', name: 'Gravewell', short: 'Gravewell', color: 0x9b5cff, css: '#9b5cff', icon: '◉', shape: 'spiral', blurb: 'Collapses incoming projectiles, pops enemy orbs and interrupts a channel. You are open for 1s.', counters: 'Long cooldown (10s) and a heavy windup.' },
  aurum: { id: 'aurum', name: 'Aurum Orb', short: 'Aurum', color: 0xffcf4a, css: '#ffcf4a', icon: '●', shape: 'circle', blurb: 'Draw a circle clockwise. A gold orb you can fire as a Knockback Blast that shoves one lane and cancels a draw.', counters: 'Visible to the opponent. Gravewell pops it.' },
  umbra: { id: 'umbra', name: 'Umbra Orb', short: 'Umbra', color: 0xa36bff, css: '#a36bff', icon: '○', shape: 'circle', blurb: 'Draw a circle counter-clockwise. A violet orb that fires a Pull Lance, dragging incoming projectiles aside.', counters: 'Visible to the opponent. Gravewell pops it.' },
  dart: { id: 'dart', name: 'Piercing Dart', short: 'Dart', color: 0xaaf6ff, css: '#aaf6ff', icon: 'V', shape: 'vee', blurb: 'A very fast needle of light. Weak, cheap, and it slips straight through Glacier Ward.', counters: 'Blink, Mirrorveil, or just out-trade it with bigger spells.' },
  riptide: { id: 'riptide', name: 'Riptide Lash', short: 'Riptide', color: 0x3fd0c0, css: '#3fd0c0', icon: '∿', shape: 'wave', blurb: 'Draw a wave. A water bolt that Chills the target: their casting is 25% slower for 3 seconds.', counters: 'Ward absorbs it; reflect it to chill the caster instead.' },
  heal: { id: 'heal', name: 'Mending Light', short: 'Mend', color: 0x7dffb0, css: '#7dffb0', icon: '♥', shape: 'heart', blurb: 'Draw a heart. Restores 24 Vitality over 2 seconds and douses Burn. Long cooldown.', counters: 'The windup is a window to punish; Stormfork interrupts it.' },
  aegis: { id: 'aegis', name: 'Aegis', short: 'Aegis', color: 0xffe08a, css: '#ffe08a', icon: '▢', shape: 'square', blurb: 'Draw a square. For 4 seconds you take 40% less damage and half the Poise damage.', counters: 'Gravewell and Eclipse still hurt; wait it out or burn it down with Starfall.' },
  crescent: { id: 'crescent', name: 'Moonblade', short: 'Moon', color: 0xf2e6a0, css: '#f2e6a0', icon: '☾', shape: 'crescent', blurb: 'Draw a C. A wide blade that hits your lane and the neighbouring lanes. One Blink is not enough.', counters: 'Ward, Mirrorveil, or Blink two lanes away.' },
  starfall: { id: 'starfall', name: 'Starfall', short: 'Starfall', color: 0xffa040, css: '#ffa040', icon: '★', shape: 'star', blurb: 'Draw a star. Meteors mark all three lanes and land one after another. Keep moving.', counters: 'Ward absorbs them; time your Blinks between impacts.' },
  fangs: { id: 'fangs', name: 'Twin Fangs', short: 'Fangs', color: 0xff5a6a, css: '#ff5a6a', icon: 'M', shape: 'em', blurb: 'Draw an M. Two fangs strike different lanes at different speeds.', counters: 'Mirrorveil catches one; dodge the other.' },
  eclipse: { id: 'eclipse', name: 'Eclipse Rend', short: 'Eclipse', color: 0xffb020, css: '#ffb020', icon: '∞', shape: 'infinity', blurb: 'Hold both orbs and draw a figure-eight. Channel 2.5s, then 55 damage and a Poise break.', counters: 'Gravewell collapses it. Stormfork or Aurum interrupt the channel. Blink late.' },
};

export const SPELL_ORDER: SpellId[] = ['cinder', 'dart', 'storm', 'fangs', 'riptide', 'crescent', 'ward', 'aegis', 'mirror', 'heal', 'starfall', 'gravewell', 'aurum', 'umbra', 'eclipse'];

export const FAMILY_COLOR: Record<string, number> = { warm: 0xffa040, cold: 0x8fe6ff, silver: 0xe6eefc, dark: 0xa070ff };
export const LANE_NAMES = ['Left', 'Center', 'Right'];
export const TIER_NAMES = { rough: 'Rough', clean: 'Clean', perfect: 'Perfect' } as const;

export const OATH_INFO = {
  embers: { name: 'Oath of Embers', text: 'Burns last 1s longer. Cinder windup is 0.05s shorter.', glyph: '▲' },
  stillness: { name: 'Oath of Stillness', text: 'Mirrorveil exhaustion halved. Glacier Ward absorbs 5 more.', glyph: '◇' },
  echoes: { name: 'Oath of Echoes', text: 'After a Perfect cast, your next spell costs 20% less.', glyph: '∞' },
} as const;

export const TIER_COLOR = { rough: '#9aa3b5', clean: '#e8eefc', perfect: '#ffd76a' } as const;
