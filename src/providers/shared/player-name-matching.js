import { PLAYER_ALIASES } from "../../data/player-aliases.js";
import { canonicalName } from "./tennis-normalizers.js";

const MATCH_THRESHOLD = 68;
const MAX_EDIT_DISTANCE = 2;

function resolveAlias(value) {
  const canonical = canonicalName(value);
  return PLAYER_ALIASES[canonical] || canonical;
}

function normalizePlayerSide(name) {
  return resolveAlias(name)
    .replace(/\b[a-z]\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshteinDistance(left, right, maxDistance = MAX_EDIT_DISTANCE) {
  if (left === right) return 0;
  if (!left || !right) return maxDistance + 1;
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array(right.length + 1).fill(0);

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    let rowMin = current[0];

    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
      rowMin = Math.min(rowMin, current[j]);
    }

    if (rowMin > maxDistance) return maxDistance + 1;

    for (let j = 0; j <= right.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[right.length];
}

export function splitDoublesName(name) {
  const raw = String(name || "").trim();
  if (!raw.includes("/")) return [raw];
  return raw
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function expandPlayerKeys(name) {
  const raw = String(name || "").trim();
  const canonical = normalizePlayerSide(raw);
  if (!canonical) return [];

  const keys = new Set([canonical]);
  const commaParts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (commaParts.length === 2) {
    const inverted = normalizePlayerSide(`${commaParts[1]} ${commaParts[0]}`);
    if (inverted) {
      keys.add(inverted);
      keys.add(canonicalName(inverted));
    }
  }

  for (const side of splitDoublesName(name)) {
    const sideCanonical = normalizePlayerSide(side);
    if (!sideCanonical) continue;
    keys.add(sideCanonical);

    const parts = sideCanonical.split(" ").filter((part) => part.length > 1);
    const last = parts[parts.length - 1];
    const first = parts[0];
    if (last) keys.add(last);
    if (first && first !== last) keys.add(first);
    if (parts.length >= 2) {
      keys.add(`${first} ${last}`);
      keys.add(`${last} ${first}`);
      keys.add(`${first[0]} ${last}`);
      keys.add(`${last} ${first[0]}`);
    }
  }

  return [...keys].filter(Boolean);
}

function tokenOverlapScore(leftKeys, rightKeys) {
  const left = new Set(leftKeys);
  const right = new Set(rightKeys);
  let overlap = 0;
  for (const key of left) {
    if (right.has(key)) overlap += 1;
  }
  if (!overlap) return 0;
  return Math.round((overlap / Math.max(left.size, right.size)) * 55);
}

function editDistanceScore(leftKeys, rightKeys) {
  let best = 0;

  for (const leftKey of leftKeys) {
    if (!leftKey || leftKey.length < 4) continue;

    for (const rightKey of rightKeys) {
      if (!rightKey || rightKey.length < 4) continue;
      const distance = levenshteinDistance(leftKey, rightKey);
      if (distance === 0) return 96;
      if (distance === 1) best = Math.max(best, 90);
      if (distance === 2) best = Math.max(best, 82);
    }
  }

  return best;
}

function singlePlayerScore(nameA, nameB) {
  const keysA = expandPlayerKeys(nameA);
  const keysB = expandPlayerKeys(nameB);
  if (!keysA.length || !keysB.length) return 0;

  const canonA = keysA[0];
  const canonB = keysB[0];
  if (canonA === canonB) return 100;

  const lastA = keysA.find((key) => key.split(" ").length === 1) || canonA.split(" ").pop();
  const lastB = keysB.find((key) => key.split(" ").length === 1) || canonB.split(" ").pop();
  if (lastA && lastB && lastA === lastB) {
    const firstA = canonA.split(" ")[0];
    const firstB = canonB.split(" ")[0];
    if (firstA && firstB && (firstA.startsWith(firstB[0]) || firstB.startsWith(firstA[0]))) {
      return 88;
    }
    return 78;
  }

  return Math.max(tokenOverlapScore(keysA, keysB), editDistanceScore(keysA, keysB));
}

function doublesSideScore(slateSide, oddsSide) {
  const slatePlayers = splitDoublesName(slateSide);
  const oddsPlayers = splitDoublesName(oddsSide);

  if (slatePlayers.length > 1 || oddsPlayers.length > 1) {
    let best = 0;
    for (const slatePlayer of slatePlayers) {
      for (const oddsPlayer of oddsPlayers) {
        best = Math.max(best, singlePlayerScore(slatePlayer, oddsPlayer));
      }
    }
    return best;
  }

  return singlePlayerScore(slateSide, oddsSide);
}

export function pairMatchScore(slateA, slateB, oddsHome, oddsAway) {
  const direct =
    doublesSideScore(slateA, oddsHome) + doublesSideScore(slateB, oddsAway);
  const reversed =
    doublesSideScore(slateA, oddsAway) + doublesSideScore(slateB, oddsHome);

  const best = Math.max(direct, reversed);
  return Math.round(best / 2);
}

export function createFlexibleMatchKeys(nameA, nameB) {
  const keys = new Set();
  const sidesA = expandPlayerKeys(nameA);
  const sidesB = expandPlayerKeys(nameB);

  for (const a of sidesA) {
    for (const b of sidesB) {
      keys.add([a, b].sort().join("::"));
    }
  }

  keys.add([canonicalName(nameA), canonicalName(nameB)].sort().join("::"));
  return [...keys];
}

export function indexOddsEvent(map, odds) {
  const home = odds?.home || "";
  const away = odds?.away || "";
  const keys = createFlexibleMatchKeys(home, away);
  const payload = { odds, score: 100 };

  for (const key of keys) {
    if (!map.has(key) || (map.get(key)?.score || 0) < payload.score) {
      map.set(key, payload);
    }
  }
}

export function findOddsForParticipants(oddsMap, nameA, nameB) {
  const keys = createFlexibleMatchKeys(nameA, nameB);
  let best = null;

  for (const key of keys) {
    const entry = oddsMap.get(key);
    if (!entry) continue;
    if (!best || entry.score > best.score) {
      best = entry;
    }
  }

  return best?.odds || null;
}

export function findBestOddsAmongEvents(events, nameA, nameB, hints = {}) {
  let best = null;

  for (const event of events) {
    const score = pairMatchScore(nameA, nameB, event.home, event.away);
    if (score < MATCH_THRESHOLD) continue;

    let adjusted = score;
    const eventTournament = canonicalName(
      event?.league?.name || event?.tournament || event?.competition || ""
    );
    const slateTournament = canonicalName(hints.tournament || "");
    if (eventTournament && slateTournament) {
      if (eventTournament === slateTournament) adjusted += 8;
      else if (eventTournament.includes(slateTournament) || slateTournament.includes(eventTournament)) {
        adjusted += 4;
      }
    }

    if (!best || adjusted > best.score) {
      best = { event, score: adjusted };
    }
  }

  return best;
}

export const PLAYER_MATCH_THRESHOLD = MATCH_THRESHOLD;
