import { canonicalName } from "../providers/shared/tennis-normalizers.js";

/** Odds-API nombre corto → nombre canónico ESPN (equipos WNBA 2026). */
export const WNBA_TEAM_ALIASES = {
  "la sparks": "los angeles sparks",
  "golden state": "golden state valkyries",
  "toronto": "toronto tempo",
  "portland": "portland fire",
  "connecticut": "connecticut sun",
  "las vegas": "las vegas aces",
  "new york": "new york liberty",
  "indiana": "indiana fever",
  "chicago": "chicago sky",
  "minnesota": "minnesota lynx",
  "seattle": "seattle storm",
  "phoenix": "phoenix mercury",
  "atlanta": "atlanta dream",
  "washington": "washington mystics",
  "dallas": "dallas wings",
  "golden state valkyries": "golden state valkyries",
  "toronto tempo": "toronto tempo",
  "portland fire": "portland fire",
  "los angeles sparks": "los angeles sparks",
  "connecticut sun": "connecticut sun",
  "las vegas aces": "las vegas aces",
  "new york liberty": "new york liberty",
  "indiana fever": "indiana fever",
  "chicago sky": "chicago sky",
  "minnesota lynx": "minnesota lynx",
  "seattle storm": "seattle storm",
  "phoenix mercury": "phoenix mercury",
  "atlanta dream": "atlanta dream",
  "washington mystics": "washington mystics",
  "dallas wings": "dallas wings",
};

export function normalizeWnbaTeamName(name) {
  const canonical = canonicalName(name);
  return WNBA_TEAM_ALIASES[canonical] || canonical;
}

export function wnbaTeamNamesMatch(leftName, rightName) {
  const left = normalizeWnbaTeamName(leftName);
  const right = normalizeWnbaTeamName(rightName);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}
