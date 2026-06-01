import { getRuntimeConfig } from "../config/runtime.js";
import { canonicalName } from "../providers/shared/tennis-normalizers.js";
import { extractCompetitors } from "../providers/shared/espn-pro.js";
import { buildNflGameContext, loadNflScoreboard } from "../providers/espn-nfl.js";
import { getApiSportsAmericanFootballConfig } from "../providers/api-sports-american-football.js";
import {
  loadAmericanFootballDroppingOdds,
  loadAmericanFootballOddsMapForDates,
  loadAmericanFootballValueBets,
  oddsApiSkipMarketSignals,
} from "../providers/odds-api-io.js";
import { shiftDateString } from "../utils/madrid-date.js";
import { isProGameOnTargetDate, isProRecommendationBettable } from "../utils/bettable-events.js";
import { isProGameAlreadyPlayed, isProGameUpcoming } from "../utils/event-status.js";
import {
  buildProProvidersManifest,
  buildProUnavailableAnalysis,
  findProOddsEntry,
  mapWithConcurrency,
} from "./pro-analyzer-shared.js";
import { getOddsHarvesterMatchContext } from "./oddsharvester-snapshot.js";
import { evaluateNflGamePicks } from "./nfl-odds-policy.js";
import { countIndependentSignalGroups } from "./pro-odds-scoring.js";

function todayInMadrid() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: getRuntimeConfig().timezone || "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function resolveOddsConfig() {
  const cfg = getRuntimeConfig();
  return {
    hasOddsKey: Boolean(cfg.oddsApiIo?.apiKey || process.env.ODDS_API_IO_KEY),
    oddsApiIo: {
      apiKey: process.env.ODDS_API_IO_KEY || cfg.oddsApiIo?.apiKey || "",
      baseUrl: process.env.ODDS_API_IO_BASE_URL || cfg.oddsApiIo?.baseUrl || "https://api.odds-api.io/v3",
      bookmakers: cfg.oddsApiIo?.bookmakers || ["Bet365", "Winamax FR"],
    },
  };
}

function indexValueBets(rows) {
  const index = {};
  for (const row of rows || []) {
    const key = String(row?.eventId || "");
    if (!key) continue;
    if (!index[key]) index[key] = [];
    index[key].push(row);
  }
  return index;
}

function indexDropping(rows) {
  const index = {};
  for (const row of rows || []) {
    const key = String(row?.eventId || "");
    if (!key) continue;
    const drop12h = row?.odds?.drop?.["12h"] || 0;
    if (!index[key] || drop12h > (index[key]?.odds?.drop?.["12h"] || 0)) index[key] = row;
  }
  return index;
}

function attachMarketSignals(game, vbRows, dropRow) {
  const hasVb = Array.isArray(vbRows) && vbRows.length > 0;
  const drop12h = Number(dropRow?.odds?.drop?.["12h"] || 0);
  game.marketSignals = {
    valueBet: hasVb,
    dropping: drop12h >= 5,
    drop12h,
    dropBetSide: dropRow?.betSide || dropRow?.side || null,
    dropMarket: dropRow?.market?.name || dropRow?.market || null,
    evExternal: hasVb ? vbRows[0]?.expectedValue ?? vbRows[0]?.ev : null,
    n_senales: countIndependentSignalGroups({
      valueBet: hasVb,
      dropping: drop12h >= 5,
      gapBooks: 0,
    }),
  };
}

async function buildNflGame({ teams, scheduleDate, oddsMap, vbIndex, dropIndex, scoreboardCache }) {
  const odds = findProOddsEntry(
    oddsMap,
    teams.homeName,
    teams.awayName,
    teams.eventId,
    scheduleDate,
    teams.startIso
  );
  const context = await buildNflGameContext({
    date: scheduleDate,
    home: teams.homeName,
    away: teams.awayName,
    eventId: teams.eventId,
    events: scoreboardCache[scheduleDate],
  });

  const lmSnapshot = await getOddsHarvesterMatchContext({
    home: teams.homeName,
    away: teams.awayName,
    sport: "nfl",
    marketKey: "first_half_total",
    eventId: teams.eventId,
    scheduleDate,
    startTime: teams.startIso,
  });

  const game = {
    id: teams.eventId,
    home: teams.homeName,
    away: teams.awayName,
    startTime: teams.startIso,
    status: teams.status,
    scheduleDate,
    odds,
    oddsApiIoEventId: odds?.eventId || null,
    context,
    lineMovementInput: {
      pct_tickets_home: lmSnapshot?.pct_tickets_home ?? 50,
      pct_money_home: lmSnapshot?.pct_money_home ?? 50,
      linea_apertura: lmSnapshot?.linea_apertura ?? odds?.firstHalfLine ?? odds?.totalsLine,
      linea_actual: lmSnapshot?.linea_actual ?? odds?.firstHalfLine ?? odds?.totalsLine,
    },
  };

  attachMarketSignals(game, vbIndex[String(odds?.eventId || "")], dropIndex[String(odds?.eventId || "")]);
  if (context?.flags) {
    context.flags.mercado_actualizado = Boolean(odds?.bookmakers);
    context.flags.freshness_ok = Boolean(odds);
    context.flags.muestra_suficiente =
      (context.home?.form?.source === "espn-season-stats") &&
      (context.away?.form?.source === "espn-season-stats");
    context.flags.noticia_explica_movimiento = Boolean(context.hay_noticia_lesion);
  }
  game.recommendations = await evaluateNflGamePicks(game);
  game.picks = game.recommendations.filter((pick) => pick.bettable);
  return game;
}

export async function loadNFLSlate(week, season) {
  const date = todayInMadrid();
  const events = await loadNflScoreboard(date);
  return {
    week: week ?? null,
    season: season ?? new Date().getUTCFullYear(),
    games: events
      .map((event) => {
        const teams = extractCompetitors(event);
        if (!teams) return null;
        return {
          eventId: teams.eventId,
          home: teams.homeName,
          away: teams.awayName,
          startTime: teams.startIso,
          status: teams.status,
        };
      })
      .filter(Boolean),
  };
}

export async function buildNflAnalysis(date = todayInMadrid(), week = null, season = null) {
  const oddsRuntime = resolveOddsConfig();
  const apiSportsEnabled = getApiSportsAmericanFootballConfig().enabled;
  const yesterday = shiftDateString(date, -1);
  const tomorrow = shiftDateString(date, 1);

  const slateDates = [yesterday, date, tomorrow];
  const skipSignals = oddsApiSkipMarketSignals();

  const [eventsYesterday, eventsToday, eventsTomorrow, oddsMap, vbBet365, vbWinamax, dropping] =
    await Promise.all([
      loadNflScoreboard(yesterday).catch(() => []),
      loadNflScoreboard(date).catch(() => []),
      loadNflScoreboard(tomorrow).catch(() => []),
      loadAmericanFootballOddsMapForDates(slateDates, oddsRuntime).catch(() => new Map()),
      skipSignals ? Promise.resolve([]) : loadAmericanFootballValueBets("Bet365").catch(() => []),
      skipSignals ? Promise.resolve([]) : loadAmericanFootballValueBets("Winamax FR").catch(() => []),
      skipSignals ? Promise.resolve([]) : loadAmericanFootballDroppingOdds(5, "12h").catch(() => []),
    ]);
  const vbIndex = indexValueBets([...vbBet365, ...vbWinamax]);
  const dropIndex = indexDropping(dropping);
  const scoreboardCache = {
    [yesterday]: eventsYesterday,
    [date]: eventsToday,
    [tomorrow]: eventsTomorrow,
  };

  const raw = [];
  for (const [scheduleDate, events] of [
    [yesterday, eventsYesterday],
    [date, eventsToday],
    [tomorrow, eventsTomorrow],
  ]) {
    for (const event of events) {
      const teams = extractCompetitors(event);
      if (!teams || isProGameAlreadyPlayed({ status: teams.status })) continue;
      raw.push({ teams, scheduleDate });
    }
  }

  if (!raw.length) {
    return buildProUnavailableAnalysis("nfl", date, "No hay partidos NFL en ventana ayer/hoy/mañana.", {
      hasOddsKey: oddsRuntime.hasOddsKey,
      apiSportsEnabled,
      week,
      season: season ?? new Date().getUTCFullYear(),
    });
  }

  const builtGames = await mapWithConcurrency(raw, 4, (entry) =>
    buildNflGame({ ...entry, oddsMap, vbIndex, dropIndex, scoreboardCache })
  );
  const games = builtGames.filter((game) => game && isProGameUpcoming(game));

  const upcoming = games.filter((game) => isProGameOnTargetDate(game, date));
  const bettable = upcoming.filter((game) => (game.picks || []).some(isProRecommendationBettable));
  const picks = bettable
    .flatMap((game) => (game.picks || []).map((pick) => mapNflPickToUi(pick, game)))
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 24);
  const modelPicks = upcoming
    .flatMap((game) => (game.recommendations || []).map((pick) => mapNflPickToUi(pick, game)))
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 40);

  return {
    sport: "nfl",
    date,
    week,
    season: season ?? new Date().getUTCFullYear(),
    dataAvailable: upcoming.length > 0,
    games: upcoming,
    picks,
    modelPicks,
    providers: buildProProvidersManifest({
      sport: "nfl",
      hasOddsKey: oddsRuntime.hasOddsKey,
      apiSportsEnabled,
    }),
    slateSummary: {
      totalGames: upcoming.length,
      bettableGames: bettable.length,
      topPicks: picks.length,
      gamesAnalyzed: upcoming.length,
    },
  };
}

const NFL_MARKET_LABELS = {
  first_half_total: "Total 1ª mitad",
  team_total_home: "Team total local",
  team_total_away: "Team total visitante",
  game_total: "Total partido",
  moneyline: "Ganador",
};

function formatNflPickLabel(pick, game) {
  if (pick.market === "moneyline") {
    const team = pick.side === "home" ? game.home : game.away;
    return `(ML) ${team}`;
  }
  const sideLabel = pick.side === "over" ? "Más de" : pick.side === "under" ? "Menos de" : String(pick.side);
  const market = NFL_MARKET_LABELS[pick.market] || pick.market;
  return pick.line != null ? `${market} · ${sideLabel} ${pick.line}` : `${market} · ${sideLabel}`;
}

function mapNflPickToUi(pick, game) {
  const drop12h = Number(pick?.drop12h ?? game?.marketSignals?.drop12h ?? game?.drop12h ?? 0);
  return {
    ...pick,
    id: `${game.id}|${pick.market}|${pick.side}|${pick.line ?? ""}`,
    gameId: game.id,
    matchId: game.id,
    eventId: game.id,
    home: game.home,
    away: game.away,
    startTime: game.startTime,
    status: game.status,
    scheduleDate: game.scheduleDate,
    partido: `${game.away} @ ${game.home}`,
    pick: formatNflPickLabel(pick, game),
    mercado: NFL_MARKET_LABELS[pick.market] || pick.market,
    market: pick.market,
    betSide: pick.side,
    linea: pick.line,
    line: pick.line,
    cuota: pick.odds,
    estado: pick.color,
    confianza: pick.confidence,
    ev: pick.ev_model,
    evDisplay: pick.ev_display ?? pick.ev_model,
    evRaw: pick.ev_raw ?? pick.ev_model,
    expectedValue: pick.ev_model,
    bettable: pick.bettable,
    drop12h,
    droppingOddsSignal: pick.droppingOddsSignal || (drop12h >= 8 ? "confirmed" : null),
    rationale: `Score ${pick.score_final ?? pick.score} · LM ${pick.line_movement?.tipo || "NEUTRO"}`,
  };
}
