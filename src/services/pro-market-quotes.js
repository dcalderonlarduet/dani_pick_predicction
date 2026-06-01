import { canonicalName } from "../providers/shared/tennis-normalizers.js";
import { impliedProbabilityFromDecimal } from "./pro-odds-scoring.js";

function gapBooks(a, b) {
  const left = impliedProbabilityFromDecimal(a);
  const right = impliedProbabilityFromDecimal(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 0;
  return Math.abs(left - right);
}

function readBook(bookmakers, name) {
  if (!bookmakers || typeof bookmakers !== "object") return {};
  const canonical = canonicalName(name);
  if (bookmakers[name]) return bookmakers[name];
  if (bookmakers[String(name)]) return bookmakers[String(name)];
  if (canonical && bookmakers[canonical]) return bookmakers[canonical];

  for (const [key, book] of Object.entries(bookmakers)) {
    if (canonicalName(key) === canonical) return book;
  }
  return {};
}

export function pickProMarketQuote(bookmakers, marketKey) {
  const b365 = readBook(bookmakers, "Bet365");
  const winamax = readBook(bookmakers, "Winamax FR") || readBook(bookmakers, "Winamax");

  if (marketKey === "moneyline") {
    const home = b365?.winner?.[0];
    const away = b365?.winner?.[1];
    return {
      home,
      away,
      line: null,
      over: home,
      under: away,
      gap: gapBooks(home, winamax?.winner?.[0]),
      probMarket: impliedProbabilityFromDecimal(home),
    };
  }

  if (marketKey === "first_half_total") {
    const row = b365?.firstHalfTotal || {};
    const alt = winamax?.firstHalfTotal || {};
    return {
      line: row?.line,
      over: row?.over,
      under: row?.under,
      gap: gapBooks(row?.over, alt?.over),
    };
  }

  if (marketKey === "team_total_home") {
    const row = b365?.teamTotalHome || {};
    const alt = winamax?.teamTotalHome || {};
    return {
      line: row?.line,
      over: row?.over,
      under: row?.under,
      gap: gapBooks(row?.over, alt?.over),
    };
  }

  if (marketKey === "team_total_away") {
    const row = b365?.teamTotalAway || {};
    const alt = winamax?.teamTotalAway || {};
    return {
      line: row?.line,
      over: row?.over,
      under: row?.under,
      gap: gapBooks(row?.over, alt?.over),
    };
  }

  const row = b365?.totals || {};
  const alt = winamax?.totals || {};
  return {
    line: row?.line,
    over: row?.over,
    under: row?.under,
    gap: gapBooks(row?.over, alt?.over),
  };
}

export function estimateFirstHalfLineFromGame(gameLine, sport = "nba") {
  const line = Number(gameLine);
  if (!Number.isFinite(line)) return null;
  const ratio = sport === "nfl" ? 0.48 : 0.49;
  return Math.round(line * ratio * 2) / 2;
}

export function lineMovementSideForPick(marketKey, side) {
  if (marketKey === "moneyline") return side;
  return side;
}

export function openingLineForMarket(gameLmInput, marketKey, quote, gameOdds = {}) {
  if (marketKey === "moneyline") {
    return {
      cuota_apertura_home: gameLmInput?.cuota_apertura_home ?? quote?.home,
      cuota_actual_home: quote?.home,
      cuota_apertura_away: gameLmInput?.cuota_apertura_away ?? quote?.away,
      cuota_actual_away: quote?.away,
    };
  }
  const openByMarket = gameLmInput?.[`${marketKey}_apertura`];
  let fallbackOpen = quote?.line;
  if (marketKey === "first_half_total") {
    fallbackOpen = gameLmInput?.linea_apertura ?? gameOdds?.firstHalfLine ?? quote?.line;
  } else if (marketKey === "game_total") {
    fallbackOpen = gameLmInput?.linea_apertura ?? gameOdds?.totalsLine ?? quote?.line;
  }
  return {
    linea_apertura: openByMarket ?? fallbackOpen,
    linea_actual: quote?.line,
  };
}
