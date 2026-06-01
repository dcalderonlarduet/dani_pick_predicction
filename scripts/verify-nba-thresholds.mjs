#!/usr/bin/env node
import { NBA_THRESHOLDS, resolveColorWithSportThresholds } from "../src/services/sport-bettable-thresholds.js";
import {
  calcularScore,
  evaluateValueGates,
  resolvePickColor,
} from "../src/services/pro-odds-scoring.js";

function assert(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`OK: ${label}`);
}

function scoreTotal({ ev, dq, odds = 1.91, dropping = false, valueBet = false }) {
  const cuota_en_rango = odds >= NBA_THRESHOLDS.oddsRange.game_total.min &&
    odds <= NBA_THRESHOLDS.oddsRange.game_total.max;
  const scoreResult = calcularScore({
    ev_modelo: ev,
    ev_externo_coincide: valueBet,
    dropping_alineado: dropping,
    gap_books: 0,
    cuota_en_rango,
    dataQuality: dq,
    lm: { tipo: "NEUTRO" },
    confianza: 55,
  });
  const sportColor = resolveColorWithSportThresholds(NBA_THRESHOLDS, {
    ev,
    score: scoreResult.score,
    signals: { dropping, valueBet },
  });
  const color = resolvePickColor({
    score: scoreResult.score,
    ev,
    edge: 0.06,
    cuota_en_rango,
    umbralVerde: sportColor.umbralVerde,
    umbralAmarillo: sportColor.umbralAmarillo,
    evVerde: sportColor.evVerde,
    evAmarillo: sportColor.evAmarillo,
    edgeVerde: sportColor.edgeVerde,
    edgeAmarillo: sportColor.edgeAmarillo,
    requireEdge: false,
  });
  return { score: scoreResult.score, color };
}

function scoreMl({ ev, odds, side = "home" }) {
  const cuota_en_rango = odds >= NBA_THRESHOLDS.oddsRange.moneyline.min &&
    odds <= NBA_THRESHOLDS.oddsRange.moneyline.max;
  const edge = ev > 0 ? 0.05 : -0.05;
  const scoreResult = calcularScore({
    ev_modelo: ev,
    cuota_en_rango,
    dataQuality: 0.82,
    lm: { tipo: "NEUTRO" },
    confianza: 55,
  });
  const sportColor = resolveColorWithSportThresholds(NBA_THRESHOLDS, {
    ev,
    score: scoreResult.score,
  });
  const color = resolvePickColor({
    score: scoreResult.score,
    ev,
    edge,
    cuota_en_rango,
    umbralVerde: sportColor.umbralVerde,
    umbralAmarillo: sportColor.umbralAmarillo,
    evVerde: sportColor.evVerde,
    evAmarillo: sportColor.evAmarillo,
    edgeVerde: sportColor.edgeVerde,
    edgeAmarillo: sportColor.edgeAmarillo,
    requireEdge: true,
  });
  return { score: scoreResult.score, color };
}

const dqPlayoffs = 0.82;

const u5 = scoreTotal({ ev: 0.049, dq: dqPlayoffs });
assert(`Under 212.5 EV 5% score ${u5.score.toFixed(1)} → AMARILLO`, u5.color === "amarillo" && u5.score >= 47);

const u9 = scoreTotal({ ev: 0.09, dq: dqPlayoffs });
assert(`Under 212.5 EV 9% score ${u9.score.toFixed(1)} → VERDE`, u9.color === "verde" && u9.score >= 55);

const uDrop = scoreTotal({ ev: 0.05, dq: dqPlayoffs, dropping: true });
assert(`Under EV 5% + dropping score ${uDrop.score.toFixed(1)} → VERDE`, uDrop.color === "verde");

const u1h = scoreTotal({ ev: 0.09, dq: dqPlayoffs, odds: 1.91 });
assert(`Under 1H EV 9% score ${u1h.score.toFixed(1)} → VERDE`, u1h.color === "verde");

const uInj = scoreTotal({ ev: 0.12, dq: 0.88 });
assert(`Under EV 12% dq 0.88 score ${uInj.score.toFixed(1)} → VERDE`, uInj.color === "verde");

const mlOkc = scoreMl({ ev: -0.03, odds: 1.62 });
assert(`ML OKC EV -3% → GRIS`, mlOkc.color === "gris");

const mlSas = scoreMl({ ev: -0.08, odds: 2.3 });
assert(`ML SAS EV -8% → GRIS`, mlSas.color === "gris");

const gates = evaluateValueGates({
  ev: 0.09,
  edge: 0.06,
  dataQuality: dqPlayoffs,
  cuota_en_rango: true,
  probModel: 0.58,
  probMarket: 0.52,
  requireEdge: true,
  ...NBA_THRESHOLDS.gates,
});
assert("Under EV 9% pasa gates NBA", gates.passed);

console.log("\nNBA threshold checks OK (Game 7 OKC vs SAS).");
