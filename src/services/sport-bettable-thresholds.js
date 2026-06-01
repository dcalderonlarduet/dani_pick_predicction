/**
 * Umbrales bettable calibrados por deporte (color, value gates, rangos de cuota).
 * Ajustes de umbral verde por señales de mercado en applyVerdeThresholdAdjustments().
 */

export const NBA_THRESHOLDS = {
  color: {
    verde: { score: 55, ev: 0.05, edge: 0.05 },
    amarillo: { score: 47, ev: 0.03, edge: 0.03 },
  },
  gates: {
    minDataQuality: 0.58,
    minEv: 0.03,
    maxModelMarketGap: 0.2,
    minEdge: 0.04,
    minRecommendationConfidence: 55,
  },
  oddsRange: {
    first_half_total: { min: 1.68, max: 2.35 },
    team_total_home: { min: 1.68, max: 2.45 },
    team_total_away: { min: 1.68, max: 2.45 },
    game_total: { min: 1.68, max: 2.25 },
    moneyline: { min: 1.4, max: 5.0 },
  },
  verdeAdjustments: [
    { type: "ev_dropping", evMin: 0.05, delta: 5 },
    { type: "external_gap", gapMin: 0.08, delta: 5 },
    { type: "rlm_dropping", delta: 8 },
    { type: "high_ev_model", evMin: 0.08, delta: 4 },
  ],
};

export const WNBA_THRESHOLDS = {
  color: {
    verde: { score: 57, ev: 0.05, edge: 0.04 },
    amarillo: { score: 43, ev: 0.03, edge: 0.03 },
  },
  gates: {
    minDataQuality: 0.5,
    minEv: 0.03,
    maxModelMarketGap: 0.22,
    minEdge: 0.04,
    minRecommendationConfidence: 48,
  },
  oddsRange: {
    team_total_home: { min: 1.62, max: 2.5 },
    team_total_away: { min: 1.62, max: 2.5 },
    game_total: { min: 1.62, max: 2.5 },
    moneyline: { min: 1.4, max: 5.0 },
  },
  verdeAdjustments: [
    { type: "ev_dropping", evMin: 0.05, delta: 5 },
    { type: "external_gap", gapMin: 0.08, delta: 5 },
    { type: "high_ev_model", evMin: 0.08, delta: 4 },
  ],
};

export const FOOTBALL_THRESHOLDS = {
  color: {
    verde: { score: 62, ev: 0.05, edge: 0.04 },
    amarillo: { score: 50, ev: 0.03, edge: 0.03 },
  },
  gates: {
    minDataQuality: 0.55,
    minEv: 0.03,
    maxModelMarketGap: 0.2,
    minEdge: 0.03,
    minRecommendationConfidence: 55,
  },
  oddsRange: {
    moneyline: { min: 1.35, max: 5.5 },
    game_total: { min: 1.68, max: 2.35 },
    asian_handicap: { min: 1.75, max: 2.1 },
    btts: { min: 1.6, max: 2.5 },
    double_chance: { min: 1.15, max: 2.2 },
  },
  dataQualityPenalties: {
    alineacion_no_confirmada: 0.08,
    sin_xg: 0.04,
  },
  verdeAdjustments: [
    { type: "ev_dropping", evMin: 0.05, delta: 5 },
    { type: "external_gap", gapMin: 0.08, delta: 5 },
    { type: "lineup_xg", delta: 3 },
  ],
};

export const MLB_THRESHOLDS = {
  color: {
    verde: { score: 62, ev: 0.05, edge: 0.04 },
    amarillo: { score: 50, ev: 0.02, edge: 0.03 },
  },
  gates: {
    minDataQuality: 0.5,
    minEv: 0.02,
    maxModelMarketGap: 0.2,
    minEdge: 0.03,
    minRecommendationConfidence: 50,
  },
  oddsRange: {
    moneyline: { min: 1.3, max: 4.5 },
    runline: { min: 1.45, max: 3.2 },
    game_total: { min: 1.68, max: 2.35 },
    team_total_home: { min: 1.65, max: 2.45 },
    team_total_away: { min: 1.65, max: 2.45 },
    first_half_total: { min: 1.68, max: 2.35 },
  },
  dataQualityPenalties: {
    pitcher_no_confirmado: 0.08,
    sin_bullpen_era_7d: 0.05,
    pitcher_era_contradictorio: 0.15,
    muestra_insuficiente: 0.12,
  },
  verdeAdjustments: [
    { type: "ev_dropping", evMin: 0.04, delta: 5 },
    { type: "external_gap", gapMin: 0.08, delta: 5 },
    { type: "park_weather", delta: 4 },
  ],
};

export const NFL_THRESHOLDS = {
  color: {
    verde: { score: 62, ev: 0.04, edge: 0.05 },
    amarillo: { score: 50, ev: 0.02, edge: 0.03 },
  },
  gates: {
    minDataQuality: 0.6,
    minEv: 0.02,
    maxModelMarketGap: 0.18,
    minEdge: 0.04,
    minRecommendationConfidence: 52,
  },
  oddsRange: {
    first_half_total: { min: 1.68, max: 2.35 },
    team_total_home: { min: 1.68, max: 2.45 },
    team_total_away: { min: 1.68, max: 2.45 },
    game_total: { min: 1.68, max: 2.35 },
    moneyline: { min: 1.4, max: 4.5 },
  },
  verdeAdjustments: [
    { type: "ev_dropping", evMin: 0.04, delta: 5 },
    { type: "external_gap", gapMin: 0.08, delta: 5 },
    { type: "rlm_dropping", delta: 8 },
  ],
};

export function applyVerdeThresholdAdjustments(baseVerde, adjustments = [], ctx = {}) {
  let v = baseVerde;
  const { ev, signals, lm, pickSideLm, flags, game, score } = ctx;

  for (const adj of adjustments) {
    if (adj.type === "ev_dropping" && ev >= adj.evMin && signals?.dropping) {
      v -= adj.delta;
    }
    if (adj.type === "external_gap" && signals?.valueBet && (signals?.gapBooks || 0) > adj.gapMin) {
      v -= adj.delta;
    }
    if (adj.type === "rlm_dropping") {
      const rlmAligned = lm?.tipo === "RLM" && pickSideLm && lm.lado_sharp === pickSideLm;
      if (rlmAligned && signals?.dropping) v -= adj.delta;
    }
    if (adj.type === "lineup_xg" && flags?.alineacion_confirmada && flags?.xg_disponible) {
      v -= adj.delta;
    }
    if (adj.type === "park_weather") {
      const runFactor = Number(game?.park?.runFactor);
      const parkExtreme = Number.isFinite(runFactor) && (runFactor >= 1.12 || runFactor <= 0.88);
      const weatherAdj = Math.abs(Number(game?.weatherAdjustment?.runAdjust ?? game?.weatherAdjustment?.totalDelta ?? 0));
      const weatherExtreme = weatherAdj >= 0.08;
      if (parkExtreme && weatherExtreme) v -= adj.delta;
    }
    if (adj.type === "high_ev_model" && Number(ev) >= adj.evMin && Number(score) >= baseVerde) {
      v -= adj.delta;
    }
  }

  return v;
}

export function resolveColorWithSportThresholds(thresholds, params) {
  const { color, gates } = thresholds;
  const umbralVerde = applyVerdeThresholdAdjustments(color.verde.score, thresholds.verdeAdjustments, {
    ev: params.ev,
    score: params.score,
    signals: params.signals,
    lm: params.lm,
    pickSideLm: params.pickSideLm,
    flags: params.flags,
    game: params.game,
  });

  return {
    umbralVerde,
    umbralAmarillo: color.amarillo.score,
    evVerde: color.verde.ev,
    evAmarillo: color.amarillo.ev,
    edgeVerde: color.verde.edge,
    edgeAmarillo: color.amarillo.edge,
    gateParams: {
      minDataQuality: gates.minDataQuality,
      minEv: gates.minEv,
      maxModelMarketGap: gates.maxModelMarketGap,
      minEdge: gates.minEdge,
      minConfidence: gates.minRecommendationConfidence ?? undefined,
    },
  };
}

/** Suelo mínimo de dataQuality: dato ausente no debe anular el pick por completo. */
export const DATA_QUALITY_FLOOR = {
  mlb: 0.38,
  nba: 0.45,
  nfl: 0.4,
  wnba: 0.35,
  football: 0.38,
};

export function applyDataQualityPenalties(baseQuality, penalties = {}, flags = {}, sport = null) {
  let q = baseQuality;

  if (penalties.alineacion_no_confirmada && flags.alineacion_confirmada !== true) {
    q -= penalties.alineacion_no_confirmada;
  }
  if (penalties.sin_xg && flags.xg_disponible !== true) {
    q -= penalties.sin_xg;
  }
  if (penalties.pitcher_no_confirmado && flags.pitcher_confirmado === false) {
    q -= penalties.pitcher_no_confirmado;
  }
  if (penalties.sin_bullpen_era_7d && flags.bullpen_era_7d == null) {
    q -= penalties.sin_bullpen_era_7d;
  }

  if (
    penalties.pitcher_era_contradictorio &&
    flags.pitcher_era_contradictorio &&
    (flags.muestra_insuficiente_pitcher || flags.muestra_insuficiente)
  ) {
    q -= penalties.pitcher_era_contradictorio;
  }
  if (penalties.muestra_insuficiente_pitcher && flags.muestra_insuficiente_pitcher) {
    q -= penalties.muestra_insuficiente_pitcher;
  } else if (penalties.muestra_insuficiente && flags.muestra_insuficiente) {
    q -= penalties.muestra_insuficiente;
  }

  const floor = sport ? (DATA_QUALITY_FLOOR[sport] ?? 0.35) : 0;
  return Math.max(floor, q);
}
