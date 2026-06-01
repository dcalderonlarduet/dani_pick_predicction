const GRAND_SLAM_RE = /(australian open|roland garros|french open|wimbledon|us open|grand slam)/i;
const MASTERS_RE = /(masters 1000|atp 1000|wta 1000|indian wells|miami open|madrid open|rome|cincinnati|shanghai|paris masters)/i;
const ATP_500_RE = /(atp 500|wta 500)/i;
const CHALLENGER_RE = /(challenger|itf|m15|m25|w15|w25|w50|w75|w100)/i;
const CLAY_TOUR_RE = /(roland garros|french open|monte carlo|madrid open|madrid|rome|internazionali bnl d italia|barcelona|hamburg|lyon|geneva|marrakech|estoril|bucharest|bastad|gstaad|umag|kitzbuhel|parma|strasbourg|charleston|bogota|palermo|sardinia|rio open|cordoba|buenos aires)/i;
const GRASS_TOUR_RE = /(wimbledon|halle|queen s club|queens club|stuttgart|eastbourne|mallorca|s hertogenbosch|rosmalen|nottingham|berlin|bad homburg)/i;
const INDOOR_TOUR_RE = /(paris masters|vienna|basel|metz|antwerp|stockholm|moselle|sofia|st petersburg|linz|luxembourg|moscow indoor|indoor)/i;

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function canonicalName(value) {
  return normalizeWhitespace(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function stableId(...parts) {
  const joined = parts.map((part) => String(part || "")).join("|");
  let hash = 0;
  for (let index = 0; index < joined.length; index += 1) {
    hash = (hash * 31 + joined.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function daysBetween(earlierIso, laterIso) {
  if (!earlierIso || !laterIso) return 0;
  const earlier = new Date(earlierIso);
  const later = new Date(laterIso);
  const diff = Math.round((later.getTime() - earlier.getTime()) / 86400000);
  return Number.isFinite(diff) ? Math.max(diff, 0) : 0;
}

export function inferCategoryFromApiTennis(eventTypeType = "") {
  const label = normalizeWhitespace(eventTypeType).toLowerCase();

  if (label.includes("wta") && label.includes("double")) return "WTA Doubles";
  if (label.includes("wta")) return "WTA Singles";
  if (label.includes("women") && label.includes("double")) return "WTA Doubles";
  if (label.includes("women")) return "WTA Singles";
  if (label.includes("double")) return "ATP Doubles";
  return "ATP Singles";
}

export function inferCategoryFromSportradar(competition = {}) {
  const type = normalizeWhitespace(competition.type).toLowerCase();
  const gender = normalizeWhitespace(competition.gender).toLowerCase();

  if (type.includes("mixed")) return "Mixed Doubles";
  if (type.includes("double") && gender.includes("women")) return "WTA Doubles";
  if (type.includes("double") && gender.includes("mixed")) return "Mixed Doubles";
  if (type.includes("double")) return "ATP Doubles";
  if (gender.includes("women")) return "WTA Singles";
  return "ATP Singles";
}

export function inferPointsImportance(tournamentName = "", roundName = "") {
  const haystack = `${tournamentName} ${roundName}`;

  if (GRAND_SLAM_RE.test(haystack) || MASTERS_RE.test(haystack)) {
    return "high";
  }

  if (ATP_500_RE.test(haystack)) {
    return "medium";
  }

  if (CHALLENGER_RE.test(haystack)) {
    return "low";
  }

  return "medium";
}

export function inferBestOf(category = "", tournamentName = "") {
  const label = `${category} ${tournamentName}`;

  if (category === "ATP Singles" && GRAND_SLAM_RE.test(label)) {
    return 5;
  }

  return 3;
}

export function inferSurfaceFromText(...values) {
  const haystack = values.map((value) => normalizeWhitespace(value)).join(" ").toLowerCase();

  if (haystack.includes("clay") || haystack.includes("tierra")) return "Clay";
  if (CLAY_TOUR_RE.test(haystack)) return "Clay";
  if (haystack.includes("grass") || haystack.includes("hierba")) return "Grass";
  if (GRASS_TOUR_RE.test(haystack)) return "Grass";
  if (haystack.includes("indoor")) return "Indoor";
  if (INDOOR_TOUR_RE.test(haystack)) return "Indoor";
  if (haystack.includes("hard") || haystack.includes("cement")) return "Hard";
  return "Hard";
}

export function parseSetScores(scores) {
  if (!Array.isArray(scores)) return [];

  return scores
    .map((setScore) => ({
      set: Number.parseInt(setScore.score_set ?? setScore.set ?? "", 10) || null,
      first: Number.parseInt(setScore.score_first ?? setScore.home_score ?? "", 10),
      second: Number.parseInt(setScore.score_second ?? setScore.away_score ?? "", 10),
    }))
    .filter((setScore) => Number.isFinite(setScore.first) && Number.isFinite(setScore.second));
}

export function totalGamesForSets(sets = []) {
  return sets.reduce((sum, item) => sum + item.first + item.second, 0);
}

export function estimateMinutesFromSets(sets = [], category = "ATP Singles") {
  const perGame =
    category.includes("Doubles") ? 3.5 :
    category.includes("WTA") ? 4.1 :
    4.5;

  return Math.round(totalGamesForSets(sets) * perGame);
}

export function getMatchSide(match, participantKey, participantName) {
  if (!match) return null;

  if (participantKey && String(match.first_player_key) === String(participantKey)) return "first";
  if (participantKey && String(match.second_player_key) === String(participantKey)) return "second";

  const firstName = canonicalName(match.event_first_player || match.first_player || "");
  const secondName = canonicalName(match.event_second_player || match.second_player || "");
  const targetName = canonicalName(participantName);

  if (targetName && targetName === firstName) return "first";
  if (targetName && targetName === secondName) return "second";
  return null;
}

export function computeRecentMetrics(recentMatches, { participantKey, participantName, category, totalsLine = 22.5 }) {
  const finished = recentMatches
    .filter((match) => /finished/i.test(String(match.event_status || match.status || "")))
    .slice(0, 10);

  let recentWins = 0;
  let recentLosses = 0;
  let totalGames = 0;
  let totalSet1Games = 0;
  let totalSet2Games = 0;
  let set1Samples = 0;
  let set2Samples = 0;
  let overCount = 0;
  let straightSetsCount = 0;
  let minutesLast3 = 0;
  let previousMatchMinutes = 0;
  let holdGames = 0;
  let serviceGames = 0;
  let breakGames = 0;
  let returnGames = 0;

  finished.forEach((match, index) => {
    const side = getMatchSide(match, participantKey, participantName);
    const sets = parseSetScores(match.scores);
    const total = totalGamesForSets(sets);
    const matchMinutes = estimateMinutesFromSets(sets, category);

    if (side === "first" && String(match.event_winner || "").toLowerCase().includes("first")) recentWins += 1;
    else if (side === "second" && String(match.event_winner || "").toLowerCase().includes("second")) recentWins += 1;
    else if (side) recentLosses += 1;

    if (sets.length >= 2) {
      if (sets[0]) {
        totalSet1Games += sets[0].first + sets[0].second;
        set1Samples += 1;
      }
      if (sets[1]) {
        totalSet2Games += sets[1].first + sets[1].second;
        set2Samples += 1;
      }
    }

    if (sets.length > 0) {
      totalGames += total;
      if (total > totalsLine) overCount += 1;
      if (sets.length === 2) straightSetsCount += 1;
    }

    if (index < 3) {
      minutesLast3 += matchMinutes;
      if (index === 0) previousMatchMinutes = matchMinutes;
    }

    if (Array.isArray(match.pointbypoint)) {
      for (const game of match.pointbypoint) {
        const served = normalizeWhitespace(game.player_served).toLowerCase();
        const serveWinner = normalizeWhitespace(game.serve_winner).toLowerCase();

        if (!served || !serveWinner || !side) continue;

        const playerServed =
          (side === "first" && served.includes("first")) ||
          (side === "second" && served.includes("second"));

        const playerWonServeGame =
          (side === "first" && serveWinner.includes("first")) ||
          (side === "second" && serveWinner.includes("second"));

        if (playerServed) {
          serviceGames += 1;
          if (playerWonServeGame) holdGames += 1;
        } else {
          returnGames += 1;
          if (playerWonServeGame) breakGames += 1;
        }
      }
    }
  });

  const sample = Math.max(finished.length, 1);
  return {
    recentWins,
    recentLosses,
    avgTotalGames: totalGames ? totalGames / sample : category.includes("WTA") ? 21.4 : 22.8,
    avgSet1Games: set1Samples ? totalSet1Games / set1Samples : 9.5,
    avgSet2Games: set2Samples ? totalSet2Games / set2Samples : 9.6,
    overLinePct: finished.length ? overCount / finished.length : 0.5,
    straightSetsPct: finished.length ? straightSetsCount / finished.length : 0.5,
    holdPct: serviceGames ? (holdGames / serviceGames) * 100 : 78,
    breakPct: returnGames ? (breakGames / returnGames) * 100 : 22,
    fatigueMinutesLast3: minutesLast3 || 240,
    previousMatchMinutes: previousMatchMinutes || 90,
  };
}

export function computeSurfaceStatsFromApiTennis(profile, category, surface) {
  const stats = Array.isArray(profile?.stats) ? profile.stats : [];
  const isDoubles = category.includes("Doubles");
  const normalizedSurface = surface.toLowerCase();
  const relevant = stats.filter((entry) => {
    const type = String(entry.type || "").toLowerCase();
    if (isDoubles && !type.includes("double")) return false;
    if (!isDoubles && type.includes("double")) return false;
    return true;
  });

  let wins = 0;
  let losses = 0;

  for (const row of relevant) {
    if (normalizedSurface === "clay") {
      wins += Number.parseInt(row.clay_won || "0", 10) || 0;
      losses += Number.parseInt(row.clay_lost || "0", 10) || 0;
    } else if (normalizedSurface === "grass") {
      wins += Number.parseInt(row.grass_won || "0", 10) || 0;
      losses += Number.parseInt(row.grass_lost || "0", 10) || 0;
    } else {
      wins += Number.parseInt(row.hard_won || "0", 10) || 0;
      losses += Number.parseInt(row.hard_lost || "0", 10) || 0;
    }
  }

  const sample = wins + losses;
  const winPct = sample ? wins / sample : 0.5;

  return {
    winPct,
    sample,
    adaptation: Math.min(0.95, Math.max(0.45, 0.45 + winPct * 0.5)),
  };
}

export function extractLatestRankFromApiTennisProfile(profile, category) {
  const stats = Array.isArray(profile?.stats) ? profile.stats : [];
  const isDoubles = category.includes("Doubles");
  const relevant = stats.filter((entry) => {
    const type = String(entry.type || "").toLowerCase();
    if (isDoubles && !type.includes("double")) return false;
    if (!isDoubles && type.includes("double")) return false;
    return true;
  });

  const sorted = relevant
    .map((entry) => ({
      season: Number.parseInt(entry.season || "0", 10) || 0,
      rank: Number.parseInt(entry.rank || "0", 10) || 0,
    }))
    .filter((entry) => entry.rank > 0)
    .sort((left, right) => right.season - left.season);

  return sorted[0]?.rank || null;
}

export function computeH2HMetrics(h2hMatches, surface) {
  const relevant = Array.isArray(h2hMatches) ? h2hMatches : [];
  let firstWins = 0;
  let secondWins = 0;

  for (const match of relevant) {
    const winner = normalizeWhitespace(match.event_winner || match.winner);
    const matchSurface = inferSurfaceFromText(match.surface, match.tournament_name, match.tournament_round);

    if (surface && matchSurface && matchSurface !== surface) {
      continue;
    }

    if (/first/i.test(winner)) firstWins += 1;
    if (/second/i.test(winner)) secondWins += 1;
  }

  return {
    firstWins,
    secondWins,
  };
}

export function defaultTotalsLine(category, surface, bestOf = 3) {
  if (bestOf === 5) {
    return surface === "Clay" ? 40.5 : 38.5;
  }
  if (category === "WTA Singles") return 21.5;
  if (category === "WTA Doubles") return 20.5;
  if (category === "ATP Doubles") return 22.0;
  if (surface === "Clay") return 22.5;
  return 23.0;
}

export function normalizeBookmakersFromApiTennis(oddsPayload, fallbackTotalsLine) {
  if (!oddsPayload || typeof oddsPayload !== "object") {
    return {
      bookmakers: {},
      totalsLine: fallbackTotalsLine,
      coverage: 0,
    };
  }

  const bookmakers = {};
  let totalsLine = fallbackTotalsLine;
  let totalsFound = false;

  const moneyline = oddsPayload["Home/Away"] || oddsPayload["Match Winner"] || oddsPayload["Home/Away Fulltime"];
  if (moneyline && typeof moneyline === "object") {
    for (const [bookmaker, homeValue] of Object.entries(moneyline.Home || {})) {
      const awayValue = moneyline.Away?.[bookmaker];
      if (!awayValue) continue;
      bookmakers[bookmaker.toLowerCase()] = {
        winner: [Number.parseFloat(homeValue), Number.parseFloat(awayValue)],
      };
    }
  }

  for (const [marketName, marketValue] of Object.entries(oddsPayload)) {
    if (!/over|under|o\/u|total/i.test(marketName)) continue;

    if (typeof marketValue !== "object" || !marketValue) continue;

    for (const [lineKey, lineValue] of Object.entries(marketValue)) {
      const maybeLine = Number.parseFloat(String(lineKey).replace(",", "."));
      const isNestedLine = Number.isFinite(maybeLine);

      if (isNestedLine && lineValue && typeof lineValue === "object") {
        totalsLine = maybeLine;
        for (const [sideName, byBookmaker] of Object.entries(lineValue)) {
          if (typeof byBookmaker !== "object") continue;
          for (const [bookmaker, oddValue] of Object.entries(byBookmaker)) {
            const key = bookmaker.toLowerCase();
            if (!bookmakers[key]) bookmakers[key] = {};
            if (!bookmakers[key].totals) bookmakers[key].totals = {};
            if (/over/i.test(sideName)) bookmakers[key].totals.over = Number.parseFloat(oddValue);
            if (/under/i.test(sideName)) bookmakers[key].totals.under = Number.parseFloat(oddValue);
            totalsFound = true;
          }
        }
      }
    }
  }

  return {
    bookmakers,
    totalsLine,
    coverage: totalsFound ? 1 : moneyline ? 0.6 : 0,
  };
}

export function normalizeBookmakersFromTheOdds(event, fallbackTotalsLine) {
  const bookmakers = {};
  let totalsLine = fallbackTotalsLine;

  for (const bookmaker of event.bookmakers || []) {
    const target = {};

    for (const market of bookmaker.markets || []) {
      if (market.key === "h2h" && Array.isArray(market.outcomes) && market.outcomes.length >= 2) {
        target.winner = market.outcomes
          .slice(0, 2)
          .map((outcome) => Number.parseFloat(outcome.price));
      }

      if (market.key === "totals" && Array.isArray(market.outcomes)) {
        const over = market.outcomes.find((outcome) => /over/i.test(String(outcome.name)));
        const under = market.outcomes.find((outcome) => /under/i.test(String(outcome.name)));
        const point = over?.point ?? under?.point;

        if (Number.isFinite(Number(point))) {
          totalsLine = Number(point);
        }

        if (over || under) {
          target.totals = {
            over: over ? Number.parseFloat(over.price) : undefined,
            under: under ? Number.parseFloat(under.price) : undefined,
          };
        }
      }

      if (market.key === "spreads" && Array.isArray(market.outcomes) && market.outcomes.length >= 2) {
        const [firstOutcome, secondOutcome] = market.outcomes.slice(0, 2);
        target.spreads = {
          home: firstOutcome ? Number.parseFloat(firstOutcome.price) : undefined,
          away: secondOutcome ? Number.parseFloat(secondOutcome.price) : undefined,
          pointHome: firstOutcome?.point != null ? Number(firstOutcome.point) : undefined,
          pointAway: secondOutcome?.point != null ? Number(secondOutcome.point) : undefined,
        };
      }
    }

    if (target.winner || target.totals || target.spreads) {
      bookmakers[canonicalName(bookmaker.title)] = target;
    }
  }

  return {
    bookmakers,
    totalsLine,
    coverage: Object.keys(bookmakers).length ? 0.8 : 0,
  };
}

function parseOddsApiIoPrice(value) {
  const parsed = Number.parseFloat(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Línea principal en Odds-API.io (MLB/fútbol: `hdp`; tenis a veces `line`/`total`). */
function oddsApiIoMarketLine(row) {
  const hdp = Number(row?.hdp ?? row?.handicap);
  const alt = Number(row?.line ?? row?.total ?? row?.max);
  if (Number.isFinite(hdp)) return hdp;
  if (Number.isFinite(alt)) return alt;
  return NaN;
}

/** Total de partido (juego), sin props ni team totals ni mercados de innings. */
function isOddsApiIoGameTotalsMarket(name) {
  const n = String(name || "").toLowerCase().trim();
  if (!n || n.includes("team total")) return false;
  if (n.includes("inning") || n.includes("innings")) return false;
  if (n.includes("bases") || n.includes("hits") || n.includes("rbi")) return false;
  if (n.includes("player") || n.includes("label")) return false;
  return n === "totals" || n === "over/under" || n === "game totals" || n.includes("over/under");
}

export function normalizeBookmakersFromOddsApiIo(oddsPayload, fallbackTotalsLine = 8.5) {
  const bookmakers = {};
  let totalsLine = fallbackTotalsLine;
  let firstHalfLine = null;
  const source = oddsPayload?.bookmakers || {};

  for (const [bookmakerName, markets] of Object.entries(source)) {
    const target = {};
    const marketList = Array.isArray(markets) ? markets : [];

    for (const market of marketList) {
      const name = String(market?.name || "").toLowerCase();
      const row = Array.isArray(market?.odds) ? market.odds[0] : null;
      if (!row) continue;

      if (name === "ml" || name.includes("moneyline") || name.includes("match result") || name === "winner") {
        const home = parseOddsApiIoPrice(row.home);
        const away = parseOddsApiIoPrice(row.away);
        if (home != null && away != null) {
          target.winner = [home, away];
        }
      }

      if (name.includes("team total home") || name === "alt team total home") {
        const line = oddsApiIoMarketLine(row);
        const over = parseOddsApiIoPrice(row.over);
        const under = parseOddsApiIoPrice(row.under);
        if (over != null || under != null) {
          target.teamTotalHome = {
            line: Number.isFinite(line) ? line : undefined,
            over: over ?? undefined,
            under: under ?? undefined,
          };
        }
        continue;
      }

      if (name.includes("team total away") || name === "alt team total away") {
        const line = oddsApiIoMarketLine(row);
        const over = parseOddsApiIoPrice(row.over);
        const under = parseOddsApiIoPrice(row.under);
        if (over != null || under != null) {
          target.teamTotalAway = {
            line: Number.isFinite(line) ? line : undefined,
            over: over ?? undefined,
            under: under ?? undefined,
          };
        }
        continue;
      }

      if (
        name.includes("1st half") ||
        name.includes("first half") ||
        name.includes("half total") ||
        name.includes("1h total")
      ) {
        const line = oddsApiIoMarketLine(row);
        const over = parseOddsApiIoPrice(row.over);
        const under = parseOddsApiIoPrice(row.under);
        if (over != null || under != null) {
          target.firstHalfTotal = {
            line: Number.isFinite(line) ? line : undefined,
            over: over ?? undefined,
            under: under ?? undefined,
          };
          if (Number.isFinite(line)) firstHalfLine = line;
        }
        continue;
      }

      if (isOddsApiIoGameTotalsMarket(name)) {
        const line = oddsApiIoMarketLine(row);
        const over = parseOddsApiIoPrice(row.over);
        const under = parseOddsApiIoPrice(row.under);
        if (Number.isFinite(line)) {
          totalsLine = line;
        }
        if (over != null || under != null) {
          target.totals = {
            over: over ?? undefined,
            under: under ?? undefined,
            line: Number.isFinite(line) ? line : undefined,
          };
        }
      }

      if (name.includes("spread") || name.includes("handicap") || name.includes("run line")) {
        const hdp = Number(row.hdp ?? row.handicap);
        const home = parseOddsApiIoPrice(row.home);
        const away = parseOddsApiIoPrice(row.away);
        if (home != null && away != null) {
          target.spreads = {
            home,
            away,
            pointHome: Number.isFinite(hdp) ? hdp : undefined,
            pointAway: Number.isFinite(hdp) ? -hdp : undefined,
          };
        }
      }
    }

    if (target.winner || target.totals || target.spreads || target.teamTotalHome || target.teamTotalAway || target.firstHalfTotal) {
      bookmakers[canonicalName(bookmakerName)] = target;
    }
  }

  return {
    bookmakers,
    totalsLine,
    firstHalfLine,
    coverage: Object.keys(bookmakers).length ? 0.8 : 0,
  };
}
