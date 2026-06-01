import { clamp, round } from "../utils/math.js";

/** Umbral mínimo para mostrar un pick como recomendación. */
export const MIN_RECOMMENDATION_CONFIDENCE = 58;
/** WNBA: stats de temporada incompletas → confianza del scorer más baja, mismo edge real. */
export const WNBA_MIN_RECOMMENDATION_CONFIDENCE = 48;
export const TOP_PICK_CONFIDENCE = 68;

const MIN_CONF_POR_DEPORTE = {
  wnba: WNBA_MIN_RECOMMENDATION_CONFIDENCE,
  mlb: 50,
  nba: 55,
  nfl: 52,
  football: 55,
  futbol: 55,
};

export function getMinRecommendationConfidence(sport = "") {
  const key = String(sport || "").toLowerCase().trim();
  return MIN_CONF_POR_DEPORTE[key] ?? MIN_RECOMMENDATION_CONFIDENCE;
}

/** EV mostrado: en mercados reales +5–8% ya es muy bueno. */
export const SCORING_EV_CAP = 0.08;
export const DISPLAY_EV_CAP = 0.3;
export const DISPLAY_EV_SHRINK = 0.65;

const MARKET_TYPE_LABELS = {
  moneyline: "ML",
  runline: "Runline",
  totals: "Totales",
  other: "Otros",
};

/**
 * Recalibra EV inflado del modelo hacia rangos creíbles (+5–8% como techo habitual).
 * Conserva evRaw para auditoría.
 */
export function calibrateForScoring(ev, { cap = SCORING_EV_CAP } = {}) {
  if (!Number.isFinite(ev)) return null;
  return round(Math.sign(ev) * Math.min(Math.abs(ev), cap), 4);
}

export function calibrateForDisplay(ev, { cap = DISPLAY_EV_CAP, shrink = DISPLAY_EV_SHRINK } = {}) {
  if (!Number.isFinite(ev)) return null;
  let calibrated = ev;
  if (Math.abs(ev) > 0.03) {
    const excess = Math.abs(ev) - 0.03;
    calibrated = Math.sign(ev) * (0.03 + excess * shrink);
  }
  if (Math.abs(calibrated) > cap) {
    calibrated = Math.sign(calibrated) * cap;
  }
  return round(calibrated, 4);
}

export function calibrateDisplayEv(ev, options = {}) {
  return calibrateForDisplay(ev, options);
}

/**
 * Expande el Score Pro en un rango útil 40–90 donde los TOP destacan claramente.
 */
export function spreadScorePro(
  rawScore,
  { ev = 0, confidence = 55, dataQuality = 0, marketSignals = 0 } = {}
) {
  const raw = Number(rawScore) || 0;
  let score = raw;

  const evNum = Number(ev) || 0;
  if (evNum >= 0.03) {
    score += Math.min(4, ((evNum - 0.03) / 0.05) * 4);
  }

  const conf = Number(confidence) || 55;
  if (conf >= MIN_RECOMMENDATION_CONFIDENCE) {
    score += Math.min(4, ((conf - MIN_RECOMMENDATION_CONFIDENCE) / 14) * 4);
  }

  score += Math.min(2, Number(dataQuality) * 2);
  score += Math.min(4, (Number(marketSignals) || 0) * 2);

  return Math.round(clamp(score, 40, 90));
}

export function passesRecommendationConfidence(confidence, minConfidence = MIN_RECOMMENDATION_CONFIDENCE) {
  const conf = Number(confidence);
  return Number.isFinite(conf) && conf >= minConfidence;
}

export function normalizeMarketTypeKey(market) {
  const key = String(market || "").toLowerCase();
  if (key.includes("moneyline") || key === "ml" || key.includes("ganador") || key === "1x2") {
    return "moneyline";
  }
  if (key.includes("runline") || key.includes("run line") || key.includes("handicap de carreras")) {
    return "runline";
  }
  if (key.includes("total") || key.includes("over/under") || key === "totals") {
    return "totals";
  }
  return "other";
}

export function aggregateStatsByMarketType(byMarket = {}) {
  const grouped = {};
  for (const [market, stats] of Object.entries(byMarket || {})) {
    const type = normalizeMarketTypeKey(market);
    if (!grouped[type]) {
      grouped[type] = {
        wins: 0,
        losses: 0,
        totalPicks: 0,
        label: MARKET_TYPE_LABELS[type] || type,
      };
    }
    grouped[type].wins += Number(stats?.wins) || 0;
    grouped[type].losses += Number(stats?.losses) || 0;
    grouped[type].totalPicks += Number(stats?.totalPicks) || 0;
  }

  for (const entry of Object.values(grouped)) {
    const resolved = entry.wins + entry.losses;
    entry.hitRate = resolved > 0 ? round(entry.wins / resolved, 4) : null;
    entry.hitRatePct = entry.hitRate != null ? Math.round(entry.hitRate * 1000) / 10 : null;
  }

  return grouped;
}
