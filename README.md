# Match 77 · Who Am I Watching? ⚽

A live odds + scenario-simulator website for **2026 FIFA World Cup Match 77** at
MetLife Stadium (East Rutherford, NJ — Tue June 30 2026, 5:00 PM ET).

Match 77 is a Round-of-32 game whose teams aren't known until the group stage
ends. It pairs the **Winner of Group I** against the **best third-place team**
FIFA routes to slot `1I` — always one of Groups **C, D, F, G, H**. This site
computes, and keeps live, the probability of *exactly who you'll see play* —
and lets you simulate upcoming results to figure out who to root for.

**Live site:** https://ghidtm44.github.io/match77-odds/

## How it works

- **Monte Carlo engine** (`model.js`) simulates tens of thousands of complete
  group stages. Each unplayed match is sampled from team strength (World
  Football Elo) via an Elo→Poisson goal model. Group tables apply the exact
  **FIFA 2026 Article 13 tiebreakers** (points → head-to-head → overall GD/GF).
  The 12 third-place teams are ranked, the top 8 advance, and FIFA's canonical
  **495-row Annex C** table assigns each to a Round-of-32 winner slot. We read
  slot `1I` to get the Match 77 opponent.
- **Annex C** (`data/annex-c.json`) is the verified 495-combination allocation
  table, parsed from FIFA's official regulations PDF. The slot-`1I` column
  distribution is 3F×276, 3D×99, 3G×70, 3H×48, 3C×2 — and validates with zero
  illegal assignments.
- **Live data** comes from ESPN's public feed. A GitHub Actions cron
  (`.github/workflows/refresh.yml`) runs every 3 hours: it fetches results,
  rebuilds standings, recomputes the odds, runs the test suite, and commits
  `data/state.json` + `data/odds.json`. GitHub Pages re-serves the fresh data
  automatically.
- **Scenario simulator** re-runs the Monte Carlo in a Web Worker as you pin
  hypothetical results, so the odds update in real time. The "who should I root
  for" panel scores every upcoming result against your chosen goal.

## Files

| File | Purpose |
|---|---|
| `index.html` | The single-page UI (inline CSS + JS, Web-Worker sim) |
| `model.js` | Shared Monte Carlo engine (runs in browser **and** cron) |
| `scripts/refresh.mjs` | Fetch ESPN → rebuild `state.json` → recompute `odds.json` |
| `scripts/test-model.mjs` | Tiebreaker unit tests + market sanity-band checks |
| `data/seed.json` | Schedule + standings snapshot + team Elo/FIFA strengths |
| `data/annex-c.json` | Canonical 495-row FIFA Annex C allocation table |
| `data/annexC_full.csv` | Same table, CSV provenance (8 winner slots) |
| `data/state.json` | Live standings (cron-refreshed) |
| `data/odds.json` | Precomputed odds for instant first paint (cron-refreshed) |

## Run locally

```bash
node scripts/test-model.mjs        # run the test suite
node scripts/refresh.mjs           # pull live data + recompute odds
python3 -m http.server 8077        # then open http://localhost:8077
```

## Caveats

Probabilities are model estimates, sanity-checked against market odds — **not**
bookmaker lines and **not** betting advice. Conduct/fair-play and FIFA-ranking
tiebreakers can't be forecast per simulation, so deep ties fall back to current
FIFA ranking (documented in `model.js`). Built for entertainment; not affiliated
with FIFA.
