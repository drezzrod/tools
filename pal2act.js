#!/usr/bin/env node
// pal2act.js - convert Genesis .pal files (NHL94: 16 colours x 2 bytes, 0000BBB0GGG0RRR0, big endian) to
// Adobe Color Table (.act) files that Photoshop, GIMP, Aseprite, etc. can load.
//
//   node pal2act.js MatchupPalANHA.pal                 writes MatchupPalANHA.act next to it
//   node pal2act.js a.pal b.pal c.pal                  several files at once
//   node pal2act.js <folder>                           every .pal in the folder
//   options:  --out <folder>   put the .act files there
//             --short          write the 772 byte form (768 colours + count + transparent index) so the
//                              editor knows there are only 16 colours (colour 0 = transparent)
//
// A .pal of 32 bytes is one palette line; 64 or 128 bytes (2 or 4 lines) fill the ACT in order, 16 per line.
// Each 3 bit channel value 0-7 becomes 0,36,73,109,146,182,219,255. Unused ACT entries are black.
'use strict';
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2), files = []; let out = null, short = false;
for (let i = 0; i < a.length; i++) { if (a[i] === '--out') out = a[++i]; else if (a[i] === '--short') short = true; else files.push(a[i]); }
if (!files.length) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); process.exit(0); }
const list = [];
for (const f of files) {
    if (!fs.existsSync(f)) { console.error('not found: ' + f); process.exit(1); }
    if (fs.statSync(f).isDirectory()) fs.readdirSync(f).filter((x) => /\.pal$/i.test(x)).forEach((x) => list.push(path.join(f, x))); else list.push(f);
}
if (out) fs.mkdirSync(out, { recursive: true });
for (const f of list) {
    const b = fs.readFileSync(f);
    if (b.length % 32 || b.length > 128 || !b.length) { console.error(`skipped ${f}: ${b.length} bytes (expected 32, 64, 96 or 128)`); continue; }
    const n = b.length / 2, act = Buffer.alloc(768);
    for (let i = 0; i < n; i++) {
        const c = b.readUInt16BE(i * 2);
        act[i * 3] = Math.round(((c >> 1) & 7) * 255 / 7); act[i * 3 + 1] = Math.round(((c >> 5) & 7) * 255 / 7); act[i * 3 + 2] = Math.round(((c >> 9) & 7) * 255 / 7);
    }
    let data = act;
    if (short) { const t = Buffer.alloc(4); t.writeUInt16BE(n, 0); t.writeUInt16BE(0, 2); data = Buffer.concat([act, t]); }
    const dest = path.join(out || path.dirname(f), path.basename(f).replace(/\.pal$/i, '') + '.act');
    fs.writeFileSync(dest, data);
    console.log(`${f} -> ${dest}  (${n} colours)`);
    if (list.length === 1) for (let i = 0; i < n; i++) console.log(`  ${String(i).padStart(2)}  ${b.subarray(i * 2, i * 2 + 2).toString('hex').toUpperCase()}  #${[...act.subarray(i * 3, i * 3 + 3)].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`);
}
