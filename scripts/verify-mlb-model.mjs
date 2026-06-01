#!/usr/bin/env node
import {
  regressedPitcherRunMetric,
  effectivePitcherRunMetric,
  computeOffenseVsPitcherMatchup,
  calibrateRunLineProbability,
  normalizeExpectedValueMlb,
} from "../src/services/mlb-model-enhancements.js";
import { pickMlbMarketQuote } from "../src/services/mlb-odds-policy.js";

function assert(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`OK: ${label}`);
}

// Paddack: ERA extrema, xFIP razonable
const paddackBase = regressedPitcherRunMetric({ era30: 23.6, xFip30: 4.8, fip30: 5.1 });
assert("ERA 23.6 regresa hacia xFIP (<8)", paddackBase < 8);

// Giolito: xFIP alto, ERA buena
const giolito = regressedPitcherRunMetric({ era30: 2.7, xFip30: 7.2, fip30: 6.8 });
assert("ERA buena con xFIP alto no queda en 2.7", giolito > 3.5 && giolito < 6.5);

// Lambert: forma reciente mejor que xFIP
const lambert = effectivePitcherRunMetric({
  era30: 4.0,
  xFip30: 5.2,
  recentStartsEra: 4.0,
  starts30: 6,
});
assert("Lambert effective <= xFIP puro", lambert <= 5.2);

// Meyer ERA 0 muestra pequeña
const meyer = effectivePitcherRunMetric({
  era30: 1.5,
  xFip30: 4.2,
  recentStartsEra: 0.0,
  starts30: 4,
});
assert("Meyer esceptico (no elite ni imposible)", meyer >= 3.0 && meyer <= 4.8);

// Schultz desastre reciente, xFIP bueno
const schultz = effectivePitcherRunMetric({
  era30: 8.5,
  xFip30: 3.4,
  recentStartsEra: 54.0,
  starts30: 5,
});
assert("Schultz no confía ciegamente en xFIP ni en ERA 54", schultz > 3.4 && schultz < 10);

const severinoBase = regressedPitcherRunMetric({ era30: 3.9, xFip30: 3.9 });
const severinoVsNyy = regressedPitcherRunMetric({
  era30: 3.9,
  xFip30: 3.9,
  historyVsOpponent: { games: 3, era: 10.66 },
});
assert("Historial vs rival significativo empeora la mÇ¸trica", severinoVsNyy > severinoBase + 3.5);

const smallSampleVsOpponent = regressedPitcherRunMetric({
  era30: 3.9,
  xFip30: 3.9,
  historyVsOpponent: { games: 2, era: 10.66 },
});
assert("No mezcla historial vs rival con muestra insuficiente", Math.abs(smallSampleVsOpponent - severinoBase) < 0.01);

const noisyVsOpponent = regressedPitcherRunMetric({
  era30: 3.8,
  xFip30: 3.8,
  historyVsOpponent: { games: 4, era: 3.5 },
});
assert("No mezcla historial vs rival cuando no hay gap real", Math.abs(noisyVsOpponent - 3.8) < 0.01);

// Bateo HOU caliente vs abridor mediocre
const houOffense = {
  seasonOps: 0.72,
  splitVsHandOps: 0.76,
  seasonRunsPerGame: 4.3,
  runsLast10: 4.6,
  seasonObp: 0.32,
  kRate: 0.21,
};
const sproat = { k9: 8.5, whip30: 1.25 };
const matchup = computeOffenseVsPitcherMatchup(houOffense, sproat);
assert("HOU caliente vs Sproat suma carreras", matchup.runDelta > 0.05);

// MIL frío vs abridor
const milOffense = {
  seasonOps: 0.7,
  splitVsHandOps: 0.68,
  seasonRunsPerGame: 4.1,
  runsLast10: 4.1,
  seasonObp: 0.3,
  kRate: 0.23,
};
const matchupMil = computeOffenseVsPitcherMatchup(milOffense, { k9: 9.0, whip30: 1.18 });
assert("MIL split malo resta carreras", matchupMil.runDelta < 0.05);

// RL calibrado
const rlRaw = 0.767;
const rlCal = calibrateRunLineProbability(rlRaw);
assert("RL 76.7% baja materialmente", rlCal < 0.62);

// EV cap
assert("EV cap 72% -> 8%", normalizeExpectedValueMlb(0.726) === 0.08);

const canonicalQuote = pickMlbMarketQuote({
  bet365: {
    winner: [1.66, 2.25],
  },
  "winamax fr": {
    winner: [1.7, 2.2],
  },
}, "moneyline");
assert("Bet365 canonizado sigue siendo legible en MLB", canonicalQuote.home === 1.66 && canonicalQuote.away === 2.25);

console.log("\nTodos los escenarios MLB pasaron.");
