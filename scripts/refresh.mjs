#!/usr/bin/env node
// scripts/refresh.mjs — pull live 2026 World Cup data, rebuild state.json,
// run the Monte Carlo, and write odds.json. Designed for a GitHub Actions
// cron (every 3h) but runs fine locally: `node scripts/refresh.mjs`.
//
// Source of truth for the SCHEDULE is data/seed.json (all 72 group fixtures
// with dates). We overlay live RESULTS from ESPN onto that schedule, so a
// transient ESPN hiccup degrades to "last known schedule" rather than data loss.
//
// Primary data: ESPN hidden API (no auth, CORS *). Fallback: thesportsdb.

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import M77 from '../model.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA = join(ROOT, 'data');

const ESPN_STANDINGS = 'https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings';
const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260719';
const SDB_FIXTURES = 'https://www.thesportsdb.com/api/v1/json/3/eventsseason.php?id=4429';

// Canonical seed-name aliases (ESPN/feeds use various display forms).
const ALIAS = {
  'Türkiye': 'Turkey', 'Turkiye': 'Turkey', 'Turkey': 'Turkey',
  'Curaçao': 'Curacao', 'Curacao': 'Curacao',
  'Czechia': 'Czech Republic', 'Czech Republic': 'Czech Republic',
  'Côte d’Ivoire': 'Ivory Coast', 'Côte d\'Ivoire': 'Ivory Coast', 'Ivory Coast': 'Ivory Coast', 'Cote d\'Ivoire': 'Ivory Coast',
  'Bosnia & Herzegovina': 'Bosnia and Herzegovina', 'Bosnia and Herzegovina': 'Bosnia and Herzegovina', 'Bosnia-Herzegovina': 'Bosnia and Herzegovina',
  'DR Congo': 'DR Congo', 'Congo DR': 'DR Congo', 'Democratic Republic of the Congo': 'DR Congo',
  'South Korea': 'South Korea', 'Korea Republic': 'South Korea', 'Republic of Korea': 'South Korea',
  'United States': 'United States', 'USA': 'United States', 'United States of America': 'United States',
  'Saudi Arabia': 'Saudi Arabia', 'Cape Verde': 'Cape Verde', 'Cabo Verde': 'Cape Verde',
  'New Zealand': 'New Zealand', 'South Africa': 'South Africa',
};
const norm = (n) => ALIAS[n] || (n || '').trim();

async function getJSON(url, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'match77-odds/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(to); }
}

// Pull completed group-stage results from ESPN scoreboard, keyed by the
// unordered team pair "A||B" (sorted) -> {teamA score, teamB score}.
function parseEspnResults(scoreboard) {
  const map = new Map();
  for (const ev of scoreboard.events || []) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;
    const st = ev.status?.type || comp.status?.type || {};
    if (!st.completed) continue;
    const cs = comp.competitors || [];
    if (cs.length !== 2) continue;
    const c0 = cs[0], c1 = cs[1];
    const n0 = norm(c0.team?.displayName), n1 = norm(c1.team?.displayName);
    const s0 = Number(c0.score), s1 = Number(c1.score);
    if (!n0 || !n1 || Number.isNaN(s0) || Number.isNaN(s1)) continue;
    const key = [n0, n1].sort().join('||');
    map.set(key, { [n0]: s0, [n1]: s1 });
  }
  return map;
}

function parseSdbResults(sdb) {
  const map = new Map();
  for (const ev of sdb.events || []) {
    const hs = ev.intHomeScore, as = ev.intAwayScore;
    if (hs == null || as == null || hs === '' || as === '') continue;
    const h = norm(ev.strHomeTeam), a = norm(ev.strAwayTeam);
    if (!h || !a) continue;
    const key = [h, a].sort().join('||');
    map.set(key, { [h]: Number(hs), [a]: Number(as) });
  }
  return map;
}

// Overlay a results map onto the seed schedule -> fresh state.
function applyResults(seed, results) {
  const state = { meta: { ...seed.meta }, team_strengths: seed.team_strengths, groups: {} };
  let played = 0, total = 0;
  for (const [L, g] of Object.entries(seed.groups)) {
    // Reconstruct the full fixture schedule for this group from seed.
    const schedule = [];
    for (const r of g.played_results) schedule.push({ home: r.home, away: r.away, date: r.date, seedScore: { hs: r.home_score, as: r.away_score } });
    for (const f of g.remaining_fixtures) schedule.push({ home: f.home, away: f.away, date: f.date });

    const played_results = [], remaining_fixtures = [];
    for (const fx of schedule) {
      total++;
      const key = [norm(fx.home), norm(fx.away)].sort().join('||');
      const live = results.get(key);
      if (live && live[norm(fx.home)] != null && live[norm(fx.away)] != null) {
        played_results.push({ home: fx.home, away: fx.away, home_score: live[norm(fx.home)], away_score: live[norm(fx.away)], date: fx.date });
        played++;
      } else if (fx.seedScore) {
        // No live row but seed had a score (already-played at snapshot time) — keep it.
        played_results.push({ home: fx.home, away: fx.away, home_score: fx.seedScore.hs, away_score: fx.seedScore.as, date: fx.date });
        played++;
      } else {
        remaining_fixtures.push({ home: fx.home, away: fx.away, date: fx.date });
      }
    }
    // Recompute display standings from played_results via the model.
    const teamNames = g.teams.map((t) => t.name);
    const ranks = {}; for (const n of teamNames) ranks[n] = seed.team_strengths[n]?.fifa_rank ?? 999;
    const resForStandings = played_results.map((r) => ({ home: r.home, away: r.away, hs: r.home_score, as: r.away_score, played: true }));
    const standings = M77.computeStandings(teamNames, resForStandings, ranks);
    const teams = standings.map((s) => ({ name: s.team, played: s.p, won: s.w, drawn: s.d, lost: s.l, gf: s.gf, ga: s.ga, points: s.pts }));

    state.groups[L] = { teams, played_results, remaining_fixtures };
  }
  state.meta.matches_played = played;
  state.meta.matches_total = total;
  return state;
}

async function main() {
  const stamp = process.env.REFRESH_STAMP || new Date().toISOString();
  const seed = JSON.parse(readFileSync(join(DATA, 'seed.json'), 'utf8'));
  const annexC = JSON.parse(readFileSync(join(DATA, 'annex-c.json'), 'utf8'));
  M77.setAnnexCTable(annexC);

  let results = null, source = null, espnMatch77 = null;

  // ---- Primary: ESPN ----
  try {
    const [standings, scoreboard] = await Promise.all([
      getJSON(ESPN_STANDINGS).catch(() => null),
      getJSON(ESPN_SCOREBOARD),
    ]);
    results = parseEspnResults(scoreboard);
    source = 'espn';
    // Capture the literal Match 77 slot (flips to real teams once resolved).
    const m = (scoreboard.events || []).find((e) => (e.date || '').startsWith('2026-06-30T21'));
    if (m) {
      const cs = m.competitions?.[0]?.competitors || [];
      espnMatch77 = {
        shortName: m.shortName, name: m.name, date: m.date,
        competitors: cs.map((c) => ({ team: c.team?.displayName, abbr: c.team?.abbreviation, homeAway: c.homeAway, score: c.score })),
        statusDetail: m.status?.type?.shortDetail,
      };
    }
    console.log(`ESPN OK — ${results.size} completed results parsed.`);
  } catch (e) {
    console.warn(`ESPN failed (${e.message}); trying thesportsdb fallback.`);
  }

  // ---- Fallback: thesportsdb ----
  if (!results || results.size === 0) {
    try {
      const sdb = await getJSON(SDB_FIXTURES);
      results = parseSdbResults(sdb);
      source = 'thesportsdb';
      console.log(`thesportsdb OK — ${results.size} results parsed.`);
    } catch (e) {
      console.warn(`thesportsdb failed (${e.message}).`);
    }
  }

  // ---- Degrade gracefully: if all live sources fail, fall back to seed scores ----
  if (!results) { results = new Map(); source = 'seed-only'; console.warn('No live data; using seed snapshot only.'); }

  const state = applyResults(seed, results);
  state.meta.data_source = source;
  state.meta.last_refresh = stamp;
  state.meta.espn_match77 = espnMatch77;

  writeFileSync(join(DATA, 'state.json'), JSON.stringify(state, null, 2));
  console.log(`state.json written — ${state.meta.matches_played}/${state.meta.matches_total} group matches played (source: ${source}).`);

  // ---- Run the Monte Carlo and persist precomputed odds ----
  const N = Number(process.env.MC_N || 120000);
  const odds = M77.monteCarlo(state, { N, seed: 0xC0FFEE });

  const sortObj = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
  const out = {
    generated_at: stamp,
    data_source: source,
    matches_played: state.meta.matches_played,
    matches_total: state.meta.matches_total,
    espn_match77: espnMatch77,
    N,
    groupIWinner: sortObj(odds.groupIWinner),
    slot1IOpponent: sortObj(odds.slot1IOpponent),
    opponentByGroup: sortObj(odds.opponentByGroup),
    thirdPlaceQual: sortObj(odds.thirdPlaceQual),
    homeAdvanceOverall: odds.homeAdvanceOverall,
    matchups: odds.matchups.slice(0, 40),
    noOpponentRate: odds.meta.noOpponentRate,
  };
  writeFileSync(join(DATA, 'odds.json'), JSON.stringify(out, null, 2));
  console.log(`odds.json written — France group ${((odds.groupIWinner['France'] || 0) * 100).toFixed(1)}%, winner advances ${((odds.homeAdvanceOverall || 0) * 100).toFixed(1)}% (N=${N}).`);
}

main().catch((e) => { console.error('refresh failed:', e); process.exit(1); });
