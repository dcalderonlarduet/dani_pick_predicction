import {
  NBA_THRESHOLDS,
  WNBA_THRESHOLDS,
  MLB_THRESHOLDS,
  NFL_THRESHOLDS,
  resolveColorWithSportThresholds,
} from "../src/services/sport-bettable-thresholds.js";
import { calcularScore, evaluateValueGates, resolvePickColor } from "../src/services/pro-odds-scoring.js";

function assert(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`OK: ${label}`);
}

function runScenario(
  name,
  thresholds,
  { ev, dq, edge = 0.06, requireEdge = true, probModel = 0.58, probMarket = 0.52, confidence = 60 }
) {
  const cuota_en_rango = true;
  const scoreResult = calcularScore({
    ev_modelo: ev,
    ev_externo_coincide: false,
    dropping_alineado: false,
    gap_books: 0,
    cuota_en_rango,
    dataQuality: dq,
    n_senales: 0,
    lm: { tipo: "NEUTRO" },
    pick_side: "home",
    confianza: confidence,
  });
  const sportColor = resolveColorWithSportThresholds(thresholds, {
    ev,
    score: scoreResult.score,
    signals: {},
    lm: { tipo: "NEUTRO" },
    pickSideLm: "home",
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
    requireEdge,
  });
  const gates = evaluateValueGates({
    ev,
    edge,
    dataQuality: dq,
    cuota_en_rango,
    lm: { tipo: "NEUTRO" },
    pickSide: "home",
    probModel,
    probMarket,
    requireEdge,
    confidence,
    ...sportColor.gateParams,
  });
  const bettable = (color === "verde" || color === "amarillo") && gates.passed;
  return {
    name,
    score: scoreResult.score,
    color,
    bettable,
    gateFailures: gates.failures,
    umbralVerde: sportColor.umbralVerde,
    umbralAmarillo: sportColor.umbralAmarillo,
  };
}

const results = [
  runScenario("MLB Over ATL EV9 dq55 sin senales", MLB_THRESHOLDS, { ev: 0.08, dq: 0.55 }),
  runScenario("NBA Under G7 EV9 dq82 sin senales", NBA_THRESHOLDS, { ev: 0.08, dq: 0.82 }),
  runScenario("WNBA Under total EV15 dq57 sin senales", WNBA_THRESHOLDS, { ev: 0.08, dq: 0.57, edge: 0.04 }),
  runScenario("WNBA TT Over EV negativo", WNBA_THRESHOLDS, { ev: -0.08, dq: 0.57, edge: -0.04 }),
  runScenario("MLB sin valor EV1 dq40", MLB_THRESHOLDS, { ev: 0.01, dq: 0.4 }),
  runScenario("NFL nuevos umbrales", NFL_THRESHOLDS, { ev: 0.05, dq: 0.7 }),
];

assert("MLB EV9 dq55 queda AMARILLO", results[0].color === "amarillo" && results[0].bettable);
assert("NBA EV9 dq82 queda VERDE", results[1].color === "verde" && results[1].bettable);
assert("WNBA EV15 dq57 queda VERDE", results[2].color === "verde" && results[2].bettable);
assert("WNBA EV negativo queda GRIS", results[3].color === "gris" && !results[3].bettable);
assert("MLB EV1 dq40 queda GRIS", results[4].color === "gris" && !results[4].bettable);
assert("NFL EV5 dq70 pasa minimo", results[5].color !== "gris" && results[5].bettable);

console.log(JSON.stringify(results, null, 2));
