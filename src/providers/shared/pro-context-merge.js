function mergeForm(base = {}, patch = {}) {
  if (!patch || !Object.keys(patch).length) return base;
  return { ...base, ...patch, source: patch.source || base.source };
}

export function mergeProGameContext(espnCtx, apiSportsCtx) {
  if (!apiSportsCtx) return espnCtx;
  const source_log = { ...(espnCtx?.source_log || {}) };
  for (const [key, value] of Object.entries(apiSportsCtx.source_log || {})) {
    if (value && !source_log[key]) source_log[key] = "api-sports";
  }

  const home = {
    ...(espnCtx?.home || {}),
    teamId: espnCtx?.home?.teamId || apiSportsCtx?.home?.teamId,
    form: mergeForm(espnCtx?.home?.form, apiSportsCtx?.home?.form),
    qb_factor: espnCtx?.home?.qb_factor ?? apiSportsCtx?.home?.qb_factor,
  };
  const away = {
    ...(espnCtx?.away || {}),
    teamId: espnCtx?.away?.teamId || apiSportsCtx?.away?.teamId,
    form: mergeForm(espnCtx?.away?.form, apiSportsCtx?.away?.form),
    qb_factor: espnCtx?.away?.qb_factor ?? apiSportsCtx?.away?.qb_factor,
  };

  if (!espnCtx?.home?.form?.ptsPerGame && apiSportsCtx?.home?.form?.ptsPerGame) {
    source_log.home_form = "api-sports";
  }
  if (!espnCtx?.away?.form?.ptsPerGame && apiSportsCtx?.away?.form?.ptsPerGame) {
    source_log.away_form = "api-sports";
  }

  const flags = {
    ...(espnCtx?.flags || {}),
    stats_espn_disponibles: Boolean(
      espnCtx?.flags?.stats_espn_disponibles || apiSportsCtx?.flags?.stats_espn_disponibles
    ),
    h2h_relevante: Boolean(espnCtx?.flags?.h2h_relevante || apiSportsCtx?.flags?.h2h_relevante),
    lesiones_confirmadas: Boolean(
      espnCtx?.flags?.lesiones_confirmadas || apiSportsCtx?.flags?.lesiones_confirmadas
    ),
    alineacion_confirmada: Boolean(
      espnCtx?.flags?.alineacion_confirmada || apiSportsCtx?.flags?.alineacion_confirmada
    ),
    clima_disponible: Boolean(espnCtx?.flags?.clima_disponible || apiSportsCtx?.flags?.clima_disponible),
  };

  return {
    ...espnCtx,
    source_log,
    home,
    away,
    h2h: espnCtx?.h2h || apiSportsCtx?.h2h || null,
    h2h_1h: espnCtx?.h2h_1h || apiSportsCtx?.h2h_1h,
    clima_factor: espnCtx?.clima_factor ?? apiSportsCtx?.clima_factor ?? 1,
    flags,
  };
}
