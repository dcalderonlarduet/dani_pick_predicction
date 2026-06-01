#!/usr/bin/env node
import {
  applyDataQualityPenalties,
  MLB_THRESHOLDS,
} from "../src/services/sport-bettable-thresholds.js";
import { evaluateValueGates, computeDataQuality } from "../src/services/pro-odds-scoring.js";

function assert(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`OK: ${label}`);
}

const baseWithOdds = computeDataQuality(
  {
    stats_espn_disponibles: true,
    mercado_actualizado: true,
    alineacion_confirmada: true,
    clima_disponible: true,
    muestra_suficiente: true,
    freshness_ok: true,
  },
  { oddsAvailable: true, freshnessOk: true }
);
assert("Con cuotas + ESPN base ≥ 0.72", baseWithOdds >= 0.72);

const baseNoOdds = computeDataQuality(
  {
    stats_espn_disponibles: true,
    clima_disponible: true,
    muestra_suficiente: true,
    freshness_ok: true,
  },
  { oddsAvailable: false }
);
assert("Sin cuotas base típica = 0.63", Math.abs(baseNoOdds - 0.63) < 0.001);

const baseNoOddsNoFreshness = computeDataQuality(
  {
    stats_espn_disponibles: true,
    clima_disponible: true,
    muestra_suficiente: true,
    freshness_ok: false,
  },
  { oddsAvailable: false }
);
assert("Sin cuotas ni freshness = 0.56", Math.abs(baseNoOddsNoFreshness - 0.56) < 0.001);

const mlbMissingOptional = applyDataQualityPenalties(
  baseNoOdds,
  MLB_THRESHOLDS.dataQualityPenalties,
  {
    alineacion_confirmada: false,
    bullpen_era_7d: null,
    pitcher_confirmado: true,
    datos_parciales: true,
  },
  "mlb"
);
assert("MLB sin alineación/bullpen no cae bajo suelo 0.38", mlbMissingOptional >= 0.38);

const atlCin = applyDataQualityPenalties(
  baseNoOdds,
  MLB_THRESHOLDS.dataQualityPenalties,
  {
    alineacion_confirmada: false,
    bullpen_era_7d: 3.86,
    pitcher_era_contradictorio: true,
    muestra_insuficiente_pitcher: false,
    pitcher_confirmado: true,
  },
  "mlb"
);
assert("ATL@CIN ERA/xFIP divergen pero muestra suficiente → dq ≥ 0.63", atlCin >= 0.63);

const mlbBadData = applyDataQualityPenalties(
  baseNoOdds,
  MLB_THRESHOLDS.dataQualityPenalties,
  {
    alineacion_confirmada: true,
    bullpen_era_7d: 4.2,
    pitcher_era_contradictorio: true,
    muestra_insuficiente_pitcher: true,
  },
  "mlb"
);
assert("MLB datos contradictorios + muestra corta penalizan más que ausentes", mlbBadData < mlbMissingOptional);

const gates = evaluateValueGates({
  ev: 0.08,
  dataQuality: 0.55,
  cuota_en_rango: true,
  minDataQuality: MLB_THRESHOLDS.gates.minDataQuality,
  flags: { datos_parciales: true },
});
assert("Gate permisivo con datos_parciales, EV alto y dq 0.55", gates.passed);

console.log("\nData quality checks OK.");
