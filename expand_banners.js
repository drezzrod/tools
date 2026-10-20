#!/usr/bin/env node
// expand_banners.js - NHL94Genesis: make TeamBlocks.map.jim and TeamBlocks94.map.jim hold every team
// banner as a FULL picture: one 11 tile wide, 56 tile tall block, repeated and mirrored tiles included.
//
//   node expand_banners.js [path\to\NHL94Genesis]          apply (default folder = current folder)
//   node expand_banners.js [folder] --png                  (re)write the preview / edit PNGs
//   node expand_banners.js [folder] --import-png           write your PNG edits back into the .jim files
//   node expand_banners.js [folder] --check                report the state only
//   node expand_banners.js [folder] --undo                 put the original source files back
//
// BEFORE: the two files store the banners as a pile of "unique tiles" (a tile that repeats inside a
//         banner, or is the mirror image of another, is stored once; the map says where to repeat or
//         flip it). 501 and 398 tiles for 28 teams.
// AFTER:  tile number N of the bank IS cell N of the picture. 616 tiles = 11 wide x 56 tall, 28 banners
//         of 11 x 2 tiles one under the other (team N = tile rows 2N and 2N+1, file offset 10 + N * 704).
//         The map is plain 0, 1, 2 ... and has no flip flags left. Open the file as 4bpp tiles, 11 per
//         row, and you see the whole sheet.
//
// The files that change are the ones in  Extracted\NHL94\Graphics\  : tools\extractAssets94.js is
// changed so that it writes the files in this expanded form, then it is run again. That way they stay
// expanded no matter how often the build re-extracts. (A copy of everything you had in Extracted\ is
// kept in backup_before_banners\Extracted\ the first time.) The game code is changed to match:
//   setup94.asm      in-game banners: the 22 tiles of the home and the visitor team are copied straight
//                    from the ROM to VRAM (no 500 tile scratch area in VRAM any more)
//   optsetup94.asm  \ setup screen banners: only the two banners on screen are in VRAM (22 tiles each)
//   attract94.asm   / instead of 2 x the whole bank. A banner's tiles are loaded when it is drawn.
// Safe to run twice. Originals are copied to backup_before_banners\ the first time.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const root = path.resolve(args.find((a) => !a.startsWith('--')) || '.');
const SRC = path.join(root, 'src');
const TOOLS = path.join(root, 'tools');
const BACKUP = path.join(root, 'backup_before_banners');
const EXTRACTED = path.join(root, 'Extracted');
const EXTR = path.join(EXTRACTED, 'NHL94', 'Graphics');
const FILES = ['TeamBlocks.map.jim', 'TeamBlocks94.map.jim'];
const PATCHED = ['graphics94.asm', 'setup94.asm', 'optsetup94.asm', 'attract94.asm'];
const MARK = ';BANNERS_EXPANDED';
const EXMARK = '// BANNERS_EXPANDED (added by expand_banners.js)';
const TILE = 32, PER = 22, W = 11;

const die = (m) => { console.error('\nERROR: ' + m + '\n'); process.exit(1); };
if (!fs.existsSync(path.join(SRC, 'nhl94.asm'))) die(`${SRC}\\nhl94.asm not found. Run this from the NHL94Genesis folder, or give that folder as the first argument.`);
const rd = (f) => fs.readFileSync(path.join(SRC, f), 'latin1');
const wr = (f, t) => fs.writeFileSync(path.join(SRC, f), t, 'latin1');
const nlOf = (t) => (t.includes('\r\n') ? '\r\n' : '\n');
const toLF = (t) => t.replace(/\r\n/g, '\n');
const toNL = (t, nl) => t.replace(/\n/g, nl);

// ---------------------------------------------------------------- the expansion itself
// Self-contained on purpose: this exact function is also pasted into tools\extractAssets94.js.
function expandBannerJim(buf) {
    const T = 32, PER = 22, W = 11;
    const palOff = buf.readUInt32BE(0), mapOff = buf.readUInt32BE(4), cnt = buf.readUInt16BE(8);
    if ((cnt & 0x8000) || palOff !== 10 + cnt * T) throw new Error('team banner jim: unexpected layout (packed tiles?)');
    const mw = buf.readUInt16BE(mapOff), mh = buf.readUInt16BE(mapOff + 2);
    if (mw !== W || mh % 2) throw new Error('team banner jim: the map is not 11 wide with 2 rows per team');
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
        if (n >= cnt) throw new Error('team banner jim: the map points past the last tile');
        tiles.push(flip(buf.subarray(10 + n * T, 10 + (n + 1) * T), !!(w & 0x0800), !!(w & 0x1000)));
        map.push((i & 0x7FF) | (w & 0xE000));
    }
    const pal = buf.subarray(palOff, mapOff), body = Buffer.concat(tiles);
    const head = Buffer.alloc(10);
    head.writeUInt32BE(10 + body.length, 0); head.writeUInt32BE(10 + body.length + pal.length, 4); head.writeUInt16BE(mw * mh, 8);
    const m = Buffer.alloc(4 + map.length * 2);
    m.writeUInt16BE(mw, 0); m.writeUInt16BE(mh, 2);
    map.forEach((w, i) => m.writeUInt16BE(w, 4 + i * 2));
    return Buffer.concat([head, body, pal, m]);
}

// ---------------------------------------------------------------- reading jim files (for checks, PNG)
function parseJim(buf, name) {
    const palOff = buf.readUInt32BE(0), mapOff = buf.readUInt32BE(4), cnt = buf.readUInt16BE(8);
    if (cnt & 0x8000) die(`${name} holds PACKED tiles. This tool only reads the raw (unpacked) layout.`);
    const n = cnt & 0x7FFF;
    if (palOff !== 10 + n * TILE) die(`${name}: unexpected layout (palette offset ${palOff}, expected ${10 + n * TILE}).`);
    const mw = buf.readUInt16BE(mapOff), mh = buf.readUInt16BE(mapOff + 2);
    if (mw !== W || mh % 2) die(`${name}: map is ${mw} x ${mh}, expected ${W} wide with 2 rows per team.`);
    const map = [];
    for (let i = 0; i < mw * mh; i++) map.push(buf.readUInt16BE(mapOff + 4 + i * 2));
    return { n, tiles: buf.subarray(10, 10 + n * TILE), pal: buf.subarray(palOff, mapOff), mw, mh, map, teams: mh / 2 };
}
const isExpanded = (j) => j.n === j.mw * j.mh && j.map.every((w, i) => (w & 0x7FF) === i && !(w & 0x1800));
function buildJim(tiles, pal, map, mh) {
    const palOff = 10 + tiles.length, mapOff = palOff + pal.length;
    const head = Buffer.alloc(10); head.writeUInt32BE(palOff, 0); head.writeUInt32BE(mapOff, 4); head.writeUInt16BE(tiles.length / TILE, 8);
    const m = Buffer.alloc(4 + map.length * 2); m.writeUInt16BE(W, 0); m.writeUInt16BE(mh, 2);
    map.forEach((w, i) => m.writeUInt16BE(w, 4 + i * 2));
    return Buffer.concat([head, tiles, pal, m]);
}
// pixels of what the map draws, as one array of 8x8 tile pixel strings per cell (for the self check)
function renderCells(j) {
    const px = (t) => { const o = []; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const b = t[y * 4 + (x >> 1)]; o.push((x & 1) ? b & 15 : b >> 4); } return o; };
    return j.map.map((w) => {
        const p = px(j.tiles.subarray((w & 0x7FF) * TILE, (w & 0x7FF) * TILE + TILE)), o = [];
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) o.push(p[((w & 0x1000) ? 7 - y : y) * 8 + ((w & 0x0800) ? 7 - x : x)]);
        return o.join(',') + '/' + (w & 0xE000);
    });
}

// ---------------------------------------------------------------- PNG preview / edit
const zlib = require('zlib');
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type, 'latin1'), l = Buffer.alloc(4), c = Buffer.alloc(4); l.writeUInt32BE(data.length); c.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([l, t, data, c]); };
function pngWrite(w, h, idx, rgb) {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 4; ihdr[9] = 3;
    const rb = w / 2, raw = Buffer.alloc((rb + 1) * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x += 2) raw[y * (rb + 1) + 1 + x / 2] = (idx[y * w + x] << 4) | idx[y * w + x + 1];
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('PLTE', Buffer.from(rgb.flat())), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function pngRead(buf, name) {
    if (buf.readUInt32BE(0) !== 0x89504E47) die(`${name} is not a PNG file.`);
    let p = 8, w, h, depth, ctype, inter; const idat = [];
    while (p < buf.length) {
        const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
        if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ctype = d[9]; inter = d[12]; }
        if (type === 'IDAT') idat.push(d);
        p += 12 + len;
    }
    if (ctype !== 3 || (depth !== 4 && depth !== 8) || inter) die(`${name} must be an indexed-colour PNG (16 colours, 4 or 8 bit, not interlaced). Do not convert it to RGB in your editor.`);
    const raw = zlib.inflateSync(Buffer.concat(idat)), rb = Math.ceil(w * depth / 8), out = Buffer.alloc(rb * h);
    for (let y = 0; y < h; y++) {
        const f = raw[y * (rb + 1)];
        for (let x = 0; x < rb; x++) {
            const v = raw[y * (rb + 1) + 1 + x], a = x ? out[y * rb + x - 1] : 0, b = y ? out[(y - 1) * rb + x] : 0, c = x && y ? out[(y - 1) * rb + x - 1] : 0;
            let r;
            if (f === 0) r = v; else if (f === 1) r = v + a; else if (f === 2) r = v + b; else if (f === 3) r = v + ((a + b) >> 1);
            else { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
            out[y * rb + x] = r & 255;
        }
    }
    const idx = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) idx[y * w + x] = depth === 8 ? out[y * rb + x] : (x & 1 ? out[y * rb + (x >> 1)] & 15 : out[y * rb + (x >> 1)] >> 4);
    if (idx.some((v) => v > 15)) die(`${name} uses more than 16 colours (colour numbers above 15).`);
    return { w, h, idx };
}
function pngModes(importing) {
    for (const f of FILES) {
        const jp = path.join(EXTR, f), pp = path.join(EXTR, f.replace('.map.jim', '.png'));
        if (!fs.existsSync(jp)) die(`${jp} not found. Run  node expand_banners.js  first.`);
        const j = parseJim(fs.readFileSync(jp), f);
        if (!isExpanded(j)) die(`${f} is not expanded yet. Run  node expand_banners.js  first.`);
        if (!importing) {
            const line = (j.map[0] >> 13) & 3, rgb = [];
            for (let i = 0; i < 16; i++) { const c = j.pal.readUInt16BE(line * 32 + i * 2); rgb.push([((c >> 1) & 7) * 255 / 7, ((c >> 5) & 7) * 255 / 7, ((c >> 9) & 7) * 255 / 7].map(Math.round)); }
            const w = W * 8, h = j.mh * 8, idx = new Uint8Array(w * h);
            for (let t = 0; t < j.n; t++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
                const v = j.tiles[t * TILE + y * 4 + (x >> 1)];
                idx[((Math.floor(t / W) * 8 + y) * w) + (t % W) * 8 + x] = x & 1 ? v & 15 : v >> 4;
            }
            fs.writeFileSync(pp, pngWrite(w, h, idx, rgb));
            console.log(`  wrote ${pp}  (${w} x ${h}: ${j.teams} banners, one under the other, 16 px each)`);
        } else {
            if (!fs.existsSync(pp)) die(`${pp} not found. Run  node expand_banners.js --png  first.`);
            const img = pngRead(fs.readFileSync(pp), path.basename(pp));
            if (img.w !== W * 8 || img.h !== j.mh * 8) die(`${path.basename(pp)} is ${img.w} x ${img.h}, expected ${W * 8} x ${j.mh * 8}.`);
            const tiles = Buffer.alloc(j.n * TILE);
            for (let t = 0; t < j.n; t++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x += 2) {
                const base = ((Math.floor(t / W) * 8 + y) * img.w) + (t % W) * 8 + x;
                tiles[t * TILE + y * 4 + (x >> 1)] = (img.idx[base] << 4) | img.idx[base + 1];
            }
            fs.writeFileSync(jp, buildJim(tiles, j.pal, j.map, j.mh));
            console.log(`  ${f} updated from ${path.basename(pp)}`);
        }
    }
}
if (flags.includes('--png') || flags.includes('--import-png')) { pngModes(flags.includes('--import-png')); process.exit(0); }

// ---------------------------------------------------------------- --undo / --check
const extractorText = () => fs.readFileSync(path.join(TOOLS, 'extractAssets94.js'), 'utf8');
if (flags.includes('--undo')) {
    if (!fs.existsSync(BACKUP)) die('no backup_before_banners folder, nothing to undo.');
    for (const f of fs.readdirSync(BACKUP, { withFileTypes: true })) {
        if (f.isDirectory()) continue;
        const dest = /^(prebuild|extractAssets94)\.js$/.test(f.name) ? path.join(TOOLS, f.name) : path.join(SRC, f.name);
        fs.copyFileSync(path.join(BACKUP, f.name), dest);
    }
    fs.rmSync(path.join(EXTRACTED, '.extract-complete.json'), { force: true });   // the next build extracts the original files again
    console.log('Original source files restored. The next build extracts the original (condensed) banner files again.');
    process.exit(0);
}
const hasMark = rd('setup94.asm').includes(MARK);
// The upstream branch patch/teamblock-vram (src\teambitmapvram.asm, tools\packTeamBitmaps.js) does the VRAM part itself.
const branch = fs.existsSync(path.join(SRC, 'teambitmapvram.asm'));
const exPatched = extractorText().includes(EXMARK);
if (flags.includes('--check')) {
    console.log(`Game code: ${branch ? 'from branch patch/teamblock-vram (left alone)' : hasMark ? 'patched by this script' : 'original'};  extractor patched: ${exPatched ? 'yes' : 'no'}`);
    for (const f of FILES) {
        const p = path.join(EXTR, f);
        if (!fs.existsSync(p)) { console.log(`  ${f}: not extracted yet`); continue; }
        const j = parseJim(fs.readFileSync(p), f);
        console.log(`  ${f}: ${j.n} tiles, ${isExpanded(j) ? 'EXPANDED (' + j.mw + ' x ' + j.mh + ' full picture)' : 'condensed (unique tiles)'}`);
    }
    process.exit(0);
}

// ---------------------------------------------------------------- apply
const nhlText = rd('nhl94.asm');
if (!nhlText.includes(';HIGHDATA') && /dcb\.b\s+\$100000-\*/i.test(nhlText)) {
    die('The graphics now take about 14 KB more than before, and the original layout has no room for that below the 1 MB pad line.\nRun  node move_data_high.js  first (it moves teamdata94, cards data and graphics94 to the end of the ROM), then run this again.');
}
if (!fs.existsSync(path.join(root, 'lst', 'nhl94.bin'))) die('lst\\nhl94.bin (the retail ROM) not found. The banners are extracted from it.');

// 0. backups (each file once)
fs.mkdirSync(BACKUP, { recursive: true });
const keep = (from, name) => { const to = path.join(BACKUP, name); if (!fs.existsSync(to) && fs.existsSync(from)) fs.copyFileSync(from, to); };
if (!hasMark) for (const f of branch ? ['graphics94.asm'] : PATCHED) keep(path.join(SRC, f), f);
keep(path.join(TOOLS, 'prebuild.js'), 'prebuild.js');
if (!exPatched) keep(path.join(TOOLS, 'extractAssets94.js'), 'extractAssets94.js');
if (fs.existsSync(EXTRACTED) && !fs.existsSync(path.join(BACKUP, 'Extracted'))) {
    fs.cpSync(EXTRACTED, path.join(BACKUP, 'Extracted'), { recursive: true });
    console.log('  copy of your Extracted\\ folder kept in backup_before_banners\\Extracted\\');
}

// 1. undo what the first version of this script did (files in Custom\Graphics, a changed prebuild.js)
{
    let g = rd('graphics94.asm');
    const g2 = g.replace(/\.\.\\Custom\\Graphics\\(TeamBlocks(?:94)?\.map\.jim)/gi, '..\\Extracted\\NHL94\\Graphics\\$1');
    if (g2 !== g) { wr('graphics94.asm', g2); console.log('  graphics94.asm: the TeamBlocks lines read from Extracted\\ again'); }
    const pp = path.join(TOOLS, 'prebuild.js');
    let p = fs.readFileSync(pp, 'utf8');
    if (p.includes("'Custom', 'Graphics'")) {
        const orig = path.join(BACKUP, 'prebuild.js');
        const ob = fs.existsSync(orig) ? fs.readFileSync(orig, 'utf8') : null;
        if (ob && !ob.includes("'Custom', 'Graphics'")) { fs.writeFileSync(pp, ob); console.log('  tools\\prebuild.js: original restored'); }
        else die('tools\\prebuild.js was changed by an earlier version of this script and I have no clean copy of it. Restore it with  git checkout tools/prebuild.js  and run again.');
    }
}

{   // tools\packTeamBitmaps.js reading a copy in Custom\Graphics (a workaround for the overwrite): read Extracted\ again
    const pk = path.join(TOOLS, 'packTeamBitmaps.js');
    if (fs.existsSync(pk)) {
        const t = fs.readFileSync(pk, 'utf8');
        const t2 = t.replace(/path\.join\(ROOT,\s*'Custom',\s*'Graphics',\s*'TeamBlocks94\.map\.jim'\)/, "path.join(ROOT, 'Extracted', 'NHL94', 'Graphics', 'TeamBlocks94.map.jim')");
        if (t2 !== t) { keep(pk, 'packTeamBitmaps.js'); fs.writeFileSync(pk, t2); console.log('  tools\\packTeamBitmaps.js: reads Extracted\\NHL94\\Graphics again (the file stays expanded there now)'); }
    }
    for (const f of FILES) {
        const c = path.join(root, 'Custom', 'Graphics', f);
        if (fs.existsSync(c)) console.log(`  note: Custom\\Graphics\\${f} exists. It is no longer used. If you painted in it, copy it over Extracted\\NHL94\\Graphics\\${f} after this finishes.`);
    }
}

// 2. extractor: write the two files in the expanded form
if (!exPatched) {
    let e = extractorText();
    const anchor = 'async function extractAssets(romPath, options = {}) {';
    const loopOld = '            const assetData = romData.slice(start, end);';
    if (!e.includes(anchor) || !e.includes(loopOld)) die('tools\\extractAssets94.js does not look as expected (written for the current upstream source).');
    const helper = [
        EXMARK,
        '// TeamBlocks.map.jim and TeamBlocks94.map.jim hold the unique tiles of the banners plus a map that repeats and mirrors them.',
        '// They are written as one full 11 x 56 tile picture instead: tile N = cell N of the map, nothing repeated or flipped.',
        'const BANNER_FILES = new Set([\'TeamBlocks.map.jim\', \'TeamBlocks94.map.jim\']);',
        String(expandBannerJim),
        '',
        '',
    ].join('\n');
    e = e.replace(anchor, helper + anchor);
    e = e.replace(loopOld, '            let assetData = romData.slice(start, end);\n            if (BANNER_FILES.has(asset.name)) assetData = expandBannerJim(assetData);');
    fs.writeFileSync(path.join(TOOLS, 'extractAssets94.js'), e);
    console.log('  tools\\extractAssets94.js: now writes the banner files expanded');
}

// 3. game code
function replaceBlock(text, startLabel, endLabel, make, file) {
    const nl = nlOf(text), lf = toLF(text);
    const s = lf.search(new RegExp('^' + startLabel + '(?=[\\s;]|$)', 'm'));
    const e = lf.search(new RegExp('^' + endLabel + '(?=[\\s;]|$)', 'm'));
    if (s < 0 || e < 0 || e <= s) die(`${file}: could not find ${startLabel} ... ${endLabel}. This script was written for the current upstream source.`);
    return toNL(lf.slice(0, s) + make(lf.slice(s, e)) + lf.slice(e), nl);
}
function patchCode() {
    let g = rd('graphics94.asm');
    g = g.replace(/;Teamblocksmap\+8: the tiles \(AddTeamBlock\)/, ';Teamblocksmap+10: the tiles, raw, 22 per team (AddTeamBlock, setupTeamBlocksMap)')
         .replace(/;TeamBitmaps\+8: the tiles \(LoadSetupTiles\)/, ';TeamBitmaps+10: the tiles, raw, 22 per team (LoadBannerTiles)');
    wr('graphics94.asm', g);

    let s = rd('setup94.asm');
    s = replaceBlock(s, 'setupTeamBlocksMap', 'defaultsprites', (old) => {
        const guard = /\tcmpi\.w\t#SUD,d0[^\n]*\n\tbne\.s\t\.notsud2\n\tmove\.w\t#VAN,d0\n\.notsud2\n/.exec(old);
        return [
            'setupTeamBlocksMap\t;Copy the home and visitor team blocks (Teamblocksmap) to vram at basetileoffset and basetileoffset+$16.',
            '\t;Every team owns 22 raw tiles in the file, so they go from the ROM to vram by dma: no tile bank is loaded first. ' + MARK,
            '\t;d4 = 1st vram char; return d4 = basetileoffset+$2C. Called from setupice',
            '\tmove.w\td4,(basetileoffset).w',
            '\tmovea.w\t#(TeamBlockMap-M68K_RAM),a1',
            '\tmovea.l\t#Teamblocksmap,a0',
            '\tadda.l\t4(a0),a0',
            '\tmove.l\ta0,-(sp)',
            '\tmove.w\t(HomeTeam).w,d0',
            '\tmove.w\t(basetileoffset).w,d1',
            '\tasl.w\t#5,d1',
            '\tbsr.w\tCopyTeamBlockMapData',
            '\tmovea.l\t(sp)+,a0',
            '\tmove.w\t(VisTeam).w,d0',
            '\tmove.w\t(basetileoffset).w,d1',
            '\taddi.w\t#$16,d1',
            '\tasl.w\t#5,d1',
            '\tbsr.w\tCopyTeamBlockMapData',
            '\tmove.w\t(basetileoffset).w,d4',
            '\taddi.w\t#$2C,d4',
            '\trts',
            'CopyTeamBlockMapData\t;Copy one team\'s 22 block chars from the ROM to vram at d1 by dma (DoDMApro), and store their map words',
            '\t;at (a1)+. The tiles are the raw tile set at Teamblocksmap+10. a0 = map data, d0 = team, d1 = vram address',
            (guard ? guard[0] : '') + '\tmulu.w\t#$2C,d0',
            '\tlea\t4(a0,d0.w),a2',
            '\tmove.w\t#$15,d3',
            '.row',
            '\tmove.w\td1,-(sp)',
            '\tmove.b\t(a2),(a1)',
            '\tandi.w\t#$F800,(a1)',
            '\tlsr.w\t#5,d1',
            '\tori.w\t#$8000,d1',
            '\tor.w\td1,(a1)+',
            '\tmove.w\t(sp)+,d1',
            '\tmoveq\t#0,d2',
            '\tmove.w\t(a2)+,d2',
            '\tandi.w\t#$7FF,d2',
            '\tasl.l\t#5,d2\t;32 bytes per tile',
            '\tmovea.l\t#Teamblocksmap+10,a0',
            '\tadda.l\td2,a0',
            '\tmoveq\t#$10,d0\t;16 words',
            '\tmove.w\td1,-(sp)',
            '\tjsr\t(DoDMApro).l',
            '\tmove.w\t(sp)+,d1',
            '\taddi.w\t#$20,d1',
            '\tdbf\td3,.row',
            '\trts',
            '',
        ].join('\n');
    }, 'setup94.asm');
    wr('setup94.asm', s);

    let o = rd('optsetup94.asm');
    o = replaceBlock(o, 'LoadSetupTiles', 'UpdateRosterPlayers', () => [
        'LoadSetupTiles\t;Reserve the two banner slots (22 chars each): the home banner at char 2, the visitor banner at teambitmapchars.',
        '\t;DrawTeamBitmap (LoadBannerTiles) loads the tiles of the team shown into them. Return d4 = first free char. Called from setoptions',
        '\tmoveq\t#2+22,d4',
        '\tmove.w\td4,(teambitmapchars).w',
        '\taddi.w\t#22,d4',
        '\trts',
        '',
    ].join('\n'), 'optsetup94.asm');
    wr('optsetup94.asm', o);

    let a = rd('attract94.asm');
    const nl = nlOf(a);
    let lf = toLF(a);
    const need = (from, to) => { if (lf.split(from).length !== 2) die('attract94.asm: DrawMatchupBitmaps does not look as expected.'); lf = lf.replace(from, to); };
    need('\tmove.w\t(teambitmapchars).w,d4\n\tbsr.w\tDrawTeamBitmap\n', '\tmove.w\t(teambitmapchars).w,d4\n\tmoveq\t#1,d2\t;visitor colours\n\tbsr.w\tDrawTeamBitmap\n');
    need('\tmove.w\t#2,d4\n\tbsr.w\tDrawTeamBitmap\n', '\tmove.w\t#2,d4\n\tmoveq\t#0,d2\t;home colours\n\tbsr.w\tDrawTeamBitmap\n');
    a = toNL(lf, nl);
    a = replaceBlock(a, 'DrawTeamBitmap', 'dotb', (old) => {
        const guard = /\tcmpi\.w\t#SUD,d1[^\n]*\n\tbne\.s\t\.notsud1\n\tmove\.w\t#VAN,d1\n\.notsud1\n/.exec(old);
        return [
            'DrawTeamBitmap\t;Draw banner d1 (team) from the TeamBitmaps map at the 22 char slot d4; d2 = 0 home colours, 1 visitor colours.',
            '\t;The 22 tiles of the team are loaded into the slot first (LoadBannerTiles). The map holds absolute tile numbers (team * 22 + n),',
            '\t;so d4 is lowered by team * 22 for dobitmap',
            (guard ? guard[0] : '') + '\tbsr.w\tLoadBannerTiles',
            '\tmove.w\td1,d0',
            '\tmulu.w\t#22,d0',
            '\tsub.w\td0,d4',
            '\tclr.w\td0',
            '\tasl.w\t#1,d1',
            '\tmovea.l\t#TeamBitmaps,a0',
            '\tmovea.l\ta0,a1',
            '\tadda.l\t(a0),a0',
            '\tadda.l\t4(a1),a1',
            /movea\.l\t#NoTiles,a2/.test(old) ? '\tmovea.l\t#NoTiles,a2' : '\tmovea.w\t#NoTiles,a2',
            '\tmove.w\t(a1),d2',
            '\tmoveq\t#2,d3',
            '\tmoveq\t#0,d5',
            '\tbra.w\tdobitmap',
            '',
            'LoadBannerTiles\t;Load the 22 raw tiles of banner d1 (team, TeamBitmaps+10) into vram at char d4. d2 = 0 as they are, else the',
            '\t;visitor colours (colours 1-2 and 3-4 swapped by remap). Keeps every register',
            '\tmovem.l\td0-d2/a0-a1,-(sp)',
            '\tmulu.w\t#$2C0,d1',
            '\tmovea.l\t#TeamBitmaps+10,a0',
            '\tadda.l\td1,a0',
            '\tmove.w\td4,d1',
            '\tasl.w\t#5,d1\t;vram address',
            '\tmove.w\t#$160,d0\t;22 tiles = $160 words',
            '\ttst.w\td2',
            '\tbne.s\t.vis',
            '\tjsr\t(DoDMApro).l',
            '\tbra.s\t.x',
            '.vis',
            '\tlea\t.swap(pc),a1',
            '\tjsr\t(remap).l',
            '.x',
            '\tmovem.l\t(sp)+,d0-d2/a0-a1',
            '\trts',
            '.swap\tdc.l\t$03412567,$89ABCDEF\t;remap table, the same one LoadSetupTiles used',
            '',
        ].join('\n');
    }, 'attract94.asm');
    wr('attract94.asm', a);
}
if (branch) {
    // The branch returns d4 = 2 + 2 x (tiles in the TeamBitmaps file) from LoadSetupTiles, to keep retail's char layout. The expanded
    // file has 616 tiles instead of 398, which would push the framer and fonts 436 chars up, into the maps. Pin it to retail's value.
    let o = rd('optsetup94.asm');
    const lf = toLF(o), nl = nlOf(o);
    const from = '\tmove.w\t(TeamBitmaps+8).l,d4\n\tandi.w\t#$7FFF,d4\n\tadd.w\td4,d4\n\taddq.w\t#2,d4\n';
    if (lf.includes(from)) {
        keep(path.join(SRC, 'optsetup94.asm'), 'optsetup94.asm');
        wr('optsetup94.asm', toNL(lf.replace(from, '\tmove.w\t#2+2*398,d4\t;retail value: 398 tiles in the retail TeamBlocks94 file, loaded twice. A fixed number, so the expanded file (616 tiles) does not move the framer and fonts\n'), nl));
        console.log('  optsetup94.asm: LoadSetupTiles returns the fixed retail char (798) instead of counting the tiles of the file');
    } else if (!lf.includes('#2+2*398,d4')) die('optsetup94.asm: LoadSetupTiles does not look like the patch/teamblock-vram version.');
    console.log('  game code: branch patch/teamblock-vram found, its code is kept');
}
else if (hasMark) console.log('  game code is already patched');
else { patchCode(); console.log('  game code patched (setup94.asm, optsetup94.asm, attract94.asm)'); }

// 4. extract again, so the files in Extracted\ are the expanded ones right now
console.log('  extracting the assets again ...');
const r = spawnSync(process.execPath, [path.join(TOOLS, 'extractAssets94.js'), path.join(root, 'lst', 'nhl94.bin')], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
if (r.status !== 0) die('the extractor failed:\n' + (r.stdout || '') + (r.stderr || ''));

// 5. check the result against the ROM's own (condensed) data, picture for picture
const rom = fs.readFileSync(path.join(root, 'lst', 'nhl94.bin'));
const ROMPOS = { 'TeamBlocks.map.jim': [0xABA14, 0xAFE12], 'TeamBlocks94.map.jim': [0xAFE12, 0xB3530] };
for (const f of FILES) {
    const j = parseJim(fs.readFileSync(path.join(EXTR, f)), f);
    if (!isExpanded(j)) die(`${f} came out condensed. Something went wrong with the extractor patch.`);
    const o = parseJim(rom.subarray(...ROMPOS[f]), 'ROM ' + f);
    if (renderCells(o).join('|') !== renderCells(j).join('|')) die(`${f}: the expanded picture differs from the original. Not continuing.`);
    if (!expandBannerJim(rom.subarray(...ROMPOS[f])).equals(fs.readFileSync(path.join(EXTR, f)))) die(`${f}: the extracted file is not what the expansion produces.`);
    console.log(`  ${f}: ${o.n} unique tiles -> ${j.n} tiles = ${j.mw} x ${j.mh} full picture; checked pixel for pixel against the original.`);
}
pngModes(false);

console.log('\nDone. Build with  npm run build:dev');
console.log('THE FILES:  ' + EXTR);
console.log('  TeamBlocks.map.jim / TeamBlocks94.map.jim : one full 11 x 56 tile picture each, nothing repeated or mirrored.');
console.log('  TeamBlocks.png / TeamBlocks94.png         : the same picture to look at or paint in (keep it 16 colour indexed).');
console.log('  After painting in a PNG:  node expand_banners.js --import-png   writes it back into the .jim files.');
console.log('Originals: backup_before_banners\\.   Undo: node expand_banners.js --undo');
