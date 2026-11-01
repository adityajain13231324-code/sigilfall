import os
os.chdir('packages/sim/src')
s = open('ai.ts', encoding='utf-8').read()

def rep(a, b):
    global s
    assert a in s, a[:70]
    s = s.replace(a, b, 1)

rep("  tiers: [number, number, number]; // rough/clean/perfect weights\n  noise: number;\n}",
    "  tiers: [number, number, number]; // rough/clean/perfect weights\n  noise: number;\n  /** ticks the AI waits after committing to a cast before thinking again (lower = more aggressive) */\n  tempo: [number, number];\n}")
a = s.index("export const PROFILES")
b = s.index("const DRAW_TICKS")
s = s[:a] + """export const PROFILES: Record<Difficulty, Profile> = {
  apprentice: { react: [14, 24], fizzle: 0.24, feint: 0, drawMult: 1.8, adapt: 0, blinkSkill: 0.22, counterSkill: 0.04, eclipseAmbition: 0.04, tiers: [0.5, 0.45, 0.05], noise: 0.6, tempo: [45, 100] },
  adept: { react: [8, 13], fizzle: 0.08, feint: 0.03, drawMult: 1.1, adapt: 0.6, blinkSkill: 0.62, counterSkill: 0.4, eclipseAmbition: 0.4, tiers: [0.15, 0.6, 0.25], noise: 0.3, tempo: [18, 50] },
  archmage: { react: [4, 7], fizzle: 0.025, feint: 0.16, drawMult: 0.8, adapt: 1, blinkSkill: 0.93, counterSkill: 0.85, eclipseAmbition: 0.9, tiers: [0.05, 0.5, 0.45], noise: 0.18, tempo: [4, 18] },
};

""" + s[b:]
rep("const DRAW_TICKS: Record<SpellId, number> = { cinder: 13, storm: 15, ward: 13, mirror: 14, gravewell: 27, aurum: 17, umbra: 17, eclipse: 29 };",
    "const DRAW_TICKS: Record<SpellId, number> = { cinder: 13, storm: 15, ward: 13, mirror: 14, gravewell: 27, aurum: 17, umbra: 17, eclipse: 29, dart: 10, riptide: 14, heal: 20, aegis: 14, crescent: 16, starfall: 24, fangs: 20 };")
# tempo after cast committed
rep("          else cmds.push({ t: 'cast', spell: pl.fizzle ? null : pl.spell, tier: pl.tier });\n          this.plan = null;",
    "          else cmds.push({ t: 'cast', spell: pl.fizzle ? null : pl.spell, tier: pl.tier });\n          this.plan = null;\n          this.nextThink = s.tick + this.p.tempo[0] + Math.floor(this.rng() * (this.p.tempo[1] - this.p.tempo[0] + 1));")
# new spell utilities
rep("    // variety: reward spells I have not cast lately (Spellweave)",
    """    const hurt = w.vit < 55;
    add('dart', 0.4 + (wardUp ? 0.9 : 0));
    add('riptide', 0.3 + (fw.state === 'idle' ? 0.1 : 0));
    add('crescent', 0.4);
    add('fangs', 0.35);
    add('starfall', 0.3 + (fw.lane !== 1 ? 0.1 : 0));
    if (w.vit < 78) add('heal', hurt ? 1.5 : 0.5);
    if (!(s.tick < w.aegisUntil)) add('aegis', (hurt ? 0.5 : 0.05) + (fw.state === 'windup' ? 0.4 : 0));

    // variety: reward spells I have not cast lately (Spellweave)""")
open('ai.ts', 'w', encoding='utf-8').write(s)
print('ok')
