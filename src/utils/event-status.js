function normalizeStatus(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}


export function isMlbGameAlreadyPlayed(gameOrRaw) {
  if (!gameOrRaw) return true;

  const abstract = normalizeStatus(
    gameOrRaw?.status?.abstractGameState ?? gameOrRaw?.abstractGameState
  );
  if (abstract === "final") return true;

  const coded = String(gameOrRaw?.status?.codedGameState ?? gameOrRaw?.codedGameState ?? "")
    .trim()
    .toUpperCase();
  if (coded === "F" || coded === "O") return true;

  const detailed = normalizeStatus(gameOrRaw?.status?.detailedState ?? gameOrRaw?.status);
  if (
    /^final$|^game over$|^completed$|^postponed$|^cancelled$|^canceled$/.test(detailed) ||
    (detailed.includes("final") &&
      !/scheduled|pre-game|preview|warmup|in progress|live|delayed start/.test(detailed))
  ) {
    return true;
  }

  return false;
}

export function isMlbGameUpcoming(gameOrRaw) {
  return !isMlbGameAlreadyPlayed(gameOrRaw);
}

export function isMlbGameLive(gameOrRaw) {
  if (!gameOrRaw || isMlbGameAlreadyPlayed(gameOrRaw)) return false;

  const abstract = normalizeStatus(gameOrRaw?.status?.abstractGameState ?? gameOrRaw?.abstractGameState);
  const coded = String(gameOrRaw?.status?.codedGameState ?? gameOrRaw?.codedGameState ?? "")
    .trim()
    .toUpperCase();
  const detailed = normalizeStatus(gameOrRaw?.status?.detailedState ?? gameOrRaw?.status);

  if (abstract === "live" || coded === "I") return true;
  return /in progress|\blive\b|top \d|bottom \d|middle of|mid-inning|delayed start/.test(detailed);
}


export function isFutbolMatchLive(match) {
  if (!match || isFutbolMatchAlreadyPlayed(match)) return false;

  const status = normalizeStatus(match?.status ?? match?.state ?? match?.fixture?.status);
  return (
    status === "live" ||
    /in play|1st half|2nd half|halftime|half time|extra time|penalt|kick off/.test(status)
  );
}

export function isFutbolMatchAlreadyPlayed(match) {
  if (!match) return true;

  const status = normalizeStatus(match?.status ?? match?.state ?? match?.fixture?.status);
  if (!status) return false;
  if (/finished|completed|final|settled|ended|closed|full.?time|ft\b|postpon|cancel/.test(status)) {
    return true;
  }
  return status === "post" || status === "played";
}

export function isFutbolMatchUpcoming(match) {
  return !isFutbolMatchAlreadyPlayed(match);
}

export function isProGameAlreadyPlayed(gameOrRaw) {
  if (!gameOrRaw) return true;
  const status = normalizeStatus(gameOrRaw?.status ?? gameOrRaw?.status?.type?.name);
  if (!status) return false;
  if (/final|completed|game over|full.?time|postpon|cancel|ended/.test(status)) return true;
  return status === "post" || status === "final";
}

export function isProGameUpcoming(gameOrRaw) {
  return !isProGameAlreadyPlayed(gameOrRaw);
}

export function isProGameLive(gameOrRaw) {
  if (!gameOrRaw || isProGameAlreadyPlayed(gameOrRaw)) return false;
  const status = normalizeStatus(gameOrRaw?.status ?? gameOrRaw?.status?.type?.name);
  return /in progress|\blive\b|halftime|half time|q[1-4]|1st|2nd|3rd|4th/.test(status);
}
