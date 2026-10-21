import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';

const svg = readFileSync('icon.svg', 'utf8');
const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: 128 },
  background: 'rgba(0,0,0,0)',
});
writeFileSync('icon.png', resvg.render().asPng());
console.log('icon.png written');
