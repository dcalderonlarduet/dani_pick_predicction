#!/usr/bin/env node
import { WNBA_THRESHOLDS, resolveColorWithSportThresholds } from "../src/services/sport-bettable-thresholds.js";
import { calcularScore, computeDataQuality, resolvePickColor } from "../src/services/pro-odds-scoring.js";

function assert(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`OK: ${label}`);
}

function wnbaDq(flags, meta = {}) {
  return Math.min(0.85, computeDataQuality(flags, meta));
}

function scorePick({ ev, dq, odds, marketKey, edge = 0.05, lineup = false, injuries = true }) {
  const flags = {
    stats_espn_disponibles: true,
    mercado_actualizado: true,
    muestra_suficiente: true,
    freshness_ok: true,
    lesiones_confirmadas: injuries,
    alineacion_confirmada: lineup,
  };
  const dataQuality = wnbaDq(flags, { oddsAvailable: true, freshnessOk: true });
  const range = WNBA_THRESHOLDS.oddsRange[marketKey];
  const cuota_en_rango = odds >= range.min && odds <= range.max;
  const scoreResult = calcularScore({
    ev_modelo: ev,
    cuota_en_rango,
    dataQuality: dq ?? dataQuality,
    lm: { tipo: "NEUTRO" },
    confianza: 55,
  });
  const sportColor = resolveColorWithSportThresholds(WNBA_THRESHOLDS, { ev, score: scoreResult.score });
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
    requireEdge: marketKey === "moneyline",
  });
  return { score: scoreResult.score, color, dq: dq ?? dataQuality, umbralVerde: sportColor.umbralVerde };
}

// dq calibrada con cuotas + ESPN + lesiones típicas
const dqWithOdds = wnbaDq(
  {
    stats_espn_disponibles: true,
    mercado_actualizado: true,
    muestra_suficiente: true,
    freshness_ok: true,
    lesiones_confirmadas: true,
    alineacion_confirmada: false,
  },
  { oddsAvailable: true, freshnessOk: true }
);
assert(`dq con cuotas ≈ 0.69 (got ${dqWithOdds.toFixed(2)})`, Math.abs(dqWithOdds - 0.69) < 0.02);

const dqLineup = wnbaDq(
  {
    stats_espn_disponibles: true,
    mercado_actualizado: true,
    muestra_suficiente: true,
    freshness_ok: true,
    lesiones_confirmadas: true,
    alineacion_confirmada: true,
  },
  { oddsAvailable: true, freshnessOk: true }
);
assert(`dq con cuotas + alineación ≈ 0.81 (got ${dqLineup.toFixed(2)})`, Math.abs(dqLineup - 0.81) < 0.02);

const p1 = scorePick({ ev: 0.11, dq: 0.69, odds: 1.91, marketKey: "team_total_away", edge: 0.04 });
assert(`MIN Team Total Over score ${p1.score.toFixed(1)} → VERDE`, p1.color === "verde" && p1.score >= 57);

const p2 = scorePick({ ev: 0.07, dq: 0.81, odds: 1.67, marketKey: "moneyline", lineup: true });
assert(`MIN ML con alineación score ${p2.score.toFixed(1)} → VERDE`, p2.color === "verde" && p2.score >= 57);

const p2b = scorePick({ ev: 0.049, dq: 0.69, odds: 1.67, marketKey: "moneyline", lineup: false });
assert(`MIN ML sin alineación score ${p2b.score.toFixed(1)} → AMARILLO`, p2b.color === "amarillo");

const p3 = scorePick({ ev: 0.049, dq: 0.69, odds: 1.57, marketKey: "moneyline" });
assert(`NYL Liberty ML score ${p3.score.toFixed(1)} → AMARILLO`, p3.color === "amarillo" && p3.score >= 43);

const p4 = scorePick({ ev: 0.09, dq: 0.69, odds: 1.91, marketKey: "game_total", edge: 0.04 });
assert(`WAS-LAS Over score ${p4.score.toFixed(1)} → VERDE`, p4.color === "verde");

const p5 = scorePick({ ev: 0.08, dq: 0.69, odds: 1.4, marketKey: "moneyline" });
assert(`ATL Dream ML score ${p5.score.toFixed(1)} → VERDE`, p5.color === "verde");

const p6 = scorePick({ ev: 0.02, dq: 0.69, odds: 1.55, marketKey: "moneyline" });
assert(`WAS ML EV 2% score ${p6.score.toFixed(1)} → GRIS`, p6.color === "gris");

const p7 = scorePick({ ev: 0.02, dq: 0.69, odds: 1.85, marketKey: "game_total", edge: 0.04 });
assert(`NYL-PHX Under score ${p7.score.toFixed(1)} → GRIS`, p7.color === "gris");

console.log("\nWNBA threshold checks OK.");
