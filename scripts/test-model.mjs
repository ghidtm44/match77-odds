// Model unit + integration tests. Run: node scripts/test-model.mjs
import M77 from '../model.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
let fails = 0;
const ck = (label, ok) => { console.log((ok ? '✅' : '❌') + ' ' + label); if (!ok) fails++; };

const ranks = { A: 1, B: 2, C: 3, D: 4 };

// --- Test 1: within-group H2H must come BEFORE overall GD (FIFA 2026 Art.13) ---
// A & B both finish 6 pts. A beat B head-to-head 1-0, but B has a far better
// overall GD (thrashed C 10-0). FIFA 2026 ranks A first (H2H wins).
const r3 = [
  { home: 'A', away: 'B', hs: 1, as: 0, played: true },   // A beat B (H2H)
  { home: 'A', away: 'C', hs: 2, as: 1, played: true },   // A: 6 pts, GD +2
  { home: 'B', away: 'C', hs: 10, as: 0, played: true },  // B: 6 pts, GD +9
];
const st = M77.computeStandings(['A', 'B', 'C'], r3, ranks);
console.log('  within-group order:', st.map(r => `${r.team}(${r.pts}pt,GD${r.gd})`).join(' > '));
ck('H2H-first: A ranks above B despite worse GD', st[0].team === 'A');

// --- Test 2: cross-group third-place ranking must IGNORE H2H, use overall GD ---
const thirds = [
  { group: 'X', team: 'A', row: { pts: 6, gd: 2, gf: 3 } },
  { group: 'Y', team: 'B', row: { pts: 6, gd: 9, gf: 10 } },
];
const rt = M77.rankThirds(thirds, ranks);
console.log('  cross-group order:', rt.map(t => `${t.team}(GD${t.row.gd})`).join(' > '));
ck('cross-group: B ranks above A (better overall GD, no H2H)', rt[0].team === 'B');

// --- Test 3: three-way H2H cycle falls through to overall GD ---
// A>B>C>A all 1-0 among themselves (H2H pts/GD/GF identical) + each beat D.
const cyc = [
  { home: 'A', away: 'B', hs: 1, as: 0, played: true },
  { home: 'B', away: 'C', hs: 1, as: 0, played: true },
  { home: 'C', away: 'A', hs: 1, as: 0, played: true },
  { home: 'A', away: 'D', hs: 5, as: 0, played: true },  // A best overall GD
  { home: 'B', away: 'D', hs: 3, as: 0, played: true },
  { home: 'C', away: 'D', hs: 1, as: 0, played: true },
];
const cs = M77.computeStandings(['A', 'B', 'C', 'D'], cyc, ranks);
console.log('  cycle order:', cs.map(r => `${r.team}(GD${r.gd})`).join(' > '));
ck('3-way H2H cycle resolves to overall GD (A>B>C>D)', cs[0].team === 'A' && cs[1].team === 'B' && cs[2].team === 'C');

// --- Test 3b: point-tied teams separated by H2H goals-for, AGAINST overall GD ---
// A,B,C all finish 5 pts (each drew the other two, each beat D). Among themselves
// H2H pts (2 each) and H2H GD (0 each) tie, but H2H GF differs: A=4 > B=C=2.
// B & C have far better OVERALL GD (+5) than A (+1). FIFA 2026 ranks A FIRST on
// H2H GF before overall GD ever applies — the precise rule the bug got wrong.
const gfCase = [
  { home: 'A', away: 'B', hs: 2, as: 2, played: true },
  { home: 'A', away: 'C', hs: 2, as: 2, played: true },
  { home: 'B', away: 'C', hs: 0, as: 0, played: true },
  { home: 'A', away: 'D', hs: 1, as: 0, played: true },  // A overall GD +1
  { home: 'B', away: 'D', hs: 5, as: 0, played: true },  // B overall GD +5
  { home: 'C', away: 'D', hs: 5, as: 0, played: true },  // C overall GD +5
];
const gfRank = M77.computeStandings(['A', 'B', 'C', 'D'], gfCase, ranks);
console.log('  H2H-GF order:', gfRank.map(r => `${r.team}(${r.pts}pt,oGD${r.gd})`).join(' > '));
ck('H2H goals-for ranks A first over higher overall-GD B/C', gfRank[0].team === 'A');

// --- Test 4: allocation always fills slot I from {C,D,F,G,H}, all 495 ---
M77.setAnnexCTable(JSON.parse(readFileSync(join(DATA, 'annex-c.json'), 'utf8')));
const all = ['A','B','C','D','E','F','G','H','I','J','K','L'];
function* kc(a, k, s = 0, acc = []) { if (acc.length === k) { yield acc; return; } for (let i = s; i < a.length; i++) yield* kc(a, k, i + 1, [...acc, a[i]]); }
let bad = 0, n = 0;
for (const combo of kc(all, 8)) { n++; const v = M77.allocate(combo)['1I']; if (!['3C','3D','3F','3G','3H'].includes(v)) bad++; }
ck(`canonical allocation: all ${n} combos give legal slot 1I`, n === 495 && bad === 0);

// --- Test 5: full model vs market sanity bands ---
const state = JSON.parse(readFileSync(join(DATA, 'seed.json'), 'utf8'));
const e = M77.wdl(1800, 1800, 0);
const r = M77.monteCarlo(state, { N: 60000, seed: 7 });
const fr = r.groupIWinner.France, adv = r.homeAdvanceOverall, c3 = r.opponentByGroup['3C'] ?? 0;
console.log(`\n  France group ${(fr*100).toFixed(1)}%, advance ${(adv*100).toFixed(1)}%, even-win ${(e.pWin*100).toFixed(1)}%, 3C ${(c3*100).toFixed(2)}%, noOpp ${(r.meta.noOpponentRate*100).toFixed(2)}%`);
ck('France wins Group I in [0.60,0.78]', fr >= 0.60 && fr <= 0.78);
ck('France advances Match 77 in [0.72,0.82]', adv >= 0.72 && adv <= 0.82);
ck('3C opponent < 1.5%', c3 < 0.015);
ck('even-match win 33-42%', e.pWin >= 0.33 && e.pWin <= 0.42);
ck('opponent distribution sums ~1', Math.abs(Object.values(r.slot1IOpponent).reduce((a,b)=>a+b,0) - 1) < 0.02);
ck('noOpponentRate ~0', r.meta.noOpponentRate < 0.001);

console.log('\n' + (fails === 0 ? '🎉 ALL TESTS PASS' : `💥 ${fails} TEST(S) FAILED`));
process.exit(fails ? 1 : 0);
