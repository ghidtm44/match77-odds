// model.js — Monte Carlo engine for 2026 FIFA World Cup "Match 77"
// ===========================================================================
// Match 77 (MetLife Stadium, East Rutherford NJ — June 30 2026, 5:00 PM ET):
//     WINNER of Group I   vs   BEST 3rd-place team allocated to slot 1I,
//                               drawn from Groups C / D / F / G / H.
//
// One module, two runtimes:
//   • Browser  — loaded as a plain <script>; everything hangs off window.M77.
//   • Node     — `import` / `require` via the CommonJS shim at the bottom.
//
// Methodology follows the verified research brief (FIFA Art. 13 tiebreakers,
// Elo→Poisson goal model, canonical 495-row Annex C lookup). No dependencies.
// ===========================================================================
(function (root) {
  'use strict';

  // -------------------------------------------------------------------------
  // Tunable model constants. Calibrated to the market sanity bands in the
  // brief (France ~0.65 to win Group I; ~0.72–0.82 to advance from Match 77).
  // -------------------------------------------------------------------------
  const PARAMS = {
    ELO_BASE: 400,        // Elo logistic base
    TOTAL_GOALS: 2.6,     // expected total goals in a neutral match (sum of λ)
    GAMMA: 1.0,           // favorite-sharpening exponent on the goal split (1.0 = linear, most defensible)
    RHO: -0.05,           // Dixon–Coles low-score (draw) correction
    MAXG: 10,             // Poisson truncation for the closed-form W/D/L grid
    HOST_ELO_BONUS: 0,    // neutral: every WC venue is in a host nation
    ET_SKILL_SHARE: 0.5,  // knockout: share of draw mass resolved by skill vs ~coin-flip
    MC_DEFAULT: 20000,    // default browser simulation count
  };

  // Host nations — kept for completeness; HOST_ELO_BONUS is 0 by default.
  const HOSTS = new Set(['Mexico', 'Canada', 'United States']);

  // The eight winner-slots that receive a third-placed team, and the groups
  // each may draw from (read off the official R32 bracket). Slot "I" is ours.
  const SLOT_ELIGIBILITY = {
    A: ['C', 'E', 'F', 'H', 'I'],
    B: ['E', 'F', 'G', 'I', 'J'],
    D: ['B', 'E', 'F', 'I', 'J'],
    E: ['A', 'B', 'C', 'D', 'F'],
    G: ['A', 'E', 'H', 'I', 'J'],
    I: ['C', 'D', 'F', 'G', 'H'],   // <-- Match 77's third-place slot
    K: ['D', 'E', 'I', 'J', 'L'],
    L: ['E', 'H', 'I', 'J', 'K'],
  };
  const SLOT_ORDER = ['A', 'B', 'D', 'E', 'G', 'I', 'K', 'L'];

  // The canonical FIFA Annex C table: { "<8 sorted group letters>": {1A:"3X",...} }.
  // Loaded from data/annex-c.json. When present it is authoritative; the
  // reconstruction below is only a fallback used if the table is absent.
  let ANNEX_C_TABLE = null;
  function setAnnexCTable(t) { ANNEX_C_TABLE = t; }

  // =========================================================================
  // Seedable RNG (mulberry32) — reproducible baselines.
  // =========================================================================
  function makeRng(seed = 0x9e3779b9) {
    let a = seed >>> 0;
    return function rng() {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // =========================================================================
  // Match outcome model: Elo edge -> goal supremacy -> two Poisson goal means.
  // =========================================================================
  function lambdas(Ra, Rb, homeAdv = 0) {
    const dr = (Ra + homeAdv) - Rb;
    const We = 1 / (1 + Math.pow(10, -dr / PARAMS.ELO_BASE));
    const g = PARAMS.GAMMA;
    const sA = Math.pow(We, g) / (Math.pow(We, g) + Math.pow(1 - We, g));
    return { lambdaA: PARAMS.TOTAL_GOALS * sA, lambdaB: PARAMS.TOTAL_GOALS * (1 - sA) };
  }

  function poissonSample(lambda, rng) {
    // Knuth — fine for the small λ (<5) we deal with.
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= rng(); } while (p > L);
    return k - 1;
  }

  function sampleScore(Ra, Rb, rng, homeAdv = 0) {
    const { lambdaA, lambdaB } = lambdas(Ra, Rb, homeAdv);
    return { a: poissonSample(lambdaA, rng), b: poissonSample(lambdaB, rng) };
  }

  // -------------------------------------------------------------------------
  // Closed-form W/D/L with Dixon–Coles draw correction — for the display
  // tiles only (the simulator samples integer scores instead).
  // -------------------------------------------------------------------------
  const FACT = (() => { const f = [1]; for (let i = 1; i <= 20; i++) f[i] = f[i - 1] * i; return f; })();
  function factorial(n) { return FACT[n] ?? (() => { let r = FACT[20]; for (let i = 21; i <= n; i++) r *= i; return r; })(); }
  function pois(l, k) { return Math.exp(-l) * Math.pow(l, k) / factorial(k); }
  function dcTau(i, j, la, lb, rho) {
    if (i === 0 && j === 0) return 1 - la * lb * rho;
    if (i === 0 && j === 1) return 1 + la * rho;
    if (i === 1 && j === 0) return 1 + lb * rho;
    if (i === 1 && j === 1) return 1 - rho;
    return 1;
  }
  function wdl(Ra, Rb, homeAdv = 0) {
    const { lambdaA, lambdaB } = lambdas(Ra, Rb, homeAdv);
    let pA = 0, pD = 0, pB = 0;
    for (let i = 0; i <= PARAMS.MAXG; i++) {
      for (let j = 0; j <= PARAMS.MAXG; j++) {
        const p = pois(lambdaA, i) * pois(lambdaB, j) * dcTau(i, j, lambdaA, lambdaB, PARAMS.RHO);
        if (i > j) pA += p; else if (i === j) pD += p; else pB += p;
      }
    }
    const t = pA + pD + pB;
    return { pWin: pA / t, pDraw: pD / t, pLoss: pB / t };
  }

  // Knockout: P(A advances) — redistribute draw mass via ET (skill) + pens (~coin).
  function knockoutAdvance(Ra, Rb) {
    const { pWin, pDraw, pLoss } = wdl(Ra, Rb, 0);
    const skillShare = (pWin + pLoss) > 0 ? pWin / (pWin + pLoss) : 0.5;
    const fromDraw = pDraw * (PARAMS.ET_SKILL_SHARE * skillShare + (1 - PARAMS.ET_SKILL_SHARE) * 0.5);
    return pWin + fromDraw;
  }

  // =========================================================================
  // Standings. Two DIFFERENT comparators (this distinction matters — see brief):
  //   • within-group : points -> H2H(points,GD,GF) -> overall GD -> overall GF
  //   • cross-group  : points -> overall GD -> overall GF   (no H2H possible)
  // Final, unbreakable tiebreak in BOTH: better (lower) FIFA rank, then a
  // deterministic name hash so a trial is never ambiguous.
  // =========================================================================
  function blankRow(team) { return { team, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 }; }

  function accumulate(rows, results) {
    for (const m of results) {
      if (!m.played) continue;
      const h = rows.get(m.home), a = rows.get(m.away);
      if (!h || !a) continue;
      h.p++; a.p++;
      h.gf += m.hs; h.ga += m.as; a.gf += m.as; a.ga += m.hs;
      if (m.hs > m.as) { h.w++; h.pts += 3; a.l++; }
      else if (m.hs < m.as) { a.w++; a.pts += 3; h.l++; }
      else { h.d++; a.d++; h.pts++; a.pts++; }
    }
    for (const r of rows.values()) r.gd = r.gf - r.ga;
  }

  function nameHash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h >>> 0; }

  // Static, forecast-free final separators: lower FIFA rank wins; then name hash.
  function staticTiebreak(x, y, ranks) {
    const rx = ranks[x.team] ?? 999, ry = ranks[y.team] ?? 999;
    if (rx !== ry) return rx - ry;
    return nameHash(x.team) - nameHash(y.team);
  }

  // Head-to-head mini-table among a set of tied teams (within-group only).
  function miniTable(subset, played) {
    const set = new Set(subset);
    const t = new Map(subset.map((tm) => [tm, blankRow(tm)]));
    for (const m of played) {
      if (!m.played || !set.has(m.home) || !set.has(m.away)) continue;
      const h = t.get(m.home), a = t.get(m.away);
      h.gf += m.hs; h.ga += m.as; a.gf += m.as; a.ga += m.hs;
      if (m.hs > m.as) h.pts += 3; else if (m.hs < m.as) a.pts += 3; else { h.pts++; a.pts++; }
    }
    for (const r of t.values()) r.gd = r.gf - r.ga;
    return t;
  }

  // WITHIN-GROUP ranking — FIFA 2026 Regulations Article 13, in exact order:
  //   points (all matches)
  //   Step 1 (among teams level on points): H2H points -> H2H GD -> H2H GF
  //   Step 2 (still level): re-apply Step 1 to the still-tied subset only;
  //           if no decision -> overall GD -> overall GF -> conduct(*)
  //   Step 3 (still level): FIFA world ranking, then a deterministic hash.
  // (*) conduct/fair-play cannot be forecast per trial -> we skip straight to
  //     the FIFA-ranking separator, a documented simplification.
  function sameH2H(a, b) { return a.pts === b.pts && a.gd === b.gd && a.gf === b.gf; }

  function overallCmp(a, b, rows, ranks) {
    const ra = rows.get(a), rb = rows.get(b);
    return (rb.gd - ra.gd) || (rb.gf - ra.gf)
      || ((ranks[a] ?? 999) - (ranks[b] ?? 999)) || (nameHash(a) - nameHash(b));
  }

  // Resolve a set of teams that are all level on points (Step 1 -> 2 -> 3).
  function resolveTiedBlock(block, played, rows, ranks) {
    if (block.length === 1) return block.slice();
    const h2h = miniTable(block, played);  // sub-league among these teams only
    const sorted = [...block].sort((a, b) => {
      const ra = h2h.get(a), rb = h2h.get(b);
      return (rb.pts - ra.pts) || (rb.gd - ra.gd) || (rb.gf - ra.gf);
    });
    // partition into equivalence classes by identical H2H (pts,gd,gf)
    const classes = [];
    for (const t of sorted) {
      const last = classes[classes.length - 1];
      if (last && sameH2H(h2h.get(last[0]), h2h.get(t))) last.push(t);
      else classes.push([t]);
    }
    if (classes.length === 1) {
      // H2H separated nothing -> fall through to overall GD/GF/ranking
      return [...block].sort((a, b) => overallCmp(a, b, rows, ranks));
    }
    // H2H produced separation -> place classes in order; recurse into any that
    // remain tied, re-applying H2H "to the matches between the remaining teams only".
    const out = [];
    for (const cls of classes) {
      if (cls.length === 1) out.push(cls[0]);
      else out.push(...resolveTiedBlock(cls, played, rows, ranks));
    }
    return out;
  }

  function computeStandings(teams, results, ranks) {
    const rows = new Map(teams.map((t) => [t, blankRow(t)]));
    accumulate(rows, results);
    const played = results.filter((m) => m.played);

    // Order by points desc, then resolve each equal-points block per Article 13.
    const byPts = [...rows.values()].sort((a, b) => b.pts - a.pts);
    const out = [];
    let i = 0;
    while (i < byPts.length) {
      let j = i;
      while (j < byPts.length && byPts[j].pts === byPts[i].pts) j++;
      const block = byPts.slice(i, j).map((r) => r.team);
      const ordered = block.length === 1 ? block : resolveTiedBlock(block, played, rows, ranks);
      for (const t of ordered) out.push(rows.get(t));
      i = j;
    }
    return out;
  }

  // Cross-group third-place ranking — NO head-to-head step.
  function rankThirds(thirds, ranks) {
    return [...thirds].sort((x, y) => {
      const base = (y.row.pts - x.row.pts) || (y.row.gd - x.row.gd) || (y.row.gf - x.row.gf);
      if (base) return base;
      return staticTiebreak(x.row, y.row, ranks);
    });
  }

  // =========================================================================
  // Simulate one group. `pinned` = { [fixtureKey]: {hs,as} } forces a score
  // (drives the scenario simulator). fixtureKey = `${home}__${away}`.
  // =========================================================================
  function fixtureKey(home, away) { return `${home}__${away}`; }

  // Build a reusable per-group plan: fixed (played/pinned) rows + precomputed
  // λ for each remaining fixture. λ never changes across trials, so computing
  // it once here removes millions of Math.pow calls from the hot loop.
  function buildGroupPlan(group, strengths, pinned) {
    const fixed = [];
    for (const m of group.played_results) {
      fixed.push({ home: m.home, away: m.away, hs: m.home_score, as: m.away_score, played: true });
    }
    const sim = [];
    for (const fx of group.remaining_fixtures) {
      const key = fixtureKey(fx.home, fx.away);
      if (pinned && pinned[key]) {
        fixed.push({ home: fx.home, away: fx.away, hs: pinned[key].hs, as: pinned[key].as, played: true });
        continue;
      }
      const rA = strengths[fx.home]?.elo ?? 1500;
      const rB = strengths[fx.away]?.elo ?? 1500;
      const ha = (HOSTS.has(fx.home) ? PARAMS.HOST_ELO_BONUS : 0) - (HOSTS.has(fx.away) ? PARAMS.HOST_ELO_BONUS : 0);
      const { lambdaA, lambdaB } = lambdas(rA, rB, ha);
      sim.push({ home: fx.home, away: fx.away, lambdaA, lambdaB });
    }
    return { teams: group.teams.map((t) => t.name), fixed, sim };
  }

  function simulateFromPlan(plan, rng, ranks) {
    const results = plan.fixed.slice();
    for (const s of plan.sim) {
      results.push({ home: s.home, away: s.away, hs: poissonSample(s.lambdaA, rng), as: poissonSample(s.lambdaB, rng), played: true });
    }
    return computeStandings(plan.teams, results, ranks);
  }

  // Back-compat single-shot helper (used by tests).
  function simulateGroup(group, strengths, rng, pinned) {
    return simulateFromPlan(buildGroupPlan(group, strengths, pinned), rng, ranksFromStrengths(strengths));
  }

  function ranksFromStrengths(strengths) {
    const r = {};
    for (const k of Object.keys(strengths)) r[k] = strengths[k]?.fifa_rank ?? 999;
    return r;
  }

  // =========================================================================
  // Allocate the 8 qualifying third-place groups to the 8 winner slots.
  // Canonical table first; deterministic matching fallback otherwise.
  // =========================================================================
  function allocate(qualifyingGroups) {
    if (ANNEX_C_TABLE) {
      const key = [...qualifyingGroups].sort().join('');
      const row = ANNEX_C_TABLE[key];
      if (row) return row;  // {1A:"3E",...,"1I":"3G",...}
    }
    return reconstructMatching(qualifyingGroups);
  }

  function reconstructMatching(qualifyingGroups) {
    const groups = new Set(qualifyingGroups);
    const assignment = {}, groupToSlot = {};
    const tryAssign = (slot, visited) => {
      for (const g of SLOT_ELIGIBILITY[slot]) {
        if (!groups.has(g) || visited.has(g)) continue;
        visited.add(g);
        if (!groupToSlot[g] || tryAssign(groupToSlot[g], visited)) {
          assignment['1' + slot] = '3' + g; groupToSlot[g] = slot; return true;
        }
      }
      return false;
    };
    for (const slot of SLOT_ORDER) tryAssign(slot, new Set());
    return assignment;
  }

  // =========================================================================
  // THE MAIN ENTRY POINT.
  //   monteCarlo(state, opts) -> probability tables for Match 77.
  //   state = { groups:{A..L}, team_strengths }   (seed.json / state.json)
  //   opts  = { N, pinned, seed }
  // =========================================================================
  function monteCarlo(state, opts = {}) {
    const N = opts.N ?? PARAMS.MC_DEFAULT;
    const pinned = opts.pinned ?? {};
    const rng = makeRng((opts.seed ?? 0x1234567) >>> 0);
    const strengths = state.team_strengths;
    const letters = Object.keys(state.groups);
    const ranks = ranksFromStrengths(strengths);

    // Precompute each group's plan once (λ's are trial-invariant).
    const plans = {};
    for (const L of letters) plans[L] = buildGroupPlan(state.groups[L], strengths, pinned);

    // Memoized knockout advance probability (≤ a few dozen distinct matchups).
    const koCache = new Map();
    const ko = (a, b) => {
      const k = a + '|' + b;
      let v = koCache.get(k);
      if (v === undefined) { v = knockoutAdvance(strengths[a]?.elo ?? 1500, strengths[b]?.elo ?? 1500); koCache.set(k, v); }
      return v;
    };

    const winnerI = {}, opp1I = {}, matchup = {}, oppGroupCount = {}, thirdQual = {};
    let noOpp = 0;

    for (const t of state.groups['I'].teams) winnerI[t.name] = 0;
    for (const L of ['C', 'D', 'F', 'G', 'H']) {
      for (const t of state.groups[L].teams) thirdQual[t.name] = 0;
      oppGroupCount['3' + L] = 0;
    }

    for (let i = 0; i < N; i++) {
      const finals = {}, thirds = [];
      for (const L of letters) {
        const s = simulateFromPlan(plans[L], rng, ranks);
        finals[L] = s;
        if (s[2]) thirds.push({ group: L, team: s[2].team, row: s[2] });
      }

      const iWinner = finals['I']?.[0]?.team;
      if (iWinner != null) winnerI[iWinner] = (winnerI[iWinner] ?? 0) + 1;

      const ranked = rankThirds(thirds, ranks);
      const top8 = ranked.slice(0, 8);
      const qualifyingGroups = top8.map((t) => t.group);
      const assign = allocate(qualifyingGroups);
      const oppCode = assign ? assign['1I'] : null;          // e.g. "3F"
      const oppGroup = oppCode ? oppCode.slice(1) : null;     // "F"
      const oppTeam = oppGroup ? finals[oppGroup]?.[2]?.team : null;

      if (oppTeam) {
        opp1I[oppTeam] = (opp1I[oppTeam] ?? 0) + 1;
        thirdQual[oppTeam] = (thirdQual[oppTeam] ?? 0) + 1;
        oppGroupCount[oppCode] = (oppGroupCount[oppCode] ?? 0) + 1;
        if (iWinner) {
          const key = `${iWinner}|${oppTeam}`;
          if (!matchup[key]) matchup[key] = { home: iWinner, away: oppTeam, n: 0, homeAdv: 0 };
          matchup[key].n++;
          // accumulate P(Group I winner advances) for this realized matchup
          matchup[key].homeAdv += ko(iWinner, oppTeam);
        }
      } else {
        noOpp++;
      }
    }

    const norm = (obj) => { const o = {}; for (const k of Object.keys(obj)) o[k] = obj[k] / N; return o; };

    // Build the matchup list with the realized average advance probability.
    const matchups = Object.values(matchup).map((m) => ({
      home: m.home, away: m.away,
      prob: m.n / N,
      homeAdvances: m.homeAdv / m.n,   // P(Group I winner wins the tie | this matchup)
    })).sort((a, b) => b.prob - a.prob);

    // Overall P(Group I winner advances) marginalized over all opponents.
    let advance = 0, advN = 0;
    for (const m of Object.values(matchup)) { advance += m.homeAdv; advN += m.n; }
    const homeAdvanceOverall = advN ? advance / advN : null;

    return {
      groupIWinner: norm(winnerI),
      slot1IOpponent: norm(opp1I),
      opponentByGroup: norm(oppGroupCount),
      thirdPlaceQual: norm(thirdQual),
      matchups,
      homeAdvanceOverall,
      meta: { N, noOpponentRate: noOpp / N, seed: (opts.seed ?? 0x1234567) >>> 0, pinnedCount: Object.keys(pinned).length },
    };
  }

  // =========================================================================
  // Exports
  // =========================================================================
  const API = {
    PARAMS, HOSTS, SLOT_ELIGIBILITY, SLOT_ORDER,
    setAnnexCTable, makeRng, lambdas, sampleScore, wdl, knockoutAdvance,
    computeStandings, rankThirds, simulateGroup, allocate, reconstructMatching,
    monteCarlo, fixtureKey,
  };
  root.M77 = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
