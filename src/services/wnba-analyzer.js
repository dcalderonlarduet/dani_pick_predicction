import { getRuntimeConfig } from "../config/runtime.js";
import { canonicalName } from "../providers/shared/tennis-normalizers.js";
import { extractCompetitors } from "../providers/shared/espn-pro.js";
import { buildWnbaGameContext, loadWnbaScoreboard } from "../providers/espn-wnba.js";
import {
  loadWnbaOddsMapForDates,
  loadWnbaDroppingOdds,
  loadWnbaValueBets,
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
import { evaluateWnbaGamePicks } from "./wnba-odds-policy.js";
import { getOddsHarvesterMatchContext } from "./oddsharvester-snapshot.js";
import { countIndependentSignalGroups } from "./pro-odds-scoring.js";

const SPORT = "wnba";

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
    n_senales: countIndependentSignalGroups({ valueBet: hasVb, dropping: drop12h >= 5, gapBooks: 0 }),
  };
}

async function buildWnbaGame({ teams, scheduleDate, oddsMap, vbIndex, dropIndex, scoreboardCache }) {
  const odds = findProOddsEntry(
    oddsMap,
    teams.homeName,
    teams.awayName,
    teams.eventId,
    scheduleDate,
    teams.startIso,
    "wnba"
  );
  const context = await buildWnbaGameContext({
    date: scheduleDate,
    home: teams.homeName,
    away: teams.awayName,
    eventId: teams.eventId,
    events: scoreboardCache[scheduleDate],
  });

  const hasOdds = Boolean(odds?.bookmakers && Object.keys(odds.bookmakers).length > 0);
  if (context?.flags) {
    context.flags.mercado_actualizado = hasOdds;
  }
  context.oddsAvailable = hasOdds;

  const lmSnapshot = await getOddsHarvesterMatchContext({
    home: teams.homeName,
    away: teams.awayName,
    sport: "wnba",
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
    sport: SPORT,
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
  game.recommendations = await evaluateWnbaGamePicks(game);
  game.picks = game.recommendations.filter((pick) => pick.bettable);
  return game;
}

export async function loadWNBASlate(date) {
  const events = await loadWnbaScoreboard(date);
  return events
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
    .filter(Boolean);
}

export async function buildWnbaAnalysis(date = todayInMadrid()) {
  const oddsRuntime = resolveOddsConfig();
  const yesterday = shiftDateString(date, -1);
  const tomorrow = shiftDateString(date, 1);

  const slateDates = [yesterday, date, tomorrow];
  const skipSignals = oddsApiSkipMarketSignals();

  const [eventsYesterday, eventsToday, eventsTomorrow, oddsMap, vbBet365, vbWinamax, dropping] =
    await Promise.all([
      loadWnbaScoreboard(yesterday).catch(() => []),
      loadWnbaScoreboard(date).catch(() => []),
      loadWnbaScoreboard(tomorrow).catch(() => []),
      loadWnbaOddsMapForDates(slateDates, oddsRuntime).catch(() => new Map()),
      skipSignals ? Promise.resolve([]) : loadWnbaValueBets("Bet365").catch(() => []),
      skipSignals ? Promise.resolve([]) : loadWnbaValueBets("Winamax FR").catch(() => []),
      skipSignals ? Promise.resolve([]) : loadWnbaDroppingOdds(5, "12h").catch(() => []),
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
    return buildProUnavailableAnalysis(SPORT, date, "No hay partidos WNBA en ventana ayer/hoy/mañana.", {
      hasOddsKey: oddsRuntime.hasOddsKey,
      apiSportsEnabled: false,
    });
  }

  const builtGames = await mapWithConcurrency(raw, 4, (entry) =>
    buildWnbaGame({ ...entry, oddsMap, vbIndex, dropIndex, scoreboardCache })
  );
  const games = builtGames.filter((game) => game && isProGameUpcoming(game));

  const upcoming = games.filter((game) => isProGameOnTargetDate(game, date));
  const bettable = upcoming.filter((game) => (game.picks || []).some((pick) => isProRecommendationBettable(pick, SPORT)));
  const picks = bettable
    .flatMap((game) => (game.picks || []).map((pick) => mapWnbaPickToUi(pick, game)))
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 24);
  const modelPicks = upcoming
    .flatMap((game) => (game.recommendations || []).map((pick) => mapWnbaPickToUi(pick, game)))
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 40);

  return {
    sport: SPORT,
    date,
    dataAvailable: upcoming.length > 0,
    games: upcoming,
    picks,
    modelPicks,
    providers: buildProProvidersManifest({
      sport: SPORT,
      hasOddsKey: oddsRuntime.hasOddsKey,
      apiSportsEnabled: false,
    }),
    slateSummary: {
      totalGames: upcoming.length,
      bettableGames: bettable.length,
      topPicks: picks.length,
      gamesAnalyzed: upcoming.length,
    },
  };
}

const WNBA_MARKET_LABELS = {
  team_total_home: "Team total local",
  team_total_away: "Team total visitante",
  game_total: "Total partido",
  moneyline: "Ganador",
};

function formatWnbaPickLabel(pick, game) {
  if (pick.market === "moneyline") {
    const team = pick.side === "home" ? game.home : game.away;
    return `(ML) ${team}`;
  }
  const sideLabel = pick.side === "over" ? "Más de" : pick.side === "under" ? "Menos de" : String(pick.side);
  const market = WNBA_MARKET_LABELS[pick.market] || pick.market;
  return pick.line != null ? `${market} · ${sideLabel} ${pick.line}` : `${market} · ${sideLabel}`;
}

function mapWnbaPickToUi(pick, game) {
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
    sport: SPORT,
    sportId: SPORT,
    partido: `${game.away} @ ${game.home}`,
    pick: formatWnbaPickLabel(pick, game),
    mercado: WNBA_MARKET_LABELS[pick.market] || pick.market,
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
    rationale: `Score ${pick.score_final ?? pick.score} · LM NEUTRO (WNBA)`,
  };
}
