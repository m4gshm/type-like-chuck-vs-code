// Builds fonts/tlc-codicons.woff: a tiny icon font with a single monochrome
// "cowboy" glyph (from icon.svg) used in the status bar via $(tlc-cowboy).
import { SVGIcons2SVGFontStream } from 'svgicons2svgfont';
import svg2ttf from 'svg2ttf';
import ttf2woff from 'ttf2woff';
import { Readable } from 'node:stream';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const svg = readFileSync('icon.svg', 'utf8');

const s = 128 / 116; // scale: content 110x116 centered in 128x128
const tx = (128 - 110 * s) / 2 + 5 * s;
const ty = 10 * s;
const X = (x) => s * x + tx;
const Y = (y) => s * y + ty;

// Merge every <path d="..."> into a single glyph. IMPORTANT: each path is
// transformed separately — their leading "m" is relative to (0,0) only within
// its own element, so naive concatenation would shift every path after the first.
const transformed = [...svg.matchAll(/ d="([^"]+)"/g)]
  .map((m) => transformPath(m[1]))
  .join(' ');
if (transformed.length === 0) {
  throw new Error('no paths found in icon.svg');
}

function transformPath(src) {
  let out = '';
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  const tokens = src.match(/[mhvlz]|[+-]?(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?/gi) ?? [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (/^[mhvlz]$/i.test(t)) {
      const cmd = t.toLowerCase();
      if (cmd === 'z') {
        out += 'Z';
        x = startX;
        y = startY;
        continue;
      }
      const nums = [];
      while (i + 1 < tokens.length && !/^[mhvlz]$/i.test(tokens[i + 1])) {
        nums.push(parseFloat(tokens[i + 1]));
        i += 1;
      }
      if (cmd === 'm') {
        x += nums[0];
        y += nums[1];
        startX = x;
        startY = y;
        out += `M${X(x).toFixed(3)} ${Y(y).toFixed(3)}`;
        // subsequent pairs would be implicit relative lines; the icon has none
      } else if (cmd === 'l') {
        for (let j = 0; j + 1 < nums.length; j += 2) {
          x += nums[j];
          y += nums[j + 1];
          out += `L${X(x).toFixed(3)} ${Y(y).toFixed(3)}`;
        }
      } else if (cmd === 'h') {
        for (const n of nums) {
          x += n;
          out += `L${X(x).toFixed(3)} ${Y(y).toFixed(3)}`;
        }
      } else if (cmd === 'v') {
        for (const n of nums) {
          y += n;
          out += `L${X(x).toFixed(3)} ${Y(y).toFixed(3)}`;
        }
      }
    }
  }
  return out;
}

const glyphSvg = `<svg width="128" height="128" viewBox="0 0 128 128"><path d="${transformed}"/></svg>`;

const glyph = new Readable();
glyph.push(glyphSvg);
glyph.push(null);
glyph.metadata = { unicode: ['\uE001'], name: 'tlc-cowboy' };

const fontStream = new SVGIcons2SVGFontStream({
  fontName: 'tlc-codicons',
  fontHeight: 128,
  descent: 0,
  normalize: false,
  log: () => undefined,
  metadata: 'TLC codicons',
});

const chunks = [];
fontStream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
fontStream.on('error', (err) => {
  console.error('font stream error:', err);
  process.exit(1);
});
fontStream.on('end', () => {
  const svgFont = Buffer.concat(chunks).toString('utf8');
  const ttf = Buffer.from(svg2ttf(svgFont).buffer);
  const woff = Buffer.from(ttf2woff(ttf).buffer);
  mkdirSync('fonts', { recursive: true });
  writeFileSync('fonts/tlc-codicons.woff', woff);
  console.log(`fonts/tlc-codicons.woff written (glyph: U+E001, ${woff.length} bytes)`);
});

fontStream.write(glyph);
fontStream.end();
