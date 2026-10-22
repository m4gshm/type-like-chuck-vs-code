import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';

// Renders icon.svg (the "Cowboy" icon by Robin Lopez, Noun Project, CC BY 4.0)
// into icon.png for the extension package.
const svg = readFileSync('icon.svg', 'utf8');
const resvg = new Resvg(svg, {
  fitTo: { mode: 'original' },
  background: 'rgba(0,0,0,0)',
});
writeFileSync('icon.png', resvg.render().asPng());
console.log('icon.png written');
