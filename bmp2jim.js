#!/usr/bin/env node
// bmp2jim.js - export a .map.jim to a BMP, and import an edited BMP back into the .jim.
// No npm install needed (plain Node, no packages). Works on the NHL 92-94 raw (unpacked) .map.jim layout.
//
//   node bmp2jim.js export  <file.jim>  [out.bmp]  [--line N]
//   node bmp2jim.js import  <in.bmp>  <file.jim>  [options]
//   node bmp2jim.js info    <file.jim>
//
// import options
//   --out <file.jim>      write somewhere else instead of changing <file.jim> (default: change it; a
//                         <file.jim>.bak copy is made the first time)
//   --team N              banner files only (TeamBlocks / TeamBlocks94, 11 tiles wide): the BMP is ONE team's
//                         banner, 88 x 16, and goes into team N (0 = first team). Without --team the BMP
//                         must be the whole picture (88 x 448 for the 28 team banner sheets).
//   --at-row R            same idea for any jim: the BMP replaces tile rows R.. (R counted in tiles, from 0)
//   --line N              palette line 0-3 to use for new/changed tiles (default: the line the jim already uses)
//   --keep-palette        do NOT write a new palette, only match the picture to the palette already in the jim
//                         (BMP colours are mapped to the nearest existing colour; indexed BMPs keep their numbers)
//   --write-palette       with --team / --at-row the jim's palette is kept by default (it is shared by every row);
//                         this writes the BMP's palette into the jim anyway
//   --dedupe              store repeated / mirrored tiles only once (smaller file, "condensed")
//   --expand              store one tile per map cell (the "full block" layout; default for files that are
//                         already like that)
//   --transparent-first   for 24 bit / many colour BMPs: use the colour of the top left pixel as colour 0
//
// Colours: a Genesis colour has 3 bits per channel, so every BMP colour is snapped to the nearest of 8 levels
// per channel (0,36,73,109,146,182,219,255). A 16 colour indexed BMP (4 or 8 bit) keeps its colour NUMBERS
// exactly (that is what you want when you paint in an editor): number 0 stays colour 0 (transparent).
// Anything else (24 bit, or more than 16 colours) is reduced to 16 colours (median cut), no dithering.

'use strict';
const fs = require('fs');
const path = require('path');

const T = 32; // bytes per 4bpp tile
function die(m) { console.error('\nERROR: ' + m + '\n'); process.exit(1); }

// ------------------------------------------------------------------ colours
const g2rgb = (c) => [((c >> 1) & 7), ((c >> 5) & 7), ((c >> 9) & 7)].map((v) => Math.round(v * 255 / 7));
const rgb2g = (r, g, b) => (Math.round(b * 7 / 255) << 9) | (Math.round(g * 7 / 255) << 5) | (Math.round(r * 7 / 255) << 1);
const snap = (rgb) => g2rgb(rgb2g(rgb[0], rgb[1], rgb[2]));

// ------------------------------------------------------------------ BMP read / write
function bmpRead(buf, name) {
    if (buf.toString('latin1', 0, 2) !== 'BM') die(`${name} is not a BMP file.`);
    const off = buf.readUInt32LE(10), hs = buf.readUInt32LE(14);
    if (hs < 40) die(`${name}: old style BMP header, please save it as a normal Windows BMP.`);
    const w = buf.readInt32LE(18); let h = buf.readInt32LE(22);
    const bpp = buf.readUInt16LE(28), comp = buf.readUInt32LE(30);
    const top = h < 0; h = Math.abs(h);
    if (comp !== 0 && !(comp === 3 && bpp === 32)) die(`${name}: compressed BMP (RLE) is not supported. Save it uncompressed.`);
    let ncol = buf.readUInt32LE(46);
    const pal = [];
    if (bpp <= 8) {
        if (!ncol) ncol = 1 << bpp;
        for (let i = 0; i < ncol; i++) { const p = 14 + hs + i * 4; pal.push([buf[p + 2], buf[p + 1], buf[p]]); }
    } else if (bpp !== 24 && bpp !== 32) die(`${name}: ${bpp} bit BMP not supported (use 1, 4, 8, 24 or 32 bit).`);
    const stride = Math.floor((w * bpp + 31) / 32) * 4;
    const idx = bpp <= 8 ? new Uint8Array(w * h) : null, rgb = bpp > 8 ? new Array(w * h) : null;
    for (let y = 0; y < h; y++) {
        const row = off + (top ? y : h - 1 - y) * stride;
        for (let x = 0; x < w; x++) {
            if (bpp === 8) idx[y * w + x] = buf[row + x];
            else if (bpp === 4) { const v = buf[row + (x >> 1)]; idx[y * w + x] = (x & 1) ? v & 15 : v >> 4; }
            else if (bpp === 1) idx[y * w + x] = (buf[row + (x >> 3)] >> (7 - (x & 7))) & 1;
            else { const p = row + x * (bpp / 8); rgb[y * w + x] = [buf[p + 2], buf[p + 1], buf[p]]; }
        }
    }
    return { w, h, bpp, pal, idx, rgb };
}
function bmpWrite4(w, h, idx, pal16) {
    const stride = Math.floor((w * 4 + 31) / 32) * 4, off = 54 + 64, buf = Buffer.alloc(off + stride * h);
    buf.write('BM', 0, 'latin1'); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(off, 10);
    buf.writeUInt32LE(40, 14); buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22); buf.writeUInt16LE(1, 26); buf.writeUInt16LE(4, 28);
    buf.writeUInt32LE(stride * h, 34); buf.writeUInt32LE(2835, 38); buf.writeUInt32LE(2835, 42); buf.writeUInt32LE(16, 46); buf.writeUInt32LE(16, 50);
    for (let i = 0; i < 16; i++) { const c = pal16[i] || [0, 0, 0]; buf[54 + i * 4] = c[2]; buf[55 + i * 4] = c[1]; buf[56 + i * 4] = c[0]; }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x += 2) buf[off + (h - 1 - y) * stride + (x >> 1)] = (idx[y * w + x] << 4) | idx[y * w + x + 1];
    return buf;
}

// ------------------------------------------------------------------ JIM read / write
function jimParse(buf, name) {
    if (buf.length < 10) die(`${name} is too small to be a jim.`);
    const palOff = buf.readUInt32BE(0), mapOff = buf.readUInt32BE(4), cnt = buf.readUInt16BE(8);
    if (cnt & 0x8000) die(`${name} holds PACKED tiles (jzip). This tool handles the raw layout only.`);
    if (palOff !== 10 + cnt * T || mapOff < palOff || mapOff + 4 > buf.length) die(`${name}: unexpected layout (palette offset ${palOff}, tiles ${cnt}).`);
    const mw = buf.readUInt16BE(mapOff), mh = buf.readUInt16BE(mapOff + 2);
    if (mapOff + 4 + mw * mh * 2 > buf.length) die(`${name}: the map runs past the end of the file.`);
    const map = []; for (let i = 0; i < mw * mh; i++) map.push(buf.readUInt16BE(mapOff + 4 + i * 2));
    const tiles = []; for (let t = 0; t < cnt; t++) tiles.push(buf.subarray(10 + t * T, 10 + t * T + T));
    return { tiles, pal: buf.subarray(palOff, mapOff), mw, mh, map, tail: buf.subarray(mapOff + 4 + mw * mh * 2) };
}
function jimBuild(tiles, pal, map, mw, mh, tail) {
    const body = Buffer.concat(tiles), palOff = 10 + body.length, mapOff = palOff + pal.length;
    const head = Buffer.alloc(10); head.writeUInt32BE(palOff, 0); head.writeUInt32BE(mapOff, 4); head.writeUInt16BE(tiles.length, 8);
    const m = Buffer.alloc(4 + map.length * 2); m.writeUInt16BE(mw, 0); m.writeUInt16BE(mh, 2);
    map.forEach((w, i) => m.writeUInt16BE(w, 4 + i * 2));
    return Buffer.concat([head, body, pal, m, tail || Buffer.alloc(0)]);
}
const tilePix = (t) => { const o = new Uint8Array(64); for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const b = t[y * 4 + (x >> 1)]; o[y * 8 + x] = (x & 1) ? b & 15 : b >> 4; } return o; };
const pixTile = (p) => { const o = Buffer.alloc(T); for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x += 2) o[y * 4 + (x >> 1)] = (p[y * 8 + x] << 4) | p[y * 8 + x + 1]; return o; };
const flipPix = (p, h, v) => { const o = new Uint8Array(64); for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) o[y * 8 + x] = p[(v ? 7 - y : y) * 8 + (h ? 7 - x : x)]; return o; };

// every map cell as 64 final pixels (flips applied) -> one picture
function jimCells(j) {
    return j.map.map((w) => {
        const t = j.tiles[w & 0x7FF]; if (!t) die('the map points past the last tile.');
        return flipPix(tilePix(t), !!(w & 0x0800), !!(w & 0x1000));
    });
}
function cellsToImage(cells, mw, mh) {
    const W = mw * 8, H = mh * 8, idx = new Uint8Array(W * H);
    cells.forEach((p, c) => { const cx = (c % mw) * 8, cy = Math.floor(c / mw) * 8; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) idx[(cy + y) * W + cx + x] = p[y * 8 + x]; });
    return { W, H, idx };
}
function imageToCells(idx, W, mw, rows) {
    const cells = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < mw; c++) {
        const p = new Uint8Array(64);
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) p[y * 8 + x] = idx[(r * 8 + y) * W + c * 8 + x];
        cells.push(p);
    }
    return cells;
}
const palLine = (pal, line) => { const o = []; for (let i = 0; i < 16; i++) o.push(pal.length >= line * 32 + i * 2 + 2 ? g2rgb(pal.readUInt16BE(line * 32 + i * 2)) : [i * 17, i * 17, i * 17]); return o; };

// ------------------------------------------------------------------ colour reduction (24 bit / > 16 colours)
function medianCut(colors, k) { // colors: [{rgb, n}]
    let boxes = [colors];
    while (boxes.length < k) {
        let bi = -1, best = 0, ch = 0;
        boxes.forEach((b, i) => {
            if (b.length < 2) return;
            for (let c = 0; c < 3; c++) { const v = b.map((x) => x.rgb[c]), r = Math.max(...v) - Math.min(...v); if (r > best) { best = r; bi = i; ch = c; } }
        });
        if (bi < 0) break;
        const b = boxes[bi].slice().sort((a, c) => a.rgb[ch] - c.rgb[ch]);
        const half = b.reduce((s, x) => s + x.n, 0) / 2; let acc = 0, cut = 1;
        for (let i = 0; i < b.length - 1; i++) { acc += b[i].n; cut = i + 1; if (acc >= half) break; }
        boxes.splice(bi, 1, b.slice(0, cut), b.slice(cut));
    }
    return boxes.map((b) => { const n = b.reduce((s, x) => s + x.n, 0); return [0, 1, 2].map((c) => Math.round(b.reduce((s, x) => s + x.rgb[c] * x.n, 0) / n)); });
}
const dist = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const nearest = (pal, c) => { let bi = 0, bd = Infinity; pal.forEach((p, i) => { const d = dist(p, c); if (d < bd) { bd = d; bi = i; } }); return bi; };

// turns a BMP into (idx array with numbers 0-15, 16 colour palette in 9 bit snapped RGB)
function bmpToIndexed(bmp, opt, jimPal16) {
    const n = bmp.w * bmp.h;
    if (bmp.idx) {
        if (bmp.idx.some((v) => v > 15)) { /* 8 bit with a bigger palette: treat as colour picture */ }
        else {
            const pal = []; for (let i = 0; i < 16; i++) pal.push(snap(bmp.pal[i] || [0, 0, 0]));
            if (opt.keepPalette) return { idx: bmp.idx, pal: jimPal16, note: 'indexed BMP: colour numbers kept, jim palette kept' };
            return { idx: bmp.idx, pal, note: 'indexed BMP: colour numbers kept' };
        }
    }
    const rgb = bmp.rgb || Array.from(bmp.idx, (v) => bmp.pal[v] || [0, 0, 0]);
    const px = rgb.map(snap), key = (c) => c[0] * 65536 + c[1] * 256 + c[2];
    const count = new Map(); px.forEach((c) => { const k = key(c); const e = count.get(k); if (e) e.n++; else count.set(k, { rgb: c, n: 1 }); });
    let pal;
    if (opt.keepPalette) pal = jimPal16;
    else {
        const all = [...count.values()];
        if (all.length <= 16) pal = all.map((x) => x.rgb);
        else pal = medianCut(all, 16).map(snap);
        // colour 0 = top left pixel colour (or the most common colour) so the background is transparent
        const bg = opt.transparentFirst ? px[0] : null;
        if (bg) { let bi = nearest(pal, bg); [pal[0], pal[bi]] = [pal[bi], pal[0]]; }
        while (pal.length < 16) pal.push([0, 0, 0]);
    }
    const cache = new Map(), idx = new Uint8Array(n);
    px.forEach((c, i) => { const k = key(c); let v = cache.get(k); if (v === undefined) { v = nearest(pal, c); cache.set(k, v); } idx[i] = v; });
    return { idx, pal, note: `${count.size} colours in the BMP${opt.keepPalette ? ', matched to the jim palette' : (count.size > 16 ? ', reduced to 16 (median cut)' : '')}` };
}

// ------------------------------------------------------------------ commands
function parseArgs() {
    const a = process.argv.slice(2), pos = [], o = {};
    for (let i = 0; i < a.length; i++) {
        if (!a[i].startsWith('--')) { pos.push(a[i]); continue; }
        const k = a[i].slice(2);
        if (['out', 'team', 'at-row', 'line'].includes(k)) o[k] = a[++i]; else o[k] = true;
    }
    return { cmd: pos[0], pos: pos.slice(1), o };
}
const { cmd, pos, o } = parseArgs();
const usage = () => { console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); process.exit(0); };
if (!cmd || cmd === 'help' || o.help) usage();

function lineOf(j) { return o.line !== undefined ? Number(o.line) : ((j.map[0] >> 13) & 3); }
if (o.line !== undefined && !(Number(o.line) >= 0 && Number(o.line) <= 3)) die('--line must be 0, 1, 2 or 3.');

if (cmd === 'info') {
    const f = pos[0] || usage(), j = jimParse(fs.readFileSync(f), f);
    const lines = new Set(j.map.map((w) => (w >> 13) & 3));
    console.log(`${f}\n  tiles ${j.tiles.length}, map ${j.mw} x ${j.mh} cells (${j.mw * 8} x ${j.mh * 8} pixels), palette ${j.pal.length} bytes,`
        + ` palette lines used by the map: ${[...lines].join(',')}, flipped cells: ${j.map.filter((w) => w & 0x1800).length}`
        + `\n  layout: ${j.tiles.length === j.mw * j.mh && j.map.every((w, i) => (w & 0x7FF) === i && !(w & 0x1800)) ? 'full block (one tile per cell)' : 'condensed (tiles are reused)'}`);
} else if (cmd === 'export') {
    const f = pos[0] || usage(), j = jimParse(fs.readFileSync(f), f), out = pos[1] || f.replace(/(\.map)?\.jim$/i, '') + '.bmp';
    const img = cellsToImage(jimCells(j), j.mw, j.mh);
    const line = lineOf(j), pal = palLine(j.pal, line);
    if (j.pal.length < 32) console.log('  note: this jim has no palette block of its own (the game sets the colours); the BMP gets a grey ramp.');
    if (new Set(j.map.map((w) => (w >> 13) & 3)).size > 1) console.log('  note: the map uses more than one palette line; the BMP shows palette line ' + line + ' (use --line N for another). Colour numbers are exact either way.');
    fs.writeFileSync(out, bmpWrite4(img.W, img.H, img.idx, pal));
    console.log(`  wrote ${out}  (${img.W} x ${img.H}, 4 bit, 16 colours, palette line ${line})`);
} else if (cmd === 'import') {
    const [bf, jf] = pos; if (!bf || !jf) usage();
    const j = jimParse(fs.readFileSync(jf), jf), bmp = bmpRead(fs.readFileSync(bf), bf);
    if (bmp.w % 8 || bmp.h % 8) die(`${bf} is ${bmp.w} x ${bmp.h}; both sizes must be a multiple of 8 (one tile = 8 pixels).`);
    if (bmp.w !== j.mw * 8) die(`${bf} is ${bmp.w} pixels wide, ${path.basename(jf)} is ${j.mw * 8} wide (${j.mw} tiles).`);
    let atRow = 0, rows = bmp.h / 8;
    if (o.team !== undefined) {
        if (j.mw !== 11 || j.mh % 2) die('--team only works on the team banner files (11 tiles wide, 2 tile rows per team). Use --at-row for other files.');
        if (rows !== 2) die(`--team expects ONE banner: 88 x 16 pixels. ${bf} is ${bmp.w} x ${bmp.h}.`);
        const t = Number(o.team); if (!(t >= 0 && t < j.mh / 2)) die(`--team must be 0 to ${j.mh / 2 - 1} for this file.`);
        atRow = t * 2;
    } else if (o['at-row'] !== undefined) atRow = Number(o['at-row']);
    if (atRow < 0 || atRow + rows > j.mh) die(`the picture (${rows} tile rows at row ${atRow}) does not fit inside the jim map (${j.mh} rows).`);

    const partial = rows !== j.mh;
    if (partial && !o['write-palette']) o['keep-palette'] = true; // the palette is shared by the whole file: don't recolour the other rows
    const line = lineOf(j), jimPal16 = palLine(j.pal, line);
    const conv = bmpToIndexed(bmp, { keepPalette: !!o['keep-palette'], transparentFirst: !!o['transparent-first'] }, jimPal16);

    // 1. whole jim as pixels, 2. paste the BMP over its rows, 3. rebuild tiles + map
    const cells = jimCells(j), newCells = imageToCells(conv.idx, bmp.w, j.mw, rows);
    const attr = j.map.slice(); // palette / priority bits per cell stay as they are
    newCells.forEach((p, i) => { const c = atRow * j.mw + i; cells[c] = p; if (o.line !== undefined) attr[c] = (attr[c] & ~0x6000) | (line << 13); });
    const wasFull = j.tiles.length === j.mw * j.mh && j.map.every((w, i) => (w & 0x7FF) === i && !(w & 0x1800));
    const dedupe = o.dedupe ? true : (o.expand ? false : !wasFull);
    let tiles = [], map = [];
    if (!dedupe) {
        cells.forEach((p, c) => { tiles.push(pixTile(p)); map.push(c | (attr[c] & 0xE000)); });
    } else {
        const seen = new Map(); // tile bytes -> index
        cells.forEach((p, c) => {
            let hit = null;
            for (const [h, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
                const k = pixTile(flipPix(p, !!h, !!v)).toString('latin1'); // flipping p by (h,v) gives the stored tile when drawn with (h,v)
                if (seen.has(k)) { hit = { i: seen.get(k), h, v }; break; }
            }
            if (!hit) { const t = pixTile(p); seen.set(t.toString('latin1'), tiles.length); tiles.push(t); hit = { i: tiles.length - 1, h: 0, v: 0 }; }
            map.push(hit.i | (hit.h ? 0x0800 : 0) | (hit.v ? 0x1000 : 0) | (attr[c] & 0xE000));
        });
        if (tiles.length > 2047) die('more than 2047 different tiles.');
    }
    let pal = Buffer.from(j.pal);
    if (!o['keep-palette'] && pal.length >= (line + 1) * 32) conv.pal.forEach((c, i) => pal.writeUInt16BE(rgb2g(c[0], c[1], c[2]), line * 32 + i * 2));
    else if (!o['keep-palette'] && pal.length === 0) console.log('  note: this jim has no palette block, so the BMP colours are used for the numbers only (the game supplies the colours).');
    const out = jimBuild(tiles, pal, map, j.mw, j.mh, j.tail), dest = o.out || jf;
    if (!o.out && !fs.existsSync(jf + '.bak')) fs.copyFileSync(jf, jf + '.bak');
    fs.writeFileSync(dest, out);

    // verify: read back and compare with what the BMP asked for
    const back = jimParse(fs.readFileSync(dest), dest), bc = jimCells(back);
    let bad = 0; newCells.forEach((p, i) => { const q = bc[atRow * j.mw + i]; for (let k = 0; k < 64; k++) if (p[k] !== q[k]) { bad++; break; } });
    if (bad) die(`self check failed on ${bad} tiles (bug in this tool, nothing is wrong with your picture). The file was written to ${dest}; restore from .bak.`);
    console.log(`  ${path.basename(bf)} -> ${dest}`);
    console.log(`  ${conv.note}; palette line ${line}; ${rows} tile rows at row ${atRow}; ${tiles.length} tiles stored (${dedupe ? 'condensed' : 'full block'}), ${out.length} bytes. Self check OK.`);
} else usage();
