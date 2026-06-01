export function normalizeQuinielaTeamName(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\br\.\s*/g, "real ")
    .replace(/\bat\.\s*/g, "atletico ")
    .replace(/\s+de\s+/g, " ")
    .toLowerCase()
    .trim();
}

function normalizeTeamName(name) {
  return normalizeQuinielaTeamName(name);
}

export function buildQuinielaPairKey(home, away) {
  const h = normalizeQuinielaTeamName(home);
  const a = normalizeQuinielaTeamName(away);
  if (!h || !a) return "";
  return `${h}|${a}`;
}

export function indexOfficialQuinielaRows(rows = []) {
  const byPair = new Map();
  for (const row of rows) {
    const key = buildQuinielaPairKey(row?.home, row?.away);
    if (key) byPair.set(key, row);
  }
  return byPair;
}

export function isQuinielaOfficialMatch(home, away, rowsOrIndex = []) {
  const homeKey = normalizeQuinielaTeamName(home);
  const awayKey = normalizeQuinielaTeamName(away);
  if (!homeKey || !awayKey) return false;

  const index = rowsOrIndex instanceof Map ? rowsOrIndex : indexOfficialQuinielaRows(rowsOrIndex);
  if (index.has(`${homeKey}|${awayKey}`)) return true;

  for (const key of index.keys()) {
    const [h, a] = key.split("|");
    if ((h.includes(homeKey) || homeKey.includes(h)) && (a.includes(awayKey) || awayKey.includes(a))) {
      return true;
    }
  }
  return false;
}

export function filterPartidosExcludingQuiniela(partidos = [], rows = []) {
  if (!rows?.length) return partidos;
  return partidos.filter((partido) => !isQuinielaOfficialMatch(partido?.home, partido?.away, rows));
}

export function filterPicksExcludingQuiniela(picks = [], rows = []) {
  if (!rows?.length) return picks;
  return picks.filter((pick) => {
    const label = String(pick?.partido || "");
    const match = label.match(/^(.+?)\s+vs\s+(.+)$/i);
    if (!match) return true;
    return !isQuinielaOfficialMatch(match[1].trim(), match[2].trim(), rows);
  });
}

export function indexFootballPartidos(partidos = []) {
  const byPair = new Map();
  for (const partido of partidos) {
    const home = normalizeTeamName(partido?.home || partido?.homeTeam?.name || "");
    const away = normalizeTeamName(partido?.away || partido?.awayTeam?.name || "");
    if (!home || !away) continue;
    byPair.set(`${home}|${away}`, partido);
  }
  return byPair;
}

export function resolveOfficialPartidoAgainstFootball(cardRow, byPair) {
  const home = normalizeTeamName(cardRow.home);
  const away = normalizeTeamName(cardRow.away);
  const direct = byPair.get(`${home}|${away}`);
  if (direct) return direct;

  for (const [key, partido] of byPair.entries()) {
    const [h, a] = key.split("|");
    if ((h.includes(home) || home.includes(h)) && (a.includes(away) || away.includes(a))) {
      return partido;
    }
  }
  return null;
}

export function buildBundleFromFootballPartido(partido, cardRow = {}) {
  if (!partido) return null;
  return {
    order: cardRow.order ?? null,
    partidoLabel: `${cardRow.home || partido.home} vs ${cardRow.away || partido.away}`,
    eventId: partido.eventId || partido.id || null,
    home: cardRow.home || partido.home,
    away: cardRow.away || partido.away,
    matchModel: partido.matchModel || null,
    footballCtx: partido.footballCtx || null,
    mlOdds: partido.mlOdds || null,
    oddsDrop: partido.oddsDrop || null,
    lineMovementInput: partido.lineMovementInput || null,
    lineMovementMl: partido.lineMovementMl || null,
    lineups: partido.lineups || null,
    homeTeam: partido.homeTeam || null,
    awayTeam: partido.awayTeam || null,
    dataSource: partido.source || partido.footballCtx?.source || "football-desk",
    isPlaceholder: false,
    bridgeSource: "football-partido",
  };
}

export function buildBundleFromEspnInsight(insight, cardRow = {}) {
  if (!insight) return null;
  const ctx = insight.ctx || {};
  return {
    order: cardRow.order ?? null,
    partidoLabel: `${cardRow.home} vs ${cardRow.away}`,
    eventId: insight.eventId || `quiniela-espn-${cardRow.order}`,
    home: cardRow.home,
    away: cardRow.away,
    matchModel: insight.matchModel || null,
    footballCtx: {
      source: "espn-direct",
      model_home_prob: ctx.model_home_prob ?? insight.matchModel?.model_home_prob ?? null,
      model_draw_prob: ctx.model_draw_prob ?? insight.matchModel?.model_draw_prob ?? null,
      model_away_prob: ctx.model_away_prob ?? insight.matchModel?.model_away_prob ?? null,
      expected_goals: ctx.expected_goals ?? insight.matchModel?.expectedGoals ?? null,
      home_lineup_confirmed: Boolean(ctx.home_lineup_confirmed),
      away_lineup_confirmed: Boolean(ctx.away_lineup_confirmed),
      lineup_confirmed: Boolean(ctx.lineup_confirmed),
      injuries: 0,
    },
    mlOdds: null,
    oddsDrop: null,
    lineups: insight.lineups || null,
    homeTeam: insight.homeTeam || null,
    awayTeam: insight.awayTeam || null,
    dataSource: "espn-direct",
    isPlaceholder: false,
    bridgeSource: "espn-direct",
  };
}

export function buildUncertainBundle(cardRow) {
  return {
    order: cardRow.order ?? null,
    partidoLabel: `${cardRow.home} vs ${cardRow.away}`,
    eventId: `quiniela-unknown-${cardRow.order}`,
    home: cardRow.home,
    away: cardRow.away,
    matchModel: null,
    footballCtx: null,
    mlOdds: null,
    oddsDrop: null,
    lineups: null,
    homeTeam: { name: cardRow.home },
    awayTeam: { name: cardRow.away },
    dataSource: "no-data",
    isPlaceholder: true,
    bridgeSource: "uncertain",
  };
}

export function buildFootballMatchBundle(cardRow, byPair, espnInsights = {}) {
  const partido = resolveOfficialPartidoAgainstFootball(cardRow, byPair);
  if (partido) return buildBundleFromFootballPartido(partido, cardRow);
  const insight = espnInsights[cardRow.order];
  if (insight) return buildBundleFromEspnInsight(insight, cardRow);
  return buildUncertainBundle(cardRow);
}

export function bundleToMatchShape(bundle) {
  if (!bundle) return null;
  return {
    id: bundle.eventId,
    homeTeam: bundle.homeTeam || { name: bundle.home },
    awayTeam: bundle.awayTeam || { name: bundle.away },
    matchModel: bundle.matchModel || {},
    footballCtx: bundle.footballCtx,
    mlOdds: bundle.mlOdds,
    oddsDrop: bundle.oddsDrop,
    lineMovementInput: bundle.lineMovementInput || null,
    lineMovementMl: bundle.lineMovementMl || null,
    lineups: bundle.lineups,
    stadium: bundle.stadium || null,
    referee: bundle.referee || null,
    scheduledAt: bundle.scheduledAt || null,
    date: bundle.date || null,
    status: "scheduled",
    dataSource: bundle.dataSource,
  };
}
