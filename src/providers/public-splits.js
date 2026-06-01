const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export const DK_SPLITS_BASE_URL =
  "https://dknetwork.draftkings.com/draftkings-sportsbook-betting-splits/";

/** DraftKings `tb_eg` sport group ids from the page filter. */
export const DK_SPORT_IDS = {
  mlb: "84240",
  nba: "42648",
  nfl: "88808",
  wnba: "94682",
};

export const SUPPORTED_PUBLIC_SPLIT_SPORTS = ["mlb", "nba", "nfl", "wnba"];

const SBD_SPORT_PATHS = {
  mlb: "mlb",
  nba: "nba",
  nfl: "nfl",
};

function stripTags(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePercent(value) {
  const match = String(value || "").match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? Number(match[1]) : null;
}

function normalizeMarketType(label) {
  const text = String(label || "").toLowerCase();
  if (text.includes("moneyline")) return "moneyline";
  if (text.includes("spread") || text.includes("run line") || text.includes("puck line")) return "spread";
  if (text.includes("total")) return "total";
  return text.replace(/\s+/g, "_") || "unknown";
}

function parseOddRow(rowHtml) {
  const structured = rowHtml.match(
    /<div class="tb-slipline">([\s\S]*?)<\/div>[\s\S]*?<div>(\d+(?:\.\d+)?)\s*%[\s\S]*?<div>(\d+(?:\.\d+)?)\s*%/i
  );
  if (structured) {
    return {
      label: stripTags(structured[1]),
      handlePct: Number(structured[2]),
      betsPct: Number(structured[3]),
    };
  }
  const label = stripTags(rowHtml.match(/class="tb-slipline"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || "");
  const percentages = [...rowHtml.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((match) => Number(match[1]));
  return {
    label,
    handlePct: percentages[0] ?? null,
    betsPct: percentages[1] ?? null,
  };
}

function parseMarketsFromGameBlock(block) {
  const markets = {};
  const sections = block.split(/<div class="tb-se-head">/i).slice(1);
  for (const section of sections) {
    const headerLabel = stripTags(section.match(/<div>([\s\S]*?)<\/div>/i)?.[1] || "");
    const marketType = normalizeMarketType(headerLabel);
    const rows = [];
    for (const rowPart of section.split(/<div class="tb-sodd">/i).slice(1)) {
      const rowMatch = rowPart.match(
        /<div class="tb-slipline">([\s\S]*?)<\/div>[\s\S]*?<div>(\d+(?:\.\d+)?)\s*%[\s\S]*?<div>(\d+(?:\.\d+)?)\s*%/i
      );
      if (!rowMatch) continue;
      rows.push({
        label: stripTags(rowMatch[1]),
        handlePct: Number(rowMatch[2]),
        betsPct: Number(rowMatch[3]),
      });
    }
    if (rows.length) {
      markets[marketType] = { marketType, rows };
    }
  }
  return markets;
}

function findTeamRow(rows, teamName) {
  const target = stripTags(teamName).toLowerCase();
  if (!target) return null;
  let best = null;
  let bestScore = 0;
  for (const row of rows) {
    const label = row.label.toLowerCase();
    if (label === target) return row;
    if (label.includes(target) || target.includes(label)) {
      const score = Math.min(label.length, target.length) / Math.max(label.length, target.length);
      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    }
  }
  return bestScore >= 0.45 ? best : null;
}

function buildMatchupMarkets(markets, home, away) {
  const moneyline = markets.moneyline?.rows || [];
  const spread = markets.spread?.rows || [];
  const total = markets.total?.rows || [];

  const homeMl = findTeamRow(moneyline, home);
  const awayMl = findTeamRow(moneyline, away);
  const homeSpread = findTeamRow(spread, home) || spread.find((row) => /\+/.test(row.label) === false && row.label.toLowerCase().includes(home.split(" ").pop()?.toLowerCase() || ""));
  const awaySpread = findTeamRow(spread, away);
  const overRow = total.find((row) => /^over\b/i.test(row.label));
  const underRow = total.find((row) => /^under\b/i.test(row.label));

  return {
    moneyline: {
      home: homeMl,
      away: awayMl,
    },
    spread: {
      home: homeSpread,
      away: awaySpread,
    },
    total: {
      over: overRow,
      under: underRow,
    },
  };
}

export function buildDraftKingsSplitsUrl(sport, { dateWindow = "n30days", page = 1 } = {}) {
  const sportId = DK_SPORT_IDS[sport];
  if (!sportId) throw new Error(`unsupported_sport:${sport}`);
  const params = new URLSearchParams({
    tb_eg: sportId,
    tb_edate: dateWindow,
  });
  if (page > 1) params.set("tb_page", String(page));
  return `${DK_SPLITS_BASE_URL}?${params.toString()}`;
}

export function buildSportsBettingDimeUrl(sport) {
  const slug = SBD_SPORT_PATHS[sport];
  if (!slug) return null;
  return `https://www.sportsbettingdime.com/${slug}/public-betting-trends/`;
}

export function parseDraftKingsSplitsHtml(html, sport = null) {
  if (!html || typeof html !== "string") {
    return { ok: false, reason: "empty_html", games: [], sport };
  }
  if (!html.includes('class="tb-se"') || !html.includes('class="tb-sodd"')) {
    return { ok: false, reason: "structure_missing", games: [], sport };
  }

  const games = [];
  const gameRegex = /<div class="tb-se">([\s\S]*?)(?=<div class="tb-se">|$)/gi;
  let gameMatch;
  while ((gameMatch = gameRegex.exec(html))) {
    const block = gameMatch[1];
    const titleRaw = stripTags(
      block.match(/class="tb-se-title"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] || ""
    );
    if (!titleRaw.includes("@")) continue;
    const [away, home] = titleRaw.split("@").map((part) => part.trim());
    if (!away || !home) continue;

    const startTime = stripTags(block.match(/class="tb-se-title"[\s\S]*?<span>([\s\S]*?)<\/span>/i)?.[1] || "");

    const markets = parseMarketsFromGameBlock(block);

    const structured = buildMatchupMarkets(markets, home, away);
    const homeMl = structured.moneyline.home;
    games.push({
      sport,
      away,
      home,
      startTime,
      source: "draftkings",
      markets: {
        moneyline: {
          pct_tickets_home: homeMl?.betsPct ?? null,
          pct_tickets_away: structured.moneyline.away?.betsPct ?? null,
          pct_money_home: homeMl?.handlePct ?? null,
          pct_money_away: structured.moneyline.away?.handlePct ?? null,
        },
        spread: {
          pct_tickets_home: structured.spread.home?.betsPct ?? null,
          pct_money_home: structured.spread.home?.handlePct ?? null,
          pct_tickets_away: structured.spread.away?.betsPct ?? null,
          pct_money_away: structured.spread.away?.handlePct ?? null,
        },
        total: {
          pct_tickets_over: structured.total.over?.betsPct ?? null,
          pct_money_over: structured.total.over?.handlePct ?? null,
          pct_tickets_under: structured.total.under?.betsPct ?? null,
          pct_money_under: structured.total.under?.handlePct ?? null,
        },
      },
    });
  }

  return {
    ok: games.length > 0 && games.every((game) => Number.isFinite(Number(game?.markets?.moneyline?.pct_tickets_home))),
    reason: games.length ? "parsed" : "no_games",
    games,
    sport,
  };
}

function parseSbdUnavailable(html) {
  const lower = html.toLowerCase();
  return (
    lower.includes("public betting trends are not currently available") ||
    lower.includes("don't have public betting splits") ||
    lower.includes("do not have public betting splits")
  );
}

function parseSbdTableGames(html, sport) {
  const games = [];
  const rowRegex =
    /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html))) {
    const row = rowMatch[1];
    if (!/%/.test(row)) continue;
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => stripTags(match[1]));
    if (cells.length < 4) continue;
    const matchup = cells.find((cell) => /@|vs\.| at /i.test(cell)) || cells[0];
    if (!matchup || !/[@]|vs\.| at /i.test(matchup)) continue;

    let away = "";
    let home = "";
    if (matchup.includes("@")) {
      [away, home] = matchup.split("@").map((part) => part.trim());
    } else if (/ vs\.? /i.test(matchup)) {
      [away, home] = matchup.split(/\s+vs\.?\s+/i).map((part) => part.trim());
    } else if (/ at /i.test(matchup)) {
      [away, home] = matchup.split(/\s+at\s+/i).map((part) => part.trim());
    }
    if (!away || !home) continue;

    const percents = cells.map(parsePercent).filter((value) => value != null);
    if (percents.length < 2) continue;

    games.push({
      sport,
      away,
      home,
      source: "sportsbettingdime",
      markets: {
        moneyline: {
          pct_tickets_home: percents[0],
          pct_money_home: percents[1],
          pct_tickets_away: percents[2] ?? (percents[0] != null ? 100 - percents[0] : null),
          pct_money_away: percents[3] ?? (percents[1] != null ? 100 - percents[1] : null),
        },
      },
    });
  }
  return games;
}

export function parseSportsBettingDimeHtml(html, sport) {
  if (!html || typeof html !== "string") {
    return { ok: false, reason: "empty_html", games: [], sport };
  }
  if (parseSbdUnavailable(html)) {
    return { ok: false, reason: "unavailable", games: [], sport };
  }

  const games = parseSbdTableGames(html, sport);
  return {
    ok: games.length > 0,
    reason: games.length ? "parsed" : "structure_missing",
    games,
    sport,
  };
}

export async function fetchHtml(url, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`http_${response.status}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function scrapeDraftKingsSportSplits(sport, options = {}) {
  const maxPages = options.maxPages ?? 3;
  const games = [];
  let lastReason = "no_games";

  for (let page = 1; page <= maxPages; page += 1) {
    const url = buildDraftKingsSplitsUrl(sport, { page });
    const html = await fetchHtml(url, { timeoutMs: options.timeoutMs });
    const parsed = parseDraftKingsSplitsHtml(html, sport);
    lastReason = parsed.reason;
    if (!parsed.ok && page === 1) {
      return parsed;
    }
    if (!parsed.games.length) break;
    games.push(...parsed.games);
    if (parsed.games.length < 8) break;
  }

  return {
    ok: games.length > 0,
    reason: games.length ? "parsed" : lastReason,
    games,
    sport,
    source: "draftkings",
  };
}

export async function scrapeSportsBettingDimeSportSplits(sport, options = {}) {
  const url = buildSportsBettingDimeUrl(sport);
  if (!url) {
    return { ok: false, reason: "unsupported_sport", games: [], sport };
  }
  const html = await fetchHtml(url, { timeoutMs: options.timeoutMs });
  const parsed = parseSportsBettingDimeHtml(html, sport);
  return { ...parsed, source: "sportsbettingdime" };
}

export async function scrapePublicSplitsForSport(sport, options = {}) {
  try {
    const dk = await scrapeDraftKingsSportSplits(sport, options);
    if (dk.ok) return dk;
  } catch (error) {
    // fall through to SBD
  }

  try {
    const sbd = await scrapeSportsBettingDimeSportSplits(sport, options);
    if (sbd.ok) return sbd;
    return {
      ok: false,
      reason: sbd.reason || "fallback_failed",
      games: [],
      sport,
      source: null,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "fetch_failed",
      games: [],
      sport,
      source: null,
    };
  }
}

export async function scrapeAllPublicSplits(options = {}) {
  const sports = options.sports || SUPPORTED_PUBLIC_SPLIT_SPORTS;
  const results = await Promise.all(sports.map((sport) => scrapePublicSplitsForSport(sport, options)));
  const games = results.flatMap((result) => result.games || []);
  const bySport = Object.fromEntries(
    sports.map((sport) => {
      const sportResult = results.find((row) => row.sport === sport);
      return [
        sport,
        {
          ok: Boolean(sportResult?.ok),
          reason: sportResult?.reason || "unknown",
          source: sportResult?.source || null,
          games: sportResult?.games?.length || 0,
        },
      ];
    })
  );

  const okSports = Object.values(bySport).filter((row) => row.ok).length;

  return {
    ok: games.length > 0,
    partial: okSports > 0 && okSports < sports.length,
    games,
    bySport,
    source: results.some((row) => row.source === "draftkings")
      ? "draftkings"
      : results.some((row) => row.source === "sportsbettingdime")
        ? "sportsbettingdime"
        : null,
  };
}
