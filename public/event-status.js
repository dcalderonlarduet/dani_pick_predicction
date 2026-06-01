// Browser-adapted copy of src/utils/event-status.js (keep live/upcoming patterns in sync).
function normalizeStatus(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function isTennisMatchUpcoming(match) {
  if (!match) return false;
  const status = normalizeStatus(
    match?.status ?? match?.liveState?.status ?? match?.providerContext?.oddsApiIoEvent?.status
  );
  if (
    /cancel|postpon|abandon|void|suspended|settled|finished|ended|closed|completed|final|retired|walkover|post\b/.test(
      status
    )
  ) {
    return false;
  }
  return !status || /pending|live|scheduled|progress|pre/.test(status);
}

export function isTennisMatchLive(match) {
  if (!match) return false;
  const status = normalizeStatus(
    match?.status ?? match?.liveState?.status ?? match?.providerContext?.oddsApiIoEvent?.status
  );
  if (
    /cancel|postpon|abandon|void|suspended|settled|finished|ended|closed|completed|final|retired|walkover|post\b/.test(
      status
    )
  ) {
    return false;
  }
  return status === "live" || /in progress|set \d|playing|1st set|2nd set|3rd set/.test(status);
}

export function isMlbGameUpcoming(game) {
  if (!game) return false;
  const status = normalizeStatus(game?.status);
  if (/^final$|game over|completed|postponed|cancelled|canceled/.test(status)) return false;
  if (status.includes("final") && !/scheduled|pre-game|preview|in progress|live/.test(status)) return false;
  return true;
}

export function isMlbGameLive(game) {
  if (!game || !isMlbGameUpcoming(game)) return false;
  const status = normalizeStatus(game?.status);
  return status === "live" || /in progress|\blive\b|top \d|bottom \d|middle of|mid-inning/.test(status);
}

export function isFutbolMatchUpcoming(match) {
  if (!match) return false;
  const status = normalizeStatus(match?.status ?? match?.state);
  if (!status) return true;
  return !/finished|completed|final|settled|ended|closed|full.?time|\bft\b|postpon|cancel|post\b|played/.test(status);
}

export function isFutbolMatchLive(match) {
  if (!match) return false;
  const status = normalizeStatus(match?.status ?? match?.state);
  if (
    /finished|completed|final|settled|ended|closed|full.?time|\bft\b|postpon|cancel|post\b|played/.test(status)
  ) {
    return false;
  }
  return status === "live" || /in play|1st half|2nd half|halftime|half time|extra time|penalt/.test(status);
}

export function filterUpcomingMatches(matches, sport) {
  const list = Array.isArray(matches) ? matches : [];
  if (sport === "mlb") return list.filter(isMlbGameUpcoming);
  if (sport === "futbol") return list.filter(isFutbolMatchUpcoming);
  return list.filter(isTennisMatchUpcoming);
}
