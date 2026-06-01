import { round } from "../utils/math.js";
import { getRuntimeConfig } from "../config/runtime.js";

const _pcfg = getRuntimeConfig().parlay;
const EV_THRESHOLD = _pcfg.evThreshold;
const PARLAY_MIN_ODDS = _pcfg.minOdds;
const PARLAY_MAX_ODDS = _pcfg.maxOdds;

function pickConfidence(pick) {
  return pick.confianza ?? pick.confidence ?? pick.modelConfidence ?? 0;
}

function pickOdds(pick) {
  return pick.mejor_cuota ?? pick.bestOdds ?? pick.odds ?? null;
}

function pickEv(pick) {
  return Number.isFinite(pick.ev) ? pick.ev : null;
}

export function buildValueParlays(allGreenPicks) {
  const parlays = [];
  const pool = allGreenPicks.filter((pick) => pickEv(pick) != null && pickEv(pick) >= EV_THRESHOLD && pickOdds(pick));

  for (let index = 0; index < pool.length; index += 1) {
    for (let inner = index + 1; inner < pool.length; inner += 1) {
      const first = pool[index];
      const second = pool[inner];

      const sameMatch = String(first.matchId || first.eventId) === String(second.matchId || second.eventId);
      const sameTournamentRound =
        first.sport === second.sport &&
        first.tournament === second.tournament &&
        first.round === second.round;
      if (sameMatch || sameTournamentRound) continue;

      const firstOdds = pickOdds(first);
      const secondOdds = pickOdds(second);
      const combinedOdds = round(firstOdds * secondOdds, 2);
      if (combinedOdds < PARLAY_MIN_ODDS || combinedOdds > PARLAY_MAX_ODDS) continue;

      const combinedProb = (pickConfidence(first) / 100) * (pickConfidence(second) / 100);
      const impliedProb = 1 / combinedOdds;
      const combinedEV = (combinedProb - impliedProb) / impliedProb;

      if (combinedEV < EV_THRESHOLD || pickEv(first) < EV_THRESHOLD || pickEv(second) < EV_THRESHOLD) {
        continue;
      }

      parlays.push({
        id: `value-parlay-${first.matchId || first.eventId}-${second.matchId || second.eventId}`,
        legs: [first, second],
        selections: [first, second],
        combinedOdds: combinedOdds.toFixed(2),
        totalOdds: combinedOdds,
        combinedEV: round(combinedEV, 3),
        combinedEVPercent: (combinedEV * 100).toFixed(1),
        combinedConfidence: (combinedProb * 100).toFixed(1),
        comboScore: round(Math.min(pickConfidence(first), pickConfidence(second)), 1),
        sports: [first.sport || "unknown", second.sport || "unknown"],
        isCrossSport: (first.sport || "") !== (second.sport || ""),
        label:
          (first.sport || "") !== (second.sport || "")
            ? "Combinada multi-deporte"
            : "Combinada mismo deporte",
        valueBook: "Winamax FR",
        rationale: `Combinada ${combinedOdds.toFixed(2)} con EV combinado +${(combinedEV * 100).toFixed(1)}%.`,
      });
    }
  }

  return parlays.sort((left, right) => right.combinedEV - left.combinedEV).slice(0, 3);
}
