import { clamp, round } from "../utils/math.js";

function factorial(n) {
  let result = 1;
  for (let i = 2; i <= n; i += 1) result *= i;
  return result;
}

export function poissonPmf(k, lambda) {
  if (k < 0 || !Number.isFinite(lambda) || lambda <= 0) return 0;
  if (lambda < 0.01) return k === 0 ? 1 : 0;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}

/** P(total runs > line) con Poisson independiente por equipo (hasta 20 carreras por lado). */
export function probTotalOver(homeLambda, awayLambda, line) {
  const h = clamp(homeLambda, 0.5, 12);
  const a = clamp(awayLambda, 0.5, 12);
  const threshold = Math.max(0, Math.floor(line));
  let underOrPush = 0;
  for (let home = 0; home <= 20; home += 1) {
    const pHome = poissonPmf(home, h);
    for (let away = 0; away <= 20; away += 1) {
      if (home + away <= threshold) {
        underOrPush += pHome * poissonPmf(away, a);
      }
    }
  }
  return clamp(1 - underOrPush, 0.02, 0.98);
}

export function probHomeWin(homeLambda, awayLambda) {
  const h = clamp(homeLambda, 0.5, 12);
  const a = clamp(awayLambda, 0.5, 12);
  let prob = 0;
  for (let home = 0; home <= 20; home += 1) {
    const pHome = poissonPmf(home, h);
    for (let away = 0; away <= 20; away += 1) {
      if (home > away) prob += pHome * poissonPmf(away, a);
    }
  }
  return clamp(prob, 0.05, 0.95);
}

export function probHomeCoverRunLine(homeLambda, awayLambda, spreadHome = -1.5) {
  const h = clamp(homeLambda, 0.5, 12);
  const a = clamp(awayLambda, 0.5, 12);
  let prob = 0;
  for (let home = 0; home <= 20; home += 1) {
    const pHome = poissonPmf(home, h);
    for (let away = 0; away <= 20; away += 1) {
      const margin = home - away;
      if (spreadHome < 0 && margin + spreadHome > 0) prob += pHome * poissonPmf(away, a);
      if (spreadHome > 0 && margin + spreadHome >= 0) prob += pHome * poissonPmf(away, a);
    }
  }
  return clamp(prob, 0.05, 0.95);
}

export function probTeamTotalOver(teamLambda, line) {
  const lambda = clamp(teamLambda, 0.5, 12);
  const threshold = Math.max(0, Math.floor(line));
  let underOrPush = 0;
  for (let runs = 0; runs <= 15; runs += 1) {
    if (runs <= threshold) underOrPush += poissonPmf(runs, lambda);
  }
  return clamp(1 - underOrPush, 0.05, 0.95);
}

/**
 * Monte Carlo: muestrea carreras con ruido alrededor de la media proyectada.
 */
export function monteCarloGameDistribution(homeMean, awayMean, options = {}) {
  const iterations = options.iterations || 4000;
  const variance = options.variance ?? 0.18;
  const line = Number.isFinite(options.line) ? options.line : 8.5;
  const spreadHome = Number.isFinite(options.spreadHome) ? options.spreadHome : -1.5;

  const hBase = clamp(homeMean, 1.5, 9);
  const aBase = clamp(awayMean, 1.5, 9);

  let homeWins = 0;
  let overs = 0;
  let homeCovers = 0;
  let totalRunsSum = 0;

  for (let i = 0; i < iterations; i += 1) {
    const hNoise = 1 + (Math.random() - 0.5) * variance * 2;
    const aNoise = 1 + (Math.random() - 0.5) * variance * 2;
    const home = poissonSample(hBase * hNoise);
    const away = poissonSample(aBase * aNoise);
    totalRunsSum += home + away;
    if (home > away) homeWins += 1;
    if (home + away > line) overs += 1;
    const margin = home - away;
    if (spreadHome < 0 && margin + spreadHome > 0) homeCovers += 1;
    if (spreadHome > 0 && margin + spreadHome >= 0) homeCovers += 1;
  }

  return {
    iterations,
    homeWinProb: round(homeWins / iterations, 4),
    overProb: round(overs / iterations, 4),
    underProb: round(1 - overs / iterations, 4),
    homeCoverProb: round(homeCovers / iterations, 4),
    expectedTotal: round(totalRunsSum / iterations, 2),
    poisson: {
      homeWinProb: probHomeWin(hBase, aBase),
      overProb: probTotalOver(hBase, aBase, line),
      underProb: round(1 - probTotalOver(hBase, aBase, line), 4),
      homeCoverProb: probHomeCoverRunLine(hBase, aBase, spreadHome),
    },
  };
}

function poissonSample(lambda) {
  const l = clamp(lambda, 0.1, 14);
  const limit = Math.exp(-l);
  let p = 1;
  let k = 0;
  do {
    k += 1;
    p *= Math.random();
  } while (p > limit);
  return k - 1;
}

export function evFromProbability(probability, decimalOdds) {
  if (!Number.isFinite(probability) || !Number.isFinite(decimalOdds) || decimalOdds <= 1) return null;
  return round(probability * decimalOdds - 1, 4);
}

export function removeVigTwoWay(probA, probB) {
  const sum = probA + probB;
  if (!Number.isFinite(sum) || sum <= 0) return { a: probA, b: probB };
  return { a: probA / sum, b: probB / sum };
}
