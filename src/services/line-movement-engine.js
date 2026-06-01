/**
 * Motor de line movement (NBA / NFL / MLB / Fútbol).
 * Normalizado por tipo de mercado: totals vs moneyline.
 */

const TOTAL_MARKETS = new Set([
  "game_total",
  "first_half_total",
  "team_total_home",
  "team_total_away",
]);

function isTotalMarket(marketKey) {
  return TOTAL_MARKETS.has(marketKey);
}

function impliedProbDelta(openOdds, currentOdds) {
  const open = Number(openOdds);
  const current = Number(currentOdds);
  if (!Number.isFinite(open) || open <= 1 || !Number.isFinite(current) || current <= 1) {
    return null;
  }
  return 1 / current - 1 / open;
}

function sharpSideFromTotalDelta(lineDelta, sport) {
  const trap = sport === "nba" ? 1.5 : 1.0;
  const rlm = sport === "nba" ? 1.0 : 0.5;
  // MLB y fútbol usan los mismos umbrales que NFL para totales de juego completo.
  if (lineDelta > trap) {
    return { tipo: "LINEA_TRAMPA", lado_sharp: "under", lado_publico: "over", confianza: "ALTA" };
  }
  if (lineDelta < -rlm) return { tipo: "RLM", lado_sharp: "over", confianza: "MUY_ALTA" };
  if (lineDelta > rlm) {
    return { tipo: "STEAM_MOVE", lado_sharp: "under", lado_publico: "over", confianza: "MEDIA" };
  }
  if (lineDelta < -trap) {
    return { tipo: "STEAM_MOVE", lado_sharp: "over", lado_publico: "under", confianza: "MEDIA" };
  }
  return null;
}

function sharpSideFromMoneylineDelta(probDeltaHome, pctTicketsHome, sport) {
  const pubThreshold = sport === "nba" ? 65 : 70;
  const probTrap = 0.03;
  const probRlm = 0.02;
  const pctTicketsAway = 100 - Number(pctTicketsHome);

  if (Number(pctTicketsHome) > 70 && probDeltaHome > probTrap) {
    return { tipo: "LINEA_TRAMPA", lado_sharp: "away", lado_publico: "home", confianza: "ALTA" };
  }
  if (pctTicketsAway > 70 && probDeltaHome < -probTrap) {
    return { tipo: "LINEA_TRAMPA", lado_sharp: "home", lado_publico: "away", confianza: "ALTA" };
  }
  if (Number(pctTicketsHome) > pubThreshold && probDeltaHome < -probRlm) {
    return { tipo: "RLM", lado_sharp: "away", lado_publico: "home", confianza: "MUY_ALTA" };
  }
  if (Number(pctTicketsHome) < 100 - pubThreshold && probDeltaHome > probRlm) {
    return { tipo: "RLM", lado_sharp: "home", lado_publico: "away", confianza: "MUY_ALTA" };
  }
  if (Math.abs(probDeltaHome) > 0.025) {
    return {
      tipo: "STEAM_MOVE",
      lado_sharp: probDeltaHome < 0 ? "home" : "away",
      confianza: "MEDIA",
    };
  }
  return null;
}

export function detectLineMovement({
  pct_tickets_home = 50,
  pct_money_home = 50,
  linea_apertura = null,
  linea_actual = null,
  cuota_apertura_home = null,
  cuota_actual_home = null,
  cuota_apertura_away = null,
  cuota_actual_away = null,
  hay_noticia_lesion = false,
  sport = "nba",
  marketKey = "game_total",
}) {
  if (hay_noticia_lesion) {
    return { tipo: "NOTICIA", score_bonus: 0, score_penalizacion_si_vas_publico: 0, marketKey };
  }

  const ticketMoneyGap = Number(pct_money_home) - Number(pct_tickets_home);

  if (marketKey === "moneyline") {
    const probDeltaHome =
      impliedProbDelta(cuota_apertura_home ?? linea_apertura, cuota_actual_home ?? linea_actual) ??
      impliedProbDelta(cuota_apertura_away, cuota_actual_away);
    if (probDeltaHome == null) {
      return { tipo: "NEUTRO", score_bonus: 0, score_penalizacion_si_vas_publico: 0, marketKey };
    }

    const signal = sharpSideFromMoneylineDelta(probDeltaHome, pct_tickets_home, sport);
    if (!signal) {
      return {
        tipo: "NEUTRO",
        score_bonus: 0,
        score_penalizacion_si_vas_publico: 0,
        delta_prob_home: probDeltaHome,
        gap_tickets_handle: ticketMoneyGap,
        marketKey,
      };
    }

    const bonuses = { LINEA_TRAMPA: 9, RLM: 12, STEAM_MOVE: 6 };
    const penalties = { LINEA_TRAMPA: 15, RLM: 20, STEAM_MOVE: 8 };
    return {
      ...signal,
      score_bonus: bonuses[signal.tipo] || 0,
      score_penalizacion_si_vas_publico: penalties[signal.tipo] || 0,
      delta_prob_home: probDeltaHome,
      gap_tickets_handle: ticketMoneyGap,
      marketKey,
    };
  }

  if (isTotalMarket(marketKey)) {
    const open = Number(linea_apertura);
    const current = Number(linea_actual);
    if (!Number.isFinite(open) || !Number.isFinite(current)) {
      return { tipo: "NEUTRO", score_bonus: 0, score_penalizacion_si_vas_publico: 0, marketKey };
    }

    const lineDelta = current - open;
    const signal = sharpSideFromTotalDelta(lineDelta, sport);
    if (!signal) {
      return {
        tipo: "NEUTRO",
        score_bonus: 0,
        score_penalizacion_si_vas_publico: 0,
        delta_linea: lineDelta,
        marketKey,
      };
    }

    const bonuses = { LINEA_TRAMPA: 9, RLM: 12, STEAM_MOVE: 6 };
    const penalties = { LINEA_TRAMPA: 15, RLM: 20, STEAM_MOVE: 8 };
    return {
      ...signal,
      score_bonus: bonuses[signal.tipo] || 0,
      score_penalizacion_si_vas_publico: penalties[signal.tipo] || 0,
      delta_linea: lineDelta,
      marketKey,
    };
  }

  return { tipo: "NEUTRO", score_bonus: 0, score_penalizacion_si_vas_publico: 0, marketKey };
}

export function applyLineMovementToScore({
  score,
  confianza,
  lm,
  pickSide,
  dropping_alineado = false,
  valueBet_aligned = false,
}) {
  let nextScore = score;
  let nextConfianza = confianza;
  let discarded = null;

  if (!lm || lm.tipo === "NEUTRO" || lm.tipo === "NOTICIA") {
    return { score: nextScore, confianza: nextConfianza, discarded };
  }

  const movementAligned = lm.lado_sharp === pickSide;

  if (movementAligned) {
    nextScore += lm.score_bonus || 0;
    // Solo un bonus por consenso de mercado (dropping o valueBet, no ambos)
    if ((dropping_alineado || valueBet_aligned) && (lm.tipo === "RLM" || lm.tipo === "LINEA_TRAMPA")) {
      nextScore += 4;
      nextConfianza += 5;
    }
  } else {
    nextScore -= lm.score_penalizacion_si_vas_publico || 0;
    nextConfianza -= 15;
    if (lm.tipo === "RLM" && lm.confianza === "MUY_ALTA") {
      discarded = { pick: null, razon: "RLM confirmado contra el pick. Descartado." };
    }
  }

  return { score: nextScore, confianza: nextConfianza, discarded };
}
