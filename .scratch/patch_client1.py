import os
root = os.getcwd()

def edit(path, pairs):
    p = os.path.join(root, path)
    s = open(p, encoding='utf-8').read()
    for a, b in pairs:
        assert a in s, (path, a[:80])
        s = s.replace(a, b, 1)
    open(p, 'w', encoding='utf-8').write(s)

# --- sim: meteor flag on strike event
edit('packages/sim/src/types.ts', [
    ("  | { type: 'stormStrike'; p: PlayerId; lane: Lane; hit: boolean }", "  | { type: 'stormStrike'; p: PlayerId; lane: Lane; hit: boolean; meteor?: boolean }"),
])
edit('packages/sim/src/sim.ts', [
    ("ev.push({ type: 'stormStrike', p: st.owner, lane: st.lane, hit: stands });", "ev.push({ type: 'stormStrike', p: st.owner, lane: st.lane, hit: stands, meteor: st.meteor });"),
])

# --- theme
edit('packages/client/src/theme.ts', [
    ("export const SPELL_ORDER: SpellId[] = ['cinder', 'storm', 'ward', 'mirror', 'gravewell', 'aurum', 'umbra', 'eclipse'];",
     "export const SPELL_ORDER: SpellId[] = ['cinder', 'dart', 'storm', 'fangs', 'riptide', 'crescent', 'ward', 'aegis', 'mirror', 'heal', 'starfall', 'gravewell', 'aurum', 'umbra', 'eclipse'];"),
    ("  eclipse: { id: 'eclipse', name: 'Eclipse Rend',",
     """  dart: { id: 'dart', name: 'Piercing Dart', short: 'Dart', color: 0xaaf6ff, css: '#aaf6ff', icon: 'V', shape: 'vee', blurb: 'A very fast needle of light. Weak, cheap, and it slips straight through Glacier Ward.', counters: 'Blink, Mirrorveil, or just out-trade it with bigger spells.' },
  riptide: { id: 'riptide', name: 'Riptide Lash', short: 'Riptide', color: 0x3fd0c0, css: '#3fd0c0', icon: '∿', shape: 'wave', blurb: 'Draw a wave. A water bolt that Chills the target: their casting is 25% slower for 3 seconds.', counters: 'Ward absorbs it; reflect it to chill the caster instead.' },
  heal: { id: 'heal', name: 'Mending Light', short: 'Mend', color: 0x7dffb0, css: '#7dffb0', icon: '♥', shape: 'heart', blurb: 'Draw a heart. Restores 24 Vitality over 2 seconds and douses Burn. Long cooldown.', counters: 'The windup is a window to punish; Stormfork interrupts it.' },
  aegis: { id: 'aegis', name: 'Aegis', short: 'Aegis', color: 0xffe08a, css: '#ffe08a', icon: '▢', shape: 'square', blurb: 'Draw a square. For 4 seconds you take 40% less damage and half the Poise damage.', counters: 'Gravewell and Eclipse still hurt; wait it out or burn it down with Starfall.' },
  crescent: { id: 'crescent', name: 'Moonblade', short: 'Moon', color: 0xf2e6a0, css: '#f2e6a0', icon: '☾', shape: 'crescent', blurb: 'Draw a C. A wide blade that hits your lane and the neighbouring lanes. One Blink is not enough.', counters: 'Ward, Mirrorveil, or Blink two lanes away.' },
  starfall: { id: 'starfall', name: 'Starfall', short: 'Starfall', color: 0xffa040, css: '#ffa040', icon: '★', shape: 'star', blurb: 'Draw a star. Meteors mark all three lanes and land one after another. Keep moving.', counters: 'Ward absorbs them; time your Blinks between impacts.' },
  fangs: { id: 'fangs', name: 'Twin Fangs', short: 'Fangs', color: 0xff5a6a, css: '#ff5a6a', icon: 'M', shape: 'em', blurb: 'Draw an M. Two fangs strike different lanes at different speeds.', counters: 'Mirrorveil catches one; dodge the other.' },
  eclipse: { id: 'eclipse', name: 'Eclipse Rend',"""),
])

# --- settings: view
edit('packages/client/src/settings.ts', [
    ("  difficulty: Difficulty;\n}", "  difficulty: Difficulty;\n  view: 'third' | 'first';\n}"),
    ("captions: false, strictness: 1, difficulty: 'adept',", "captions: false, strictness: 1, difficulty: 'apprentice', view: 'third',"),
])

# --- world: third-person camera
edit('packages/client/src/world.ts', [
    ("  /** adaptive quality: lower resolution", """  /** over-the-shoulder camera: explicit position and look target, with shake applied */
  placeThird(pos: THREE.Vector3, target: THREE.Vector3): void {
    const sh = this.trauma * this.trauma;
    const nx = (Math.sin(this.time * 41) + Math.sin(this.time * 23.7)) * 0.5;
    const ny = (Math.sin(this.time * 37 + 1.7) + Math.sin(this.time * 19.1)) * 0.5;
    this.camera.position.set(pos.x + nx * sh * 0.25 + this.parallax.x * 0.6, pos.y + ny * sh * 0.18 + Math.sin(this.time * 1.2) * 0.02, pos.z);
    this.camera.lookAt(target.x + this.parallax.x * 1.2, target.y + this.parallax.y * 0.8, target.z);
    this.camera.rotateZ(nx * sh * 0.03);
    const fov = this.baseFov + this.fovKick;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** adaptive quality: lower resolution"""),
])

# --- audio: new sounds
edit('packages/client/src/audio.ts', [
    ("  tier_rough: mk(", """  recog_dart: mk((a) => { a.osc('sine', 1400, 2600, 0.12, 0.08); a.noise(0.1, 0.06, { type: 'highpass', f0: 6000 }); }),
  recog_riptide: mk((a) => { a.osc('sine', 300, 700, 0.3, 0.09, { attack: 0.1 }); a.noise(0.3, 0.05, { f0: 900, f1: 2200, q: 2 }); a.bell(880, 0.6, 0.05, { at: 0.1 }); }),
  recog_heal: mk((a) => { [0, 4, 7, 12].forEach((s, i) => a.bell(523 * 2 ** (s / 12), 1.2, 0.07, { at: i * 0.09 })); }),
  recog_aegis: mk((a) => { a.osc('triangle', 200, 330, 0.3, 0.12); a.bell(784, 0.9, 0.07, { at: 0.05 }); }),
  recog_crescent: mk((a) => { a.osc('sawtooth', 500, 1300, 0.2, 0.06, { lp: 3000 }); a.bell(1568, 0.8, 0.06); }),
  recog_starfall: mk((a) => { for (let i = 0; i < 5; i++) a.bell(1318 * 2 ** ([0, 2, 4, 7, 9][i]! / 12), 0.7, 0.05, { at: i * 0.05 }); }),
  recog_fangs: mk((a) => { a.osc('sawtooth', 180, 90, 0.2, 0.1, { lp: 900 }); a.osc('sawtooth', 240, 120, 0.2, 0.08, { at: 0.08, lp: 900 }); }),
  impact_dart: mk((a) => { a.bell(2800, 0.15, 0.06); a.noise(0.06, 0.1, { type: 'highpass', f0: 5000 }); }),
  impact_riptide: mk((a) => { a.noise(0.3, 0.14, { f0: 700, f1: 200, q: 1.5 }); a.osc('sine', 260, 90, 0.25, 0.14); }),
  impact_crescent: mk((a) => { a.noise(0.2, 0.14, { type: 'highpass', f0: 2500, f1: 800 }); a.osc('sine', 150, 55, 0.25, 0.18); a.bell(1400, 0.4, 0.05); }),
  impact_fang: mk((a) => { a.osc('sawtooth', 300, 70, 0.15, 0.14, { lp: 1200 }); a.noise(0.08, 0.1, { f0: 2000, f1: 500 }); }),
  impact_meteor: mk((a) => { a.osc('sine', 110, 32, 0.8, 0.28, { wet: 0.5 }); a.noise(0.7, 0.2, { type: 'lowpass', f0: 2500, f1: 100, wet: 0.5 }); }),
  heal: mk((a) => { [0, 7, 12, 16].forEach((s, i) => a.bell(659 * 2 ** (s / 12), 1.0, 0.04, { at: i * 0.05 })); }),
  aegis: mk((a) => { a.osc('triangle', 150, 300, 0.4, 0.14, { attack: 0.1 }); a.bell(988, 1.1, 0.07, { at: 0.1 }); }),
  tier_rough: mk("""),
])

# --- hud
edit('packages/client/src/hud.ts', [
    ("const KIND_COLOR: Record<string, string> = { cinder: '#ff7a2a', blast: '#ffcf4a', lance: '#a36bff', shard: '#bfe6ff', eclipse: '#ffb020', storm: '#8ff6ff' };",
     "const KIND_COLOR: Record<string, string> = { cinder: '#ff7a2a', blast: '#ffcf4a', lance: '#a36bff', shard: '#bfe6ff', eclipse: '#ffb020', storm: '#8ff6ff', dart: '#aaf6ff', riptide: '#3fd0c0', crescent: '#f2e6a0', fang: '#ff5a6a', meteor: '#ffa040' };"),
    ("const KIND_ICON: Record<string, string> = { cinder: '▲', blast: '●', lance: '◉', shard: '⬡', eclipse: '∞', storm: 'ϟ' };",
     "const KIND_ICON: Record<string, string> = { cinder: '▲', blast: '●', lance: '◉', shard: '⬡', eclipse: '∞', storm: 'ϟ', dart: 'V', riptide: '∿', crescent: '☾', fang: 'M', meteor: '★' };"),
    ("      add('s' + st.id, st.lane, st.hit - viewTick, st.hit - st.born, 'storm');", "      add('s' + st.id, st.lane, st.hit - viewTick, st.hit - st.born, st.meteor ? 'meteor' : 'storm');"),
    ("    if (stacks > 0) status.push(", "    if (s.tick < me.aegisUntil) status.push('<span style=\"color:#ffe08a\">AEGIS</span>');\n    if (me.heal) status.push('<span style=\"color:#7dffb0\">MENDING</span>');\n    if (stacks > 0) status.push("),
    ("    if (foe.ward) fx.push(", "    if (s.tick < foe.aegisUntil) fx.push('<span style=\"color:#ffe08a\">AEGIS</span>');\n    if (foe.heal) fx.push('<span style=\"color:#7dffb0\">MENDING</span>');\n    if (foe.ward) fx.push("),
])
print('client patch 1 ok')
