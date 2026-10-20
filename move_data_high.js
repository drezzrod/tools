#!/usr/bin/env node
// move_data_high.js - NHL94Genesis: move the team data and the graphics to the END of the ROM.
//
//   node move_data_high.js [path\to\NHL94Genesis]        apply (default folder = current folder)
//   node move_data_high.js [folder] --check              only report what state the source is in
//   node move_data_high.js [folder] --undo               put the original files back
//
// What it does (nothing else is touched):
//   1. src\nhl94.asm     teamdata94.asm and graphics94.asm are no longer included in the low part of
//                        the ROM. They are included again, after checksum94.asm, together with the new
//                        cardsdata94.asm. The "dcb.b $100000-*,$FF" pad line is removed (it would fail
//                        now that the data moves out; tools\fixrom.js pads the ROM to the next size).
//   2. src\cards94.asm   the data block (TeamPalettes, FeaturedPictures and the player card picture
//                        tables) is cut out and written to the new src\cardsdata94.asm. The CODE of
//                        cards94.asm stays where it is (other files call it with bsr.w).
//   3. every src\*.asm   "movea.w #TeamList" and "movea.w #NoTiles" become movea.l: those two labels
//                        used to sit below $8000, where a 16 bit address reaches them.
// The routines that retail calls with short addresses (StartGame, HandleMenuInput ...) stay in the
// low part of the ROM, and now have about 22 KB more room than before, because teamdata94 is gone.
//
// Safe to run twice. Originals are copied to backup_before_highdata\ the first time.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const root = path.resolve(args.find((a) => !a.startsWith('--')) || '.');
const SRC = path.join(root, 'src');
const BACKUP = path.join(root, 'backup_before_highdata');
const MARK = ';HIGHDATA';

function die(msg) { console.error('\nERROR: ' + msg + '\n'); process.exit(1); }
if (!fs.existsSync(path.join(SRC, 'nhl94.asm'))) die(`${SRC}\\nhl94.asm not found. Run this from the NHL94Genesis folder, or give that folder as the first argument.`);

const read = (f) => fs.readFileSync(path.join(SRC, f), 'latin1');
const write = (f, t) => fs.writeFileSync(path.join(SRC, f), t, 'latin1');
const nlOf = (t) => (t.includes('\r\n') ? '\r\n' : '\n');
const splitLines = (t) => t.split(/\r?\n/);

const nhl = read('nhl94.asm');
const applied = nhl.includes(MARK);

if (flags.includes('--undo')) {
    if (!fs.existsSync(BACKUP)) die('no backup_before_highdata folder, nothing to undo.');
    for (const f of fs.readdirSync(BACKUP)) fs.copyFileSync(path.join(BACKUP, f), path.join(SRC, f));
    fs.rmSync(path.join(SRC, 'cardsdata94.asm'), { force: true });
    console.log('Original files restored from backup_before_highdata. (src\\cardsdata94.asm removed.)');
    process.exit(0);
}

if (flags.includes('--check')) {
    console.log(applied ? 'State: ALREADY MOVED (marker found in nhl94.asm).' : 'State: original layout, ready to apply.');
    process.exit(0);
}

if (applied) { console.log('Already applied (' + MARK + ' marker found in nhl94.asm). Nothing to do.'); process.exit(0); }

// ---- 1. find everything first, change nothing until all checks pass ----
const nl = nlOf(nhl);
const lines = splitLines(nhl);
const incIdx = (name) => lines.findIndex((l) => new RegExp('^\\s*include\\s+' + name.replace('.', '\\.') + '(\\s|;|$)', 'i').test(l));
const iTeam = incIdx('teamdata94.asm');
const iGfx = incIdx('graphics94.asm');
const iChk = incIdx('checksum94.asm');
const iFill = lines.findIndex((l) => /^\s*dcb\.b\s+\$100000-\*\s*,\s*\$FF/i.test(l));
if (iTeam < 0) die('"include teamdata94.asm" not found in nhl94.asm');
if (iGfx < 0) die('"include graphics94.asm" not found in nhl94.asm');
if (iChk < 0) die('"include checksum94.asm" not found in nhl94.asm');
if (iChk < iTeam || iChk < iGfx) die('checksum94.asm is expected to be included AFTER teamdata94 and graphics94 (unexpected order).');

const cards = read('cards94.asm');
const cnl = nlOf(cards);
const cl = splitLines(cards);
const cStart = cl.findIndex((l) => /^TeamPalettes(\s|;|$)/.test(l));
const cEnd = cl.findIndex((l) => /^PrintRecordValue(\s|;|$)/.test(l));
if (cStart < 0 || cEnd < 0 || cEnd <= cStart) die('could not find the TeamPalettes ... PrintRecordValue block in cards94.asm (this script was written for the current upstream layout).');
const block = cl.slice(cStart, cEnd);
// The block must be pure data: no instructions at all, or moving it would be wrong.
const bad = block.map((l, i) => [l, i]).filter(([l]) => {
    const t = l.replace(/;.*$/, '').trim();
    if (!t) return false;
    if (/^[A-Za-z_.][\w.]*$/.test(t)) return false;                        // bare label
    if (/^[A-Za-z_.][\w.]*\s+(dc|ds|incbin)\b/i.test(t)) return false;     // label + data
    if (/^(dc\.[bwl]|incbin|even|IF|ENDIF|inform|ELSE)\b/i.test(t)) return false;
    return true;
});
if (bad.length) die('the cards94.asm block holds something other than data, line "' + bad[0][0].trim() + '". Not moving it.');
const incbins = block.filter((l) => /incbin/i.test(l)).length;

// ---- 2. backups ----
if (!fs.existsSync(BACKUP)) {
    fs.mkdirSync(BACKUP);
    fs.copyFileSync(path.join(SRC, 'nhl94.asm'), path.join(BACKUP, 'nhl94.asm'));
    fs.copyFileSync(path.join(SRC, 'cards94.asm'), path.join(BACKUP, 'cards94.asm'));
    for (const f of fs.readdirSync(SRC).filter((x) => /\.asm$/i.test(x))) {
        if (!fs.existsSync(path.join(BACKUP, f)) && /movea\.w\s+#(TeamList|NoTiles)\b/.test(read(f))) fs.copyFileSync(path.join(SRC, f), path.join(BACKUP, f));
    }
}

// ---- 3. cardsdata94.asm ----
const head = [
    ';\tPlayer card DATA, moved out of cards94.asm so it can sit at the end of the ROM (see nhl94.asm):',
    ';\tthe matchup / player card palettes and the featured player picture lists. The player card CODE',
    ';\tstays in cards94.asm because other files reach it with 16 bit branches (bsr.w).',
    ';\tIt refers to the Card... picture labels (graphics94.asm) with long addresses, so the order of the',
    ';\tmoved files does not matter.',
    '',
];
write('cardsdata94.asm', head.concat(block).join(cnl) + cnl);
write('cards94.asm', cl.slice(0, cStart).concat(
    [';\tTeamPalettes and FeaturedPictures (the palettes and the featured player picture lists) now live in cardsdata94.asm, at the end of the ROM.'],
    cl.slice(cEnd)).join(cnl));

// ---- 4. nhl94.asm ----
const out = [];
lines.forEach((l, i) => {
    if (i === iTeam || i === iGfx) return;                  // dropped from the low part
    if (i === iFill) return;                                // 1 MB pad line goes
    out.push(l);
    if (i === iChk) {
        out.push('\teven\t\t\t\t' + MARK + ' everything below here lives at the end of the ROM, after the short-address code');
        out.push('\tinclude\tteamdata94.asm\t\t; moved: teams, rosters, colours, playoff seeds, credits');
        out.push('\teven');
        out.push('\tinclude\tcardsdata94.asm\t\t; moved out of cards94.asm: matchup / player card palettes and featured pictures');
        out.push('\teven');
        out.push('\tinclude\tgraphics94.asm\t\t; moved: all graphics, logos, team blocks, player card pictures');
        out.push('\teven');
    }
});
write('nhl94.asm', out.join(nl));

// ---- 5. short immediates that pointed at TeamList / NoTiles ----
let changed = 0;
for (const f of fs.readdirSync(SRC).filter((x) => /\.asm$/i.test(x))) {
    const t = read(f);
    const t2 = t.replace(/(\b[a-zA-Z]+)\.w(\s+)#(TeamList|NoTiles)\b/g, (m, op, sp, lab) => { changed++; return `${op}.l${sp}#${lab}`; });
    if (t2 !== t) write(f, t2);
}

console.log('Done.');
console.log(`  nhl94.asm     : teamdata94 + cardsdata94 + graphics94 now included after checksum94${iFill >= 0 ? '; 1 MB pad line removed' : ''}`);
console.log(`  cardsdata94.asm : ${block.length} lines, ${incbins} incbin files moved out of cards94.asm`);
console.log(`  ${changed} short "movea.w #TeamList/#NoTiles" changed to movea.l`);
console.log('Originals are in backup_before_highdata\\. To go back: node move_data_high.js --undo');
console.log('Now build with:  npm run build:dev   (build:retail will say MISMATCH, as expected: the layout is no longer retail)');
