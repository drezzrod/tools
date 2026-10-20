#!/usr/bin/env node
// expand_logos.js - NHL94Genesis: write every team logo (logoANA.map.jim ... logoWSH.map.jim) as a FULL 6 x 6 picture.
//
//   node expand_logos.js [path\to\NHL94Genesis]          apply (default folder = current folder)
//   node expand_logos.js [folder] --check                show what each logo file looks like now
//   node expand_logos.js [folder] --undo                 put the original extractor (and logo files) back
//
// Retail stores each logo as the unique tiles only (17 to 36 of them) plus a 6 x 6 map that repeats / mirrors
// them. Every logo is different, so the map of each one is different. After this script every logo file holds
// 36 tiles = one tile per map cell, the map is simply 0, 1, 2 ... 35, nothing is repeated or mirrored:
// tile N is what you see in cell N (row by row, 6 across). The picture is what you edit; the game is unchanged.
//
// Why the game still works: the logo routines (DrawTeamLogo, DrawMatchupLogo, period stats, records, cards)
// read the tile count from the file header, and every place that loads a logo already reserves $24 = 36
// characters for it, which is exactly the 36 tiles of a full 6 x 6 logo. No game code is touched.
//
// How: tools\extractAssets94.js (the script that cuts the files out of the retail ROM) is changed so it writes
// the logo files in this form, then it is run again. Like the banner files, this means build:dev will not turn
// them back into the condensed form. Run this BEFORE you paint in the logo files: the extractor runs once
// more and replaces what is in Extracted\ (a copy of your current files goes to backup_before_logos\).
//
// Use node bmp2jim.js export / import  to paint a logo (48 x 48 BMP).

'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const root = path.resolve(args.find((a) => !a.startsWith('--')) || '.');
const TOOLS = path.join(root, 'tools'), EXTRACTED = path.join(root, 'Extracted'), GFX = path.join(EXTRACTED, 'NHL94', 'Graphics');
const BACKUP = path.join(root, 'backup_before_logos');
const MARK = '// LOGOS_EXPANDED (added by expand_logos.js)';
const T = 32, W = 6, H = 6;
const isLogo = (n) => /^logo[A-Z]+\.map\.jim$/.test(n);
function die(m) { console.error('\nERROR: ' + m + '\n'); process.exit(1); }
const exPath = path.join(TOOLS, 'extractAssets94.js');
if (!fs.existsSync(exPath)) die(`${exPath} not found. Run this from the NHL94Genesis folder, or give that folder as the first argument.`);
const exText = () => fs.readFileSync(exPath, 'utf8');

// Self-contained on purpose: this exact function is also pasted into tools\extractAssets94.js.
function expandLogoJim(buf) {
    const T = 32;
    const palOff = buf.readUInt32BE(0), mapOff = buf.readUInt32BE(4), cnt = buf.readUInt16BE(8);
    if ((cnt & 0x8000) || palOff !== 10 + cnt * T) throw new Error('logo jim: unexpected layout (packed tiles?)');
    const mw = buf.readUInt16BE(mapOff), mh = buf.readUInt16BE(mapOff + 2);
    const flip = (t, h, v) => {
        const out = Buffer.alloc(T);
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
            const sy = v ? 7 - y : y, sx = h ? 7 - x : x, b = t[sy * 4 + (sx >> 1)];
            const p = (sx & 1) ? b & 15 : b >> 4;
            out[y * 4 + (x >> 1)] |= (x & 1) ? p : p << 4;
        }
        return out;
    };
    const tiles = [], map = [];
    for (let i = 0; i < mw * mh; i++) {
        const w = buf.readUInt16BE(mapOff + 4 + i * 2), n = w & 0x7FF;
        if (n >= cnt) throw new Error('logo jim: the map points past the last tile');
        tiles.push(flip(buf.subarray(10 + n * T, 10 + (n + 1) * T), !!(w & 0x0800), !!(w & 0x1000)));
        map.push((i & 0x7FF) | (w & 0xE000));
    }
    const pal = buf.subarray(palOff, mapOff), body = Buffer.concat(tiles);   // (no tail: anything after the map is dropped)
    const head = Buffer.alloc(10);
    head.writeUInt32BE(10 + body.length, 0); head.writeUInt32BE(10 + body.length + pal.length, 4); head.writeUInt16BE(mw * mh, 8);
    const m = Buffer.alloc(4 + map.length * 2);
    m.writeUInt16BE(mw, 0); m.writeUInt16BE(mh, 2);
    map.forEach((w, i) => m.writeUInt16BE(w, 4 + i * 2));
    return Buffer.concat([head, body, pal, m]);
}

function parse(buf, name) {
    const palOff = buf.readUInt32BE(0), mapOff = buf.readUInt32BE(4), cnt = buf.readUInt16BE(8);
    if (cnt & 0x8000 || palOff !== 10 + cnt * T) die(`${name}: unexpected layout.`);
    const mw = buf.readUInt16BE(mapOff), mh = buf.readUInt16BE(mapOff + 2), map = [];
    for (let i = 0; i < mw * mh; i++) map.push(buf.readUInt16BE(mapOff + 4 + i * 2));
    return { n: cnt, mw, mh, map, tiles: buf.subarray(10, 10 + cnt * T) };
}
const expanded = (j) => j.n === j.mw * j.mh && j.map.every((w, i) => (w & 0x7FF) === i && !(w & 0x1800));
function cells(j) { // every cell as a string of its 64 pixels, flips applied
    return j.map.map((w) => {
        const t = j.tiles.subarray((w & 0x7FF) * T, (w & 0x7FF) * T + T), px = [];
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
            const sy = (w & 0x1000) ? 7 - y : y, sx = (w & 0x0800) ? 7 - x : x, b = t[sy * 4 + (sx >> 1)];
            px.push((sx & 1) ? b & 15 : b >> 4);
        }
        return px.join(',') + '/' + (w & 0xE000);
    });
}
const logoFiles = () => (fs.existsSync(GFX) ? fs.readdirSync(GFX).filter(isLogo).sort() : []);

if (flags.includes('--check')) {
    console.log(`extractor patched: ${exText().includes(MARK) ? 'yes' : 'no'}`);
    for (const f of logoFiles()) { const j = parse(fs.readFileSync(path.join(GFX, f)), f); console.log(`  ${f}: ${j.n} tiles, ${j.mw} x ${j.mh} map, ${expanded(j) ? 'EXPANDED (full picture)' : 'condensed'}`); }
    process.exit(0);
}
if (flags.includes('--undo')) {
    if (!fs.existsSync(BACKUP)) die('no backup_before_logos folder, nothing to undo.');
    if (fs.existsSync(path.join(BACKUP, 'extractAssets94.js'))) fs.copyFileSync(path.join(BACKUP, 'extractAssets94.js'), exPath);
    const bl = path.join(BACKUP, 'logos');
    if (fs.existsSync(bl)) for (const f of fs.readdirSync(bl)) fs.copyFileSync(path.join(bl, f), path.join(GFX, f));
    fs.rmSync(path.join(EXTRACTED, '.extract-complete.json'), { force: true });
    console.log('Original extractor and the logo files restored.');
    process.exit(0);
}

if (!fs.existsSync(path.join(root, 'lst', 'nhl94.bin'))) die('lst\\nhl94.bin (the retail ROM) not found. The logos are extracted from it.');
const old = {}; // the condensed pictures as they are now, for the check at the end
fs.mkdirSync(BACKUP, { recursive: true });
if (!fs.existsSync(path.join(BACKUP, 'extractAssets94.js')) && !exText().includes(MARK)) fs.copyFileSync(exPath, path.join(BACKUP, 'extractAssets94.js'));
fs.mkdirSync(path.join(BACKUP, 'logos'), { recursive: true });
for (const f of logoFiles()) {
    const to = path.join(BACKUP, 'logos', f);
    if (!fs.existsSync(to)) fs.copyFileSync(path.join(GFX, f), to);
    old[f] = fs.readFileSync(path.join(BACKUP, 'logos', f));
}

if (!exText().includes(MARK)) {
    let e = exText();
    const anchor = 'async function extractAssets(romPath, options = {}) {';
    const loopRe = /^(\s*)(?:const|let) assetData = romData\.slice\(start, end\);[ \t]*$/m;
    if (!e.includes(anchor) || !loopRe.test(e)) die('tools\\extractAssets94.js does not look as expected (written for the current upstream source).');
    const helper = [
        MARK,
        '// Every team logo (logoXXX.map.jim) holds only its unique tiles plus a 6 x 6 map that repeats and mirrors them.',
        '// They are written as a full 6 x 6 picture instead: 36 tiles, tile N = cell N of the map, nothing repeated or flipped.',
        'const LOGO_RE = /^logo[A-Z]+\\.map\\.jim$/;',
        String(expandLogoJim),
        '',
        '',
    ].join('\n');
    e = e.replace(anchor, helper + anchor);
    e = e.replace(loopRe, (m, ind) => `${ind}let assetData = romData.slice(start, end);\n${ind}if (LOGO_RE.test(asset.name)) assetData = expandLogoJim(assetData);`);
    fs.writeFileSync(exPath, e);
    console.log('  tools\\extractAssets94.js: now writes the logo files expanded');
} else console.log('  tools\\extractAssets94.js: already patched');

console.log('  extracting the assets again ...');
const r = spawnSync(process.execPath, [exPath, path.join(root, 'lst', 'nhl94.bin')], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
if (r.status !== 0) die('the extractor failed:\n' + (r.stdout || '') + (r.stderr || ''));

let n = 0, saved = 0;
for (const f of logoFiles()) {
    const j = parse(fs.readFileSync(path.join(GFX, f)), f);
    if (!expanded(j) || j.mw !== W || j.mh !== H) die(`${f} did not come out as an expanded ${W} x ${H} logo.`);
    const o = parse(old[f], 'backup ' + f);
    if (!expanded(o) && cells(o).join('|') !== cells(j).join('|')) die(`${f}: the expanded picture differs from the original. Not continuing.`);
    n++; saved += j.n - o.n;
}
if (!n) die('no logo files found in ' + GFX);
console.log(`\nDone: ${n} logo files are full 6 x 6 pictures now (36 tiles each), checked against the originals cell for cell.`);
console.log('The game code is unchanged; build with  npm run build:dev');
console.log(`(Together the logos hold ${saved} more tiles than before = ${saved * 32} bytes more ROM.)`);
console.log('To paint one:   node bmp2jim.js export Extracted\\NHL94\\Graphics\\logoANA.map.jim   then   node bmp2jim.js import logoANA.bmp Extracted\\NHL94\\Graphics\\logoANA.map.jim');
