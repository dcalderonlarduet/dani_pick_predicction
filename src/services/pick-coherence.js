function pickScore(pick) {
  const score = Number(pick?.score_final ?? pick?.score ?? pick?.confidence ?? 0);
  return Number.isFinite(score) ? score : 0;
}

function normalizeSide(side) {
  const value = String(side || "").toLowerCase();
  if (value === "over" || value === "under") return value;
  return null;
}

function isTeamTotalMarket(market) {
  return market === "team_total_home" || market === "team_total_away";
}

function findLowerScoredPick(left, right) {
  return pickScore(left) >= pickScore(right) ? right : left;
}

function isGameTotalTeamTotalContradiction(gamePick, teamPick) {
  if (gamePick?.market !== "game_total" || !isTeamTotalMarket(teamPick?.market)) return false;

  const gameSide = normalizeSide(gamePick.side);
  const teamSide = normalizeSide(teamPick.side);
  if (!gameSide || !teamSide) return false;

  return gameSide !== teamSide;
}

export function resolvePickCoherence(picks, ctx = {}) {
  if (!Array.isArray(picks) || picks.length < 2) {
    return { coherent: picks ?? [], removed: [] };
  }

  const gameTotals = picks.filter((pick) => pick?.market === "game_total");
  const teamTotals = picks.filter((pick) => isTeamTotalMarket(pick?.market));
  const removedSet = new Set();
  const removedReasons = new Map();

  for (const gamePick of gameTotals) {
    for (const teamPick of teamTotals) {
      if (!isGameTotalTeamTotalContradiction(gamePick, teamPick, ctx)) continue;

      const loser = findLowerScoredPick(gamePick, teamPick);
      removedSet.add(loser);
      removedReasons.set(loser, {
        reason: "game_total_team_total_direction_conflict",
        kept: loser === gamePick ? teamPick : gamePick,
        conflictWith: loser === gamePick ? teamPick : gamePick,
      });
    }
  }

  const coherent = picks.filter((pick) => !removedSet.has(pick));
  const removed = picks
    .filter((pick) => removedSet.has(pick))
    .map((pick) => ({
      ...pick,
      coherence: removedReasons.get(pick) || null,
    }));

  return { coherent, removed };
}

export function buildCoherenceCtx(ctx, homeProjectedPts, awayProjectedPts) {
  return {
    ...ctx,
    homeProjectedPts: Number.isFinite(homeProjectedPts) ? homeProjectedPts : null,
    awayProjectedPts: Number.isFinite(awayProjectedPts) ? awayProjectedPts : null,
    home: {
      ...ctx?.home,
      projectedPts: Number.isFinite(homeProjectedPts) ? homeProjectedPts : ctx?.home?.projectedPts,
    },
    away: {
      ...ctx?.away,
      projectedPts: Number.isFinite(awayProjectedPts) ? awayProjectedPts : ctx?.away?.projectedPts,
    },
  };
}
