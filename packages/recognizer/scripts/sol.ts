import { canonical, features } from '../src';
for (const sh of ['heart', 'circle', 'diamond', 'square', 'triangle'] as const) {
  const c = canonical(sh).map((p) => ({ x: p.x * 500, y: p.y * 500 }));
  console.log(sh, features(c).solidity.toFixed(3));
}
