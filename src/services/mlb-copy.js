/** Textos en español claro para usuarios con conocimiento básico de béisbol y apuestas. */

export const MLB_MARKETS = {
  moneyline: {
    label: "Ganador del partido",
    short: "Quién gana (sin hándicap)",
  },
  totals: {
    label: "Total de carreras del juego",
    short: "Más o menos carreras combinadas",
  },
  runline: {
    label: "Hándicap de carreras (run line)",
    short: "Ganar por 2+ carreras o cubrir +1.5",
  },
};

export function formatMlbRunsSelection(wantsOver, line, teamName = "") {
  const sign = wantsOver ? "(+)" : "(-)";
  const side = wantsOver ? "Más de" : "Menos de";
  const core = `${sign} ${side} ${line} carreras`;
  return teamName ? `${teamName} ${core}` : core;
}

export function formatMlbMoneylineSelection(teamName = "") {
  const team = String(teamName || "").trim();
  return team ? `(ML) ${team} a ganar` : "";
}

export function parseMlbMoneylineTeamName(label) {
  const text = String(label || "").trim();
  const mlMatch = text.match(/^\(ML\)\s+(.+?)(?:\s+a ganar)?$/i);
  if (mlMatch) return mlMatch[1].trim();
  const ganadorMatch = text.match(/^Ganador:\s*(.+)$/i);
  if (ganadorMatch) return ganadorMatch[1].trim();
  return text;
}

export const SCORE_FACTOR_LABELS = {
  ownPitcher: { label: "Tu abridor", help: "Calidad del pitcher que lanza hoy para tu lado." },
  rivalPitcher: { label: "Abridor rival débil", help: "Qué tan vulnerable es el pitcher contrario." },
  offense: { label: "Ataque del equipo", help: "Ritmo de bateo reciente y vs mano del pitcher rival." },
  market: { label: "Valor de la cuota", help: "Si la casa de apuestas deja margen favorable." },
  projectionDiff: { label: "Distancia a la línea", help: "Cuánto se aparta nuestra proyección del total del mercado." },
  parkFactor: { label: "Estadio", help: "Si el parque suele sumar o restar carreras." },
  pitcherGap: { label: "Ventaja de pitcheo", help: "Diferencia global entre abridores y relevos." },
};

export function plainVerdictLabel(verdict, hasOdds) {
  if (verdict === "valid") return "Sí: buena opción para apostar";
  if (verdict === "lean") {
    return hasOdds ? "Idea interesante, pero sin valor claro en cuota" : "Idea del modelo (aún sin cuota de casa)";
  }
  return "Mejor no apostar";
}

export function plainRecommendationTier(confidence) {
  if (confidence >= 70) return "Buena opción para apostar";
  if (confidence >= 55) return "Mirar con cuidado";
  return "No conviene apostar";
}

export function plainPitcherHand(code) {
  if (code === "L") return "Zurdo (L)";
  if (code === "R") return "Diestro (R)";
  return "Mano no disponible";
}

export function plainParkCategory(category) {
  if (category === "Favorece bateo") return "Estadio que suele sumar carreras";
  if (category === "Favorece pitcheo") return "Estadio que suele restar carreras";
  return "Estadio neutro en carreras";
}

export function formatScoreFactors(scoreBreakdown = {}) {
  return Object.entries(scoreBreakdown).map(([key, value]) => {
    const meta = SCORE_FACTOR_LABELS[key] || { label: key, help: "Factor del modelo." };
    return { key, label: meta.label, help: meta.help, value };
  });
}

function scoringTrendText(runsRecent, runsSeason) {
  if (runsRecent > runsSeason + 0.3) return "está anotando más de lo normal";
  if (runsRecent < runsSeason - 0.3) return "está anotando menos de lo normal";
  return "anota al ritmo de la temporada";
}

function allowingTrendText(allowedRecent, runsSeason) {
  if (allowedRecent < runsSeason - 0.3) return "sus partidos recientes permiten pocas carreras";
  if (allowedRecent > runsSeason + 0.3) return "viene permitiendo bastantes carreras";
  return "defiende al nivel de la temporada";
}

export function buildTeamOutlook(team, offense, projectedRuns, opponentName) {
  const recentScored = offense.runsLast10;
  const recentAllowed = offense.allowedLast10;
  const seasonScored = offense.seasonRunsPerGame;

  return {
    teamName: team.name,
    record: team.record?.label || "N/D",
    runsScoredSeason: seasonScored,
    runsScoredRecent: recentScored,
    runsAllowedRecent: recentAllowed,
    projectedRuns,
    narrative:
      `${team.name} (${team.record?.label || "N/D"}) ${scoringTrendText(recentScored, seasonScored)}: ` +
      `anota de media ${roundPlain(recentScored)} carreras en sus últimos 10 partidos (temporada: ${roundPlain(seasonScored)}). ` +
      `${allowingTrendText(recentAllowed, seasonScored)} (permite ${roundPlain(recentAllowed)} por partido en ese tramo). ` +
      `Frente a ${opponentName}, el modelo proyecta unas ${roundPlain(projectedRuns)} carreras para hoy.`,
  };
}

function roundPlain(value) {
  return Number.isFinite(value) ? Number(value).toFixed(1) : "N/D";
}

function plainPitcherWl(pitcher) {
  const label = pitcher?.record?.label;
  if (label && label !== "0-0" && label !== "N/D") return label;
  const wins = pitcher?.record?.wins;
  const losses = pitcher?.record?.losses;
  if (Number.isFinite(wins) && Number.isFinite(losses) && (wins > 0 || losses > 0)) {
    return `${wins}-${losses}`;
  }
  return null;
}

function plainPitcherEra(pitcher) {
  return Number.isFinite(pitcher?.era30) ? roundPlain(pitcher.era30) : null;
}

/** Victorias-derrotas y ERA (carreras limpias) del abridor en el tramo analizado (30 días). */
export function plainPitcherFormStats(pitcher) {
  if (!pitcher) return "";
  const parts = [];
  const wl = plainPitcherWl(pitcher);
  const era = plainPitcherEra(pitcher);
  if (wl) parts.push(`${wl} W-L`);
  if (era) parts.push(`ERA ${era} carreras limpias`);
  if (Number.isFinite(pitcher?.whip30)) parts.push(`WHIP ${roundPlain(pitcher.whip30)}`);
  if (Number.isFinite(pitcher?.k9)) parts.push(`K/9 ${roundPlain(pitcher.k9)}`);
  return parts.join(", ");
}

/** Descripción completa de un abridor para la nota del pick. */
export function plainPitcherFullDescription(pitcher, roleLabel = "Abridor") {
  if (!pitcher?.name) return `${roleLabel}: por confirmar`;
  const segments = [];
  const hand = pitcher.handLabelFull || plainPitcherHand(pitcher.handCode);
  segments.push(`${roleLabel} ${pitcher.name} (${hand})`);

  const wl = plainPitcherWl(pitcher);
  if (wl) segments.push(`récord ${wl}`);

  const metricBits = [];
  const regressed = Number.isFinite(pitcher.regressedRunMetric) ? pitcher.regressedRunMetric : null;
  const xFip = Number.isFinite(pitcher.xFip30) ? pitcher.xFip30 : null;
  const era = plainPitcherEra(pitcher);
  if (regressed != null) metricBits.push(`métrica ajustada ${roundPlain(regressed)}`);
  if (xFip != null) metricBits.push(`xFIP ${roundPlain(xFip)}`);
  if (era) metricBits.push(`ERA 30d ${era} carreras limpias`);
  if (Number.isFinite(pitcher.recentStartsEra)) {
    metricBits.push(`últimas 2 salidas ERA ${roundPlain(pitcher.recentStartsEra)}`);
  }
  if (metricBits.length) segments.push(metricBits.join(", "));

  const rateBits = [];
  if (Number.isFinite(pitcher.whip30)) rateBits.push(`WHIP ${roundPlain(pitcher.whip30)}`);
  if (Number.isFinite(pitcher.k9)) rateBits.push(`K/9 ${roundPlain(pitcher.k9)}`);
  if (Number.isFinite(pitcher.bb9)) rateBits.push(`BB/9 ${roundPlain(pitcher.bb9)}`);
  if (Number.isFinite(pitcher.restDays)) rateBits.push(`${pitcher.restDays} días de descanso`);
  if (rateBits.length) segments.push(rateBits.join(", "));

  const hvs = pitcher.historyVsOpponent;
  if (hvs?.games >= 2 && hvs.era != null) {
    segments.push(`historial vs este rival: ${hvs.games} salidas, ERA ${roundPlain(hvs.era)}`);
  }

  return `${segments.join(". ")}.`;
}

/** Bloque con los dos abridores del partido y sus estadísticas. */
export function plainBothPitchersDescription(game) {
  if (!game?.homePitcher && !game?.awayPitcher) return "";
  const away = plainPitcherFullDescription(game.awayPitcher, "Visitante");
  const home = plainPitcherFullDescription(game.homePitcher, "Local");
  return `${away} ${home}`.trim();
}

/** Añade el bloque de abridores al rationale si aún no está incluido. */
export function appendPitchersContextToRationale(rationale, game) {
  const block = plainBothPitchersDescription(game);
  if (!block) return String(rationale || "").trim();
  const base = String(rationale || "").trim();
  const homeName = String(game?.homePitcher?.name || "").trim();
  const awayName = String(game?.awayPitcher?.name || "").trim();
  if (homeName && awayName && base.includes(homeName) && base.includes(awayName)) {
    return base;
  }
  return base ? `${base} · Abridores: ${block}` : `Abridores: ${block}`;
}

function plainPitcherStatsSuffix(pitcher) {
  const stats = plainPitcherFormStats(pitcher);
  return stats ? ` (${stats})` : "";
}

export function buildTeamStatsPrediction(game, homeScore, awayScore, projections) {
  const homeWins = homeScore.rawNoMarket >= awayScore.rawNoMarket;
  const favorite = homeWins ? game.homeTeam : game.awayTeam;
  const gap = Math.abs(homeScore.rawNoMarket - awayScore.rawNoMarket);

  let winnerSummary;
  if (gap >= 10) {
    winnerSummary = `${favorite.name} sale como favorito claro por abridor, bateo reciente y relevo menos castigado.`;
  } else if (gap >= 5) {
    winnerSummary = `${favorite.name} tiene ventaja moderada; el rival aún puede competir.`;
  } else {
    winnerSummary = "El partido está muy parejo en números: no hay favorito fuerte solo por estadísticas.";
  }

  const line = game.totalsLine;
  const total = projections.totalRuns;
  const diff = projections.diffVsLine;

  let totalRunsPick;
  let totalRunsPlain;
  if (diff > 0.35) {
    totalRunsPick = formatMlbRunsSelection(true, line);
    totalRunsPlain = `El modelo espera ${roundPlain(total)} carreras en total, por encima de la línea de ${line} (aprox. +${roundPlain(diff)}).`;
  } else if (diff < -0.35) {
    totalRunsPick = formatMlbRunsSelection(false, line);
    totalRunsPlain = `El modelo espera ${roundPlain(total)} carreras en total, por debajo de la línea de ${line} (aprox. ${roundPlain(diff)}).`;
  } else {
    totalRunsPick = `Total cerca de ${line} (sin ventaja clara)`;
    totalRunsPlain = `La proyección (${roundPlain(total)}) está muy pegada a la línea del mercado (${line}).`;
  }

  const homeOutlook = buildTeamOutlook(
    game.homeTeam,
    game.homeTeam.offense,
    projections.homeRuns,
    game.awayTeam.name
  );
  const awayOutlook = buildTeamOutlook(
    game.awayTeam,
    game.awayTeam.offense,
    projections.awayRuns,
    game.homeTeam.name
  );

  return {
    winnerPick: homeWins ? game.homeTeam.name : game.awayTeam.name,
    winnerSummary,
    totalRunsPick,
    totalRunsPlain,
    homeOutlook,
    awayOutlook,
    combinedSummary: `${winnerSummary} ${totalRunsPlain}`,
    byTeamRuns: [
      { team: game.awayTeam.name, projectedRuns: projections.awayRuns, label: "Visitante" },
      { team: game.homeTeam.name, projectedRuns: projections.homeRuns, label: "Local" },
    ],
  };
}

export function plainMoneylineRationale(game, selectedTeam, chooseHome, selectedPitcher, rivalPitcher) {
  const rivalTeam = chooseHome ? game.awayTeam : game.homeTeam;
  const ownBullpen = selectedTeam.bullpen;
  const rivalBullpen = rivalTeam.bullpen;

  const ownMetric = Number.isFinite(selectedPitcher.xFip30) ? selectedPitcher.xFip30 : selectedPitcher.era30;
  const rivalMetric = Number.isFinite(rivalPitcher.xFip30) ? rivalPitcher.xFip30 : rivalPitcher.era30;
  const metricLabel = Number.isFinite(selectedPitcher.xFip30) ? "xFIP" : "ERA";

  const ownStats = plainPitcherStatsSuffix(selectedPitcher);
  const rivalStats = plainPitcherStatsSuffix(rivalPitcher);

  let pitcherNote;
  if (Number.isFinite(ownMetric) && Number.isFinite(rivalMetric)) {
    pitcherNote = ownMetric < rivalMetric
      ? `abridor con ${metricLabel} ${roundPlain(ownMetric)}${ownStats} supera al rival (${roundPlain(rivalMetric)}${rivalStats})`
      : `abridor con ${metricLabel} ${roundPlain(ownMetric)}${ownStats} vs rival ${roundPlain(rivalMetric)}${rivalStats} — ventaja compensada por otros factores`;
  } else {
    const ownFallback = plainPitcherFormStats(selectedPitcher);
    const rivalFallback = plainPitcherFormStats(rivalPitcher);
    if (ownFallback || rivalFallback) {
      pitcherNote = `abridor${ownFallback ? ` (${ownFallback})` : ""} frente a rival${rivalFallback ? ` (${rivalFallback})` : ""}`;
    } else {
      pitcherNote = `abridor en mejor forma que el rival`;
    }
  }

  const handLabel = selectedPitcher.handLabel || rivalPitcher.handLabel || "N/D";
  const offenseOps = chooseHome
    ? (selectedTeam.offense.homeAwayOps || selectedTeam.offense.splitVsHandOps || selectedTeam.offense.seasonOps)
    : (selectedTeam.offense.splitVsHandOps || selectedTeam.offense.seasonOps);
  const batingNote = Number.isFinite(offenseOps)
    ? `bateo OPS ${roundPlain(offenseOps)} contra mano ${handLabel}`
    : `bateo encaja contra la mano del pitcher rival`;

  const bullpenNote = ownBullpen.usage48hPitches <= rivalBullpen.usage48hPitches
    ? "relevo descansado"
    : "relevo sin ventaja clara";

  const hvs = selectedPitcher.historyVsOpponent;
  const historyNote = hvs?.games >= 3 && hvs.era != null
    ? ` Historial del abridor vs este rival: ${hvs.games} salidas, ERA ${roundPlain(hvs.era)}.`
    : "";

  const locationLabel = chooseHome ? "local" : "visitante";
  const core =
    `${selectedTeam.name} (${locationLabel}) para ganar: ${pitcherNote}, ${batingNote}, ${bullpenNote}.` +
    historyNote;
  return appendPitchersContextToRationale(core, game);
}

function plainPitcherLine(pitcher, roleLabel) {
  const full = plainPitcherFullDescription(pitcher, roleLabel);
  return full.endsWith(".") ? full.slice(0, -1) : full;
}

function plainOffenseLine(team, offense) {
  const recent = Number.isFinite(offense?.runsLast10) ? roundPlain(offense.runsLast10) : "N/D";
  const season = Number.isFinite(offense?.seasonRunsPerGame) ? roundPlain(offense.seasonRunsPerGame) : "N/D";
  const split = Number.isFinite(offense?.splitVsHandOps) ? ` · OPS vs mano ${roundPlain(offense.splitVsHandOps)}` : "";
  return `${team.name}: ${recent} carreras/10 partidos (temporada ${season}${split})`;
}

export function plainMlbPitchingBattingContext(game) {
  if (!game?.homeTeam || !game?.awayTeam) return "";
  const homePitcher = game.homePitcher || {};
  const awayPitcher = game.awayPitcher || {};
  const homeOffense = game.homeTeam.offense || {};
  const awayOffense = game.awayTeam.offense || {};

  const homeBullpen = Number.isFinite(game.homeTeam?.bullpen?.era7)
    ? `relevo local ERA7 ${roundPlain(game.homeTeam.bullpen.era7)}`
    : "relevo local sin dato ERA7";
  const awayBullpen = Number.isFinite(game.awayTeam?.bullpen?.era7)
    ? `relevo visitante ERA7 ${roundPlain(game.awayTeam.bullpen.era7)}`
    : "relevo visitante sin dato ERA7";

  return (
    `Pitcheo: ${plainPitcherLine(awayPitcher, "visitante")}; ${plainPitcherLine(homePitcher, "local")} (${awayBullpen}, ${homeBullpen}). ` +
    `Bateo: ${plainOffenseLine(game.awayTeam, awayOffense)}; ${plainOffenseLine(game.homeTeam, homeOffense)}.`
  );
}

export function plainMlbValueHeadline(recommendation, ev) {
  const fromEv = valueLabelFromEv(ev);
  if (fromEv !== "Sin valor") return fromEv;
  const type = String(recommendation?.type || recommendation?.marketKey || "").toLowerCase();
  if (type.includes("total")) return "Proyeccion de carreras";
  if (type.includes("moneyline")) return "Matchup de pitchers";
  if (type.includes("runline")) return "Handicap de carreras";
  if (type.includes("team-total")) return "Total de equipo";
  if ((recommendation?.confidence ?? 0) >= 55) return "Senal del modelo";
  return "Lectura estadistica";
}

function valueLabelFromEv(ev) {
  if (!Number.isFinite(ev)) return "Sin valor";
  if (ev >= 0.1) return "Alto valor";
  if (ev >= 0.05) return "Valor moderado";
  if (ev >= 0.02) return "Valor marginal";
  return "Sin valor";
}

export function plainTotalsRationale(game, totalProjection, homeProjection, awayProjection, wantsOver) {
  const direction = wantsOver ? "MAS" : "MENOS";
  const diff = Math.abs(totalProjection - game.totalsLine);
  const diffNote = diff >= 1 ? `diferencia de ${roundPlain(diff)} carreras sobre la linea` : `diferencia ajustada de ${roundPlain(diff)} carreras`;
  const parkNote = plainParkCategory(game.park?.category || game.park).toLowerCase();
  const core =
    `Total proyectado: ${roundPlain(totalProjection)} carreras (${roundPlain(awayProjection)} visitante + ${roundPlain(homeProjection)} local). ` +
    `Linea en ${game.totalsLine}: apuesta al ${direction} (${diffNote}). ` +
    `Estadio ${parkNote}.`;
  const batting = plainMlbPitchingBattingContext(game);
  const withBatting = batting && !core.includes("Bateo:") ? `${core} ${batting}` : core;
  return appendPitchersContextToRationale(withBatting, game);
}

export function plainRunLineRationale(selectedTeam, point, rawGap, ownPitcher = null) {
  const pitcherBit =
    ownPitcher?.name && plainPitcherFormStats(ownPitcher)
      ? ` Abridor ${ownPitcher.name}: ${plainPitcherFormStats(ownPitcher)}.`
      : "";
  return (
    `${selectedTeam.name} en hándicap ${point > 0 ? "+" : ""}${point}: ` +
    `el modelo ve ventaja de ${roundPlain(rawGap)} puntos por pitcheo y relevo.${pitcherBit} ` +
    `Eso significa que debe ganar por 2 carreras (si es -1.5) o no perder por más de 1 (si es +1.5).`
  );
}

export function plainRiskNotes(game) {
  const notes = [];

  if (!game.homeTeam.lineup.confirmed || !game.awayTeam.lineup.confirmed) {
    notes.push("Aún no está confirmada la alineación de bateadores (lineup); el pronóstico puede cambiar.");
  }
  if (!game.oddsAvailable) {
    notes.push("No hay cuotas de casas de apuestas cargadas: ves ideas del modelo, pero no se valida si la cuota paga bien.");
  }
  if (!game.homePitcher.statcastAvailable || !game.awayPitcher.statcastAvailable) {
    notes.push(
      "Las métricas avanzadas del pitcher (xFIP) son una estimación con datos oficiales, no Statcast completo."
    );
  }
  if (game.homeTeam.bullpen.leverageIndex == null || game.awayTeam.bullpen.leverageIndex == null) {
    notes.push("No tenemos índice de presión del relevo; usamos ERA, fatiga 48h y apariciones recientes.");
  }
  if (game.proContext?.weatherNote) {
    notes.push(`Clima: ${game.proContext.weatherNote}.`);
  }
  if (game.proContext?.umpire) {
    notes.push(game.proContext.umpire);
  }
  if (game.homeTeam.scheduleFatigue?.tier === "alto" || game.awayTeam.scheduleFatigue?.tier === "alto") {
    notes.push("Calendario exigente detectado (viajes o partidos seguidos) en al menos un equipo.");
  }

  return notes;
}

export function plainSlateRiskNotes(hasOddsKey) {
  const notes = [
    "Las métricas xFIP del pitcher son estimadas; Statcast/Savant completo aún no está conectado.",
    "El motor usa Poisson + Monte Carlo (~4k sims); el clima y la fatiga de bullpen/calendario ajustan la proyección.",
    "Gestión de bankroll sugerida: no más del 2-3% de tu bank por apuesta.",
  ];
  if (!hasOddsKey) {
    notes.unshift(
      "Sin cuotas de casas de apuestas, no marcamos apuestas verdes aunque el modelo tenga favorito."
    );
  }
  return notes;
}

export function plainMethodology(hasOddsKey) {
  return {
    principle:
      "Primero leemos datos reales (resultados, pitchers, bateo). Si falta algo, lo decimos en pantalla en lugar de inventarlo.",
    note: hasOddsKey
      ? "Hay datos de casas de apuestas: las marcas verdes son apuestas con cuota y ventaja mínima del modelo."
      : "Sin cuotas cargadas: verás pronósticos por estadísticas de equipos; configura ODDS_API_IO_KEY en .env para activar cuotas.",
    scoring:
      "Poisson + Monte Carlo (4k simulaciones) sobre carreras proyectadas; EV = prob×cuota−1; scoring 0-100 con abridor, bateo, relevo fatigado, calendario, parque y valor de cuota.",
  };
}

export function plainProviderPurpose(provider) {
  const map = {
    "MLB Stats API": "Calendario, pitchers probables, alineaciones y estadísticas oficiales.",
    "Baseball Savant / PyBaseball": "Métricas avanzadas (aún parcial en esta versión).",
    "The Odds API": "Cuotas de ganador, total de carreras y hándicap.",
  };
  return map[provider.name] || provider.purpose;
}
