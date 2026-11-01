import os
os.chdir('packages/sim/src')

def rw(p, fn):
    s = open(p, encoding='utf-8').read()
    s2 = fn(s)
    open(p, 'w', encoding='utf-8').write(s2)

def balance(s):
    s = s.replace('"drawWindow": 2.0,', '"drawWindow": 6.0,').replace('"drawGraceTicks": 6,', '"drawGraceTicks": 10,')
    s = s.replace('    "orbRelease": { "recovery": 0.2 }', '''    "dart": { "aether": 8, "windup": 0.2, "cooldown": 0.6, "recovery": 0.1, "damage": 6, "poise": 1, "travel": 0.4 },
    "riptide": { "aether": 14, "windup": 0.35, "cooldown": 1.5, "recovery": 0.15, "damage": 7, "poise": 3, "travel": 0.6, "chillSeconds": 3 },
    "heal": { "aether": 24, "windup": 0.6, "cooldown": 12.0, "recovery": 0.4, "amount": 24, "seconds": 2 },
    "aegis": { "aether": 20, "windup": 0.3, "cooldown": 9.0, "recovery": 0.2, "seconds": 4, "damageMult": 0.6, "poiseMult": 0.5 },
    "crescent": { "aether": 16, "windup": 0.4, "cooldown": 2.0, "recovery": 0.2, "damage": 10, "poise": 6, "travel": 0.65 },
    "starfall": { "aether": 30, "windup": 0.7, "cooldown": 9.0, "recovery": 0.4, "damage": 9, "poise": 5, "telegraph": 0.5, "gap": 0.3 },
    "fangs": { "aether": 18, "windup": 0.4, "cooldown": 2.5, "recovery": 0.2, "damage": 6, "poise": 2, "travel": 0.6, "travel2": 0.85 },
    "orbRelease": { "recovery": 0.2 }''')
    return s
rw('balance.json', balance)

def types(s):
    s = s.replace("  cinder: 'warm', aurum: 'warm', storm: 'cold', ward: 'cold', mirror: 'silver', gravewell: 'dark', umbra: 'dark', eclipse: 'dark',",
                  "  cinder: 'warm', aurum: 'warm', storm: 'cold', ward: 'cold', mirror: 'silver', gravewell: 'dark', umbra: 'dark', eclipse: 'dark',\n  dart: 'cold', riptide: 'cold', heal: 'silver', aegis: 'silver', crescent: 'silver', starfall: 'warm', fangs: 'warm',")
    s = s.replace("export type ProjKind = 'cinder' | 'blast' | 'lance' | 'shard' | 'eclipse';",
                  "export type ProjKind = 'cinder' | 'blast' | 'lance' | 'shard' | 'eclipse' | 'dart' | 'riptide' | 'crescent' | 'fang';")
    s = s.replace("  noReflect: boolean;\n  reflected: boolean;\n}",
                  "  noReflect: boolean;\n  reflected: boolean;\n  /** hits the target lane and its neighbours */\n  wide: boolean;\n  /** applies Chill on hit */\n  chill: boolean;\n}")
    s = s.replace("  dmg: number;\n  poise: number;\n}\n\nexport interface Well",
                  "  dmg: number;\n  poise: number;\n  /** Starfall meteor rather than Stormfork lightning */\n  meteor: boolean;\n}\n\nexport interface Well")
    s = s.replace("  burnUntil: number;\n  burnPhase: number;", "  burnUntil: number;\n  burnPhase: number;\n  aegisUntil: number;\n  heal: { until: number; perTick: number } | null;")
    s = s.replace("  | { type: 'chill'; p: PlayerId }", "  | { type: 'chill'; p: PlayerId }\n  | { type: 'heal'; p: PlayerId; amount: number }\n  | { type: 'aegis'; p: PlayerId }")
    s = s.replace("kind: ProjKind | 'storm' | 'burn' | 'wellspring' | 'gravewell';", "kind: ProjKind | 'storm' | 'meteor' | 'burn' | 'wellspring' | 'gravewell';")
    return s
rw('types.ts', types)

NEW_CASES = """    case 'dart': {
      const c = bal.spells.dart;
      newProj(ctx, p, 'dart', lane, T(c.travel), c.damage * wu.power, c.poise, { pierce: true });
      break;
    }
    case 'riptide': {
      const c = bal.spells.riptide;
      newProj(ctx, p, 'riptide', lane, T(c.travel), c.damage * wu.power, c.poise, { chill: true });
      break;
    }
    case 'crescent': {
      const c = bal.spells.crescent;
      newProj(ctx, p, 'crescent', lane, T(c.travel), c.damage * wu.power, c.poise, { wide: true });
      break;
    }
    case 'fangs': {
      const c = bal.spells.fangs;
      const others = ([0, 1, 2] as Lane[]).filter((l) => l !== lane);
      const second = others[Math.floor(rand(s) * others.length)]!;
      newProj(ctx, p, 'fang', lane, T(c.travel), c.damage * wu.power, c.poise);
      newProj(ctx, p, 'fang', second, T(c.travel2), c.damage * wu.power, c.poise);
      break;
    }
    case 'heal': {
      const c = bal.spells.heal;
      w.burnUntil = 0;
      w.heal = { until: s.tick + T(c.seconds), perTick: (c.amount * wu.power) / T(c.seconds) };
      break;
    }
    case 'aegis': {
      w.aegisUntil = s.tick + T(bal.spells.aegis.seconds);
      ev.push({ type: 'aegis', p });
      break;
    }
    case 'starfall': {
      const c = bal.spells.starfall;
      const order = ([0, 1, 2] as Lane[]).sort(() => rand(s) - 0.5);
      order.forEach((l, i) => {
        const st = { id: s.nextId++, owner: p, lane: l, born: s.tick, hit: s.tick + T(c.telegraph) + i * T(c.gap), dmg: c.damage * wu.power, poise: c.poise, meteor: true };
        s.strikes.push(st);
        ev.push({ type: 'stormMark', p, lane: l, hit: st.hit });
      });
      break;
    }
    case 'eclipse': {
      const c = bal.spells.eclipse;
      newProj("""

METEOR = """    if (st.meteor) {
      if (ew.ward) {
        ew.ward.hp -= st.dmg;
        ev.push({ type: 'wardAbsorb', p: foe, hp: Math.max(0, ew.ward.hp), crit: false });
        if (ew.ward.hp <= 0) breakWard(ctx, foe);
      } else {
        damage(ctx, foe, st.dmg, st.poise, 'meteor', st.lane, st.owner);
        if (ew.state !== 'dead') {
          ew.burnUntil = s.tick + T(2);
          ew.burnPhase = s.tick;
          ev.push({ type: 'burn', p: foe });
        }
      }
      continue;
    }
    let dmg = st.dmg;
    let combo = false;
    if (s.tick < ew.burnUntil) {"""

def sim(s):
    def rep(a, b, count=1):
        nonlocal s
        assert a in s, a[:60]
        s = s.replace(a, b, count)
    rep("export const SPELLS: SpellId[] = ['cinder', 'storm', 'ward', 'mirror', 'gravewell', 'aurum', 'umbra', 'eclipse'];",
        "export const SPELLS: SpellId[] = ['cinder', 'storm', 'ward', 'mirror', 'gravewell', 'aurum', 'umbra', 'eclipse', 'dart', 'riptide', 'heal', 'aegis', 'crescent', 'starfall', 'fangs'];")
    rep("lastHit: -9999, brokenUntil: 0, openUntil: 0,", "lastHit: -9999, brokenUntil: 0, openUntil: 0, aegisUntil: 0, heal: null,")
    rep("pierce: false, noReflect: false, reflected: false, ...extra,", "pierce: false, noReflect: false, reflected: false, wide: false, chill: false, ...extra,")
    rep("hit: s.tick + T(c.telegraph), dmg: c.damage * wu.power, poise: c.poise };", "hit: s.tick + T(c.telegraph), dmg: c.damage * wu.power, poise: c.poise, meteor: false };")
    rep("    case 'eclipse': {\n      const c = bal.spells.eclipse;\n      newProj(", NEW_CASES)
    rep("  // regen\n", """  if (w.heal) {
    if (s.tick >= w.heal.until) w.heal = null;
    else {
      w.vit = Math.min(bal.vitality, w.vit + w.heal.perTick);
      if ((w.heal.until - s.tick) % 15 === 0) ev.push({ type: 'heal', p, amount: w.heal.perTick * 15 });
    }
  }
  // regen
""")
    rep("  if (w.openUntil > s.tick) dmg *= bal.spells.gravewell.openDamageMult;\n",
        "  if (w.openUntil > s.tick) dmg *= bal.spells.gravewell.openDamageMult;\n  if (s.tick < w.aegisUntil) {\n    dmg *= bal.spells.aegis.damageMult;\n    poiseDmg *= bal.spells.aegis.poiseMult;\n  }\n")
    rep("    let dmg = st.dmg;\n    let combo = false;\n    if (s.tick < ew.burnUntil) {", METEOR)
    rep("  if (def.lane !== pr.lane) {\n    ev.push({ type: 'dodge', p: defId, id: pr.id });\n    return;\n  }",
        "  if (Math.abs(def.lane - pr.lane) > (pr.wide ? 1 : 0)) {\n    ev.push({ type: 'dodge', p: defId, id: pr.id });\n    return;\n  }")
    rep("  if (pr.kind === 'blast') {\n    const from = def.lane;",
        "  if (pr.chill) {\n    def.chillUntil = s.tick + T(bal.spells.riptide.chillSeconds);\n    ev.push({ type: 'chill', p: defId });\n  }\n  if (pr.kind === 'blast') {\n    const from = def.lane;")
    rep("const pool: SpellId[] = ['cinder', 'storm', 'ward', 'mirror', 'gravewell', 'aurum'];",
        "const pool: SpellId[] = ['cinder', 'storm', 'ward', 'mirror', 'gravewell', 'aurum', 'dart', 'crescent', 'fangs'];")
    return s
rw('sim.ts', sim)
print('patched')
