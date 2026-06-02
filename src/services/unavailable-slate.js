import { canonicalName } from "../providers/shared/tennis-normalizers.js";

export function applySurfaceOverrides(slate, overrides) {
  if (!overrides || typeof overrides !== "object" || !slate?.matches) return slate;

  for (const match of slate.matches) {
    const override =
      overrides[String(match.sourceIds?.apiTennisTournamentKey || "")] ||
      overrides[canonicalName(match.tournament)];

    if (override) {
      match.surface = override;
    }
  }

  return slate;
}

export function createUnavailableSlate(date, config, reason, providerManifest) {
  return {
    date,
    generatedAt: new Date().toISOString(),
    dataAvailable: false,
    unavailableReason: reason,
    matches: [],
    coverage: {
      schedule: 0,
      odds: 0,
      medical: 0,
      overall: 0,
    },
    stalenessMinutes: 999,
    providerManifest: providerManifest || { generatedAt: new Date().toISOString(), providers: [] },
    runtime: {
      dataProvider: config.oddsProvider || "none",
      oddsProvider: config.oddsProvider,
      maxMatches: config.maxMatches || null,
      recentWindowDays: config.recentWindowDays || null,
      unavailableReason: reason,
    },
  };
}

