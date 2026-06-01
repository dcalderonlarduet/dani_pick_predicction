#!/usr/bin/env node
import { pickProMarketQuote } from "../src/services/pro-market-quotes.js";
import { findProOddsEntry } from "../src/services/pro-analyzer-shared.js";
import { computeDataQuality } from "../src/services/pro-odds-scoring.js";
import { normalizeWnbaTeamName, wnbaTeamNamesMatch } from "../src/utils/wnba-team-names.js";

function assert(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`OK: ${label}`);
}

// Test 1 — readBook via pickProMarketQuote encuentra Bet365
const quote = pickProMarketQuote({ bet365: { winner: [1.7, 2.1] } }, "moneyline");
assert("readBook Bet365 → cuota home 1.70", quote.home === 1.7);

// Test 2 — alias WNBA
assert("LA Sparks alias", normalizeWnbaTeamName("LA Sparks") === "los angeles sparks");
assert("Los Angeles Sparks match LA Sparks", wnbaTeamNamesMatch("Los Angeles Sparks", "LA Sparks"));

// Test 3 — findProOddsEntry CON vs LAS
const oddsEntry = {
  home_team: "Connecticut Sun",
  away_team: "LA Sparks",
  bookmakers: { bet365: { winner: [1.55, 1.7] } },
  eventId: "wnba-1",
  commenceTime: "2026-05-30T22:00:00Z",
};
const oddsMap = new Map([
  ["connecticut sun::la sparks::2026-05-30::2026-05-30T22:00:00.000Z", oddsEntry],
  ["connecticut sun::los angeles sparks::2026-05-30", oddsEntry],
]);
const found = findProOddsEntry(
  oddsMap,
  "Connecticut Sun",
  "Los Angeles Sparks",
  null,
  "2026-05-30",
  "2026-05-30T22:00:00Z",
  "wnba"
);
assert("findProOddsEntry CON vs LAS", found?.bookmakers?.bet365?.winner?.[1] === 1.7);

// Test 4 — dq sin cuotas supera gate 0.50
const dqNoOdds = computeDataQuality(
  {
    stats_espn_disponibles: true,
    mercado_actualizado: false,
    muestra_suficiente: true,
    freshness_ok: true,
  },
  { oddsAvailable: false, freshnessOk: true }
);
assert(`dq sin cuotas ≥ 0.57 (got ${dqNoOdds.toFixed(2)})`, dqNoOdds >= 0.57);

const dqWithOdds = computeDataQuality(
  {
    stats_espn_disponibles: true,
    mercado_actualizado: true,
    muestra_suficiente: true,
    freshness_ok: true,
    lesiones_confirmadas: true,
  },
  { oddsAvailable: true, freshnessOk: true }
);
assert(`dq con cuotas ≈ 0.69 (got ${dqWithOdds.toFixed(2)})`, Math.abs(dqWithOdds - 0.69) < 0.02);

console.log("\nWNBA fix checks OK.");
