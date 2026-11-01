import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateTemplates } from '../src/shapes';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../templates.json');
mkdirSync(dirname(out), { recursive: true });
const rounded = generateTemplates().map((t) => ({ shape: t.shape, pts: t.pts.map((p) => ({ x: +p.x.toFixed(4), y: +p.y.toFixed(4) })) }));
writeFileSync(out, JSON.stringify(rounded));
console.log(`wrote ${rounded.length} templates to ${out}`);
