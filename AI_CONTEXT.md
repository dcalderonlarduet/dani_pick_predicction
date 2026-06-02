# AI Context: Sports Oracle (DANY PICKS)

Documento de handoff para continuar el proyecto sin depender del historial del chat.

## Resumen

- Proyecto: `DANY PICKS` (workspace multi-deporte: **Sports Oracle**)
- Ruta: `D:\Daniel\APLICACIONES VARIAS`
- Fecha de corte: `2026-06-01` (preparacion GitHub + proteccion de secretos/estado local)
- Objetivo: app web para pronosticos deportivos con **valor real y explicito** (MLB + futbol + NBA + WNBA + NFL + Quiniela)
- Estado: Docker en `:3000`, datos reales sin mock, fecha operativa en **Europe/Madrid**
- Casas de apuestas activas: **Bet365** (sharp, mueve lineas antes) + **Winamax FR** (referencia retail)
- Fuente principal de EV: modelo propio + cuotas reales; Odds-API.io aporta `/value-bets`, `/dropping-odds`, `/odds/multi` y eventos segun deporte

---

## 2026-06-01 - Preparacion para GitHub

- Repo destino: `https://github.com/dcalderonlarduet/dani_pick_predicction.git`.
- Se inicializa Git desde cero en la carpeta del proyecto.
- `.gitignore` queda como allowlist de codigo fuente y config segura:
  - Incluye `server.js`, `public/`, `src/`, `scripts/` utiles, SQL, Docker, package files, `.env.example`, `README.md` y `AI_CONTEXT.md`.
  - Excluye `.env`, `.env.*`, `node_modules/`, estados runtime, logs, ZIPs, imagenes generadas, binarios locales y `scripts/cloudflared/`.
  - Excluye snapshots locales mutables: `src/data/picks-history.json`, `src/data/quiniela-state.json`, `src/data/community/public-splits.snapshot.json`.
  - Excluye scripts temporales de parche: `scripts/_*`, `scripts/patch-*.js`, `scripts/fix-*.js`.
- `README.md` actualizado para describir el proyecto actual como DANY PICKS multi-deporte, no como el nombre legacy anterior.
- 2026-06-02: nombre operativo Docker/package actualizado a `danny-pick`.
- Politica: no pegar tokens de GitHub ni claves de providers en el chat; usar autenticacion local de Git/GitHub.

---

## 2026-05-31 - Quiniela: pronostico congelado + resultados vivos

- Objetivo implementado: una jornada de Quiniela se trata como ciclo de vida, no como analisis libre infinito.
  - Mientras esta abierta: se puede recalcular el pronostico y refrescar composicion.
  - Al cerrar plazo: se bloquea el refresh del pronostico; solo se actualizan resultados.
  - Al completarse resultados y abrir otra jornada: el scheduler puede cargar la nueva composicion.
- Persistencia:
  - Nuevo `src/services/quiniela-state-store.js`.
  - Guarda snapshots en `src/data/quiniela-state.json` (bind mount Docker `./src/data:/app/src/data`).
  - Usa temporales unicos para evitar carreras de `rename()` cuando API/prewarm/scheduler guardan a la vez.
- Cache/requests:
  - `src/services/quiniela-request-cache.js` ahora bloquea `refresh=1` si la jornada esta cerrada y no completa.
  - Si hay snapshot cerrado en disco, sirve `locked-disk` sin reconstruir pronostico.
  - Superpone resultados solo cuando la jornada esta cerrada.
  - Resultados oficiales usan `src/services/quiniela-results-updater.js` con cache `quiniela-results` TTL 12 min / stale 48 h.
- Resultados:
  - `mergeQuinielaResultados()` anota `resultadoReal`, `marcador`, `acierto`, `estadoResultado` en `propuestaOficial`, `propuestaMinima`, `picks` y `partidos`.
  - `evaluateQuinielaPronostico()` ya evalua dobles tipo `1X` como signos separados y cuenta fallos por filas resueltas (no por diferencia ciega contra 14).
  - `server.js` tiene polling ligero cada 15 min, pero omite requests si la jornada sigue abierta o ya esta completa.
- Parser oficial/fallback:
  - `quiniela-analyzer.js` lee fecha/hora de tablas `| orden | local - visitante | dd/mm/yyyy | hh:mm |`.
  - Si SELAE/fuente no publica deadline claro, infiere `closingTime` como primer kickoff menos 15 min.
  - Los bloques completados aceptan resultados parciales (`rows.length > 0`), no esperan siempre 14.
- UI:
  - Quiniela siempre queda seleccionable aunque una sesion vieja la hubiera cacheado como pendiente.
  - Muestra estado `EN VENTA`/`CERRADA`, `Stats X/14`, `Resultados X/14`, aciertos/fallos/pendientes y badge por resultado cuando existan.
  - Los fijos forzados sin base estadistica se explican como `Fijo de coste`, no como favorito falso.
- Auditoria actual post-deploy:
  - `GET /api/quiniela/analyze` devuelve J66, 14 propuestas, `closingTime=2026-06-06T12:45:00.000Z`.
  - `statValueRows=0`, `lowDataRows=14`: la jornada actual no tiene edge estadistico suficiente; es cobertura de boleto, no valor cuantitativo.
  - UI verificada en navegador: `BOLETO OFICIAL - JORNADA 66`, `EN VENTA`, `Stats 0/14`, `Resultados 0/14`, 10 fijos y 4 dobles.

---

## 2026-05-31 - Ajustes finales del sistema de picks

- MLB `src/services/mlb-analyzer.js`:
  - `projectTeamRuns()` aplica `elitePitcherMultiplier()` al rival cuando el abridor contrario tiene metrica efectiva dominante:
    - <=2.00: 0.72
    - <=2.50: 0.78
    - <=3.00: 0.85
    - <=3.50: 0.92
  - Los totals aplican `applyPushRiskAdjustment()` cuando la proyeccion esta cerca de la linea:
    - diff <0.5: EV * 0.65
    - diff <1.0: EV * 0.80
    - diff <1.5: EV * 0.92
  - El ajuste entra tanto en `buildTotalRecommendation()` como en `enrichRecommendation()`, porque el EV final se recalcula al enriquecer cuotas.
- Confianza minima por deporte:
  - `src/services/pick-calibration.js` ahora expone `getMinRecommendationConfidence()` con WNBA 48, MLB 50, NBA 55, NFL 52, Futbol/Football 55.
  - `src/services/sport-bettable-thresholds.js` pasa esos suelos a los value gates por deporte.
  - `src/services/mlb-odds-policy.js` usa el suelo MLB 50 tambien en `passesMlbValueMode()`.
- WNBA `src/services/wnba-odds-policy.js`:
  - Recommendations ya devuelven `ev`, `bookmaker` y `selection`.
  - Si hay cuota pero no bookmaker explicito, se marca `bookmaker: "mercado"`.
  - ML sale como `(ML) Equipo a ganar`; totals como `(+) Mas de X puntos` / `(-) Menos de X puntos`.
- UI `public/index.html`:
  - TOP PICK sube a score 62 y edge 4%.
  - MEJOR PICK exige edge fuerte (8%) o confianza minima por deporte; ya no basta score alto con edge bajo.
  - Se filtran picks con falsa seguridad: confianza >=85% y edge <8%.
  - Se filtran cuotas sin valor real: cuota <1.45.
  - MEJOR PICK muestra badge `Edge X%`.
  - `collectPicks()` usa `data.picks` como shortlist canonico para MLB/NBA/WNBA/NFL y Futbol; `modelPicks` solo queda como fallback legacy si `data.picks` no existe/no trae entradas.
  - Las listas principales ya no promocionan lecturas internas de `games[].recommendations` ni `partidos[].picks` como picks recomendados.
- Futbol `src/services/football-analyzer.js`:
  - `FOOTBALL_VALUE_CONF_MIN` queda limitado por `getMinRecommendationConfidence("football")`; el suelo real actual de recomendacion es 52.
  - `adaptPickForUi()` no marca `readyToBet/bettable/safeForCombo` si la confianza no supera el minimo deportivo.
- UI `public/styles.css`:
  - Nuevas clases `.best-pick-edge.edge--alto|medio|bajo`.
- Despliegue:
  - Docker Compose reconstruido y contenedor `danny-pick` recreado tras los cambios de backend.
  - Confirmado dentro del contenedor: `elitePitcherMultiplier`, `applyPushRiskAdjustment`, `MIN_CONF_POR_DEPORTE`, `resolveWnbaBookmaker` y `FOOTBALL_RECOMMENDATION_CONF_MIN`.
- Auditoria actual de picks tras deploy:
  - MLB API entrega 6 picks canonicos; UI principal muestra 4 picks con valor despues de filtrar conflicto confianza/edge y shortlist estricto.
  - WNBA tiene 1 partido y 0 picks recomendados: Aces ML queda fuera por `edge_bajo` (~3.6 pp vs minimo 4 pp).
  - Futbol tiene 0 picks recomendados: el pick amarillo de tarjetas con confianza 48 queda fuera por minimo 55.
  - NBA/NFL sin partidos/picks en ventana actual.

---

## 2026-05-31 - Auditoria adicional WNBA/MLB + rate limit UI

- WNBA:
  - `src/providers/espn-wnba.js` ahora consulta schedule ESPN por equipo y extrae marcadores reales por venue.
  - `form.ptsPerGameHome` / `form.ptsPerGameAway` se rellenan desde resultados recientes antes del partido.
  - `src/services/wnba-projection.js` usa ese split real en `projectWnbaTeamTotal()` y anota `real_home_away_scoring_base`.
  - `src/services/wnba-odds-policy.js` deduplica team totals por mercado para no mostrar over/under contradictorios del mismo equipo.
  - Auditoria actual de ESPN: Golden State `ptsPerGameHome=74.2`, `ptsPerGameAway=72`; Las Vegas `ptsPerGameHome=90`, `ptsPerGameAway=87.4`. Si aparece Under GSV, ya no viene del fallback 83 sino del split real actual.
- MLB:
  - `src/services/mlb-odds-policy.js` marca como no bettable picks con falsa seguridad: confianza >=85 y edge <8 pp (`confianza_alta_edge_bajo`).
  - `src/services/mlb-analyzer.js` no promociona a `picks` canonicos cuotas <1.45 ni conflictos confianza/edge.
  - `public/index.html` usa `pickIsValueCandidate()` tambien para tonos/labels del desk: una lectura sin valor no puede mostrar `CON VALOR` ni `CON VALOR - TOP`.
  - Caso auditado: `Los Angeles Dodgers -1.5` ya no aparece como pick recomendado ni como TOP con valor.
- Rate limit:
  - Odds-API.io esta temporalmente en 429 (`100 requests/hour`); mientras dure, MLB/WNBA/NBA/NFL/Futbol pueden mostrar 0 picks si no hay snapshot con cuotas.
  - La UI muestra el retry para modulos de cuotas, pero Quiniela queda aislada del badge `RL`: sigue mostrando Jornada 66, `EN VENTA`, `Stats 0/14`, `Resultados 0/14`.
- Despliegue/verificacion:
  - Docker Compose reconstruido y `danny-pick` recreado.
  - Checks: `node --check` MLB/WNBA policies/providers e inline scripts de `public/index.html`.
  - Browser: `Dodgers -1.5` no aparece; `CON VALOR - TOP` no aparece; Quiniela no muestra rate limit propio.

---

## 2026-05-31 - Fix picks no visibles por cache stale/fecha Madrid

- Causa detectada:
  - Backend tenia picks MLB validos, pero `server.js` servia cache `stale` sin reconstruir aunque Odds-API.io ya no estaba en rate-limit.
  - El navegador conservaba un snapshot viejo en `sessionStorage` con `0 picks`.
  - El filtro frontend comparaba `startIso` contra fecha Madrid estricta; picks MLB del slate USA del 31/05 que empiezan `23:20Z` caen ya en madrugada Madrid y se descartaban de TOP PICKS.
- Cambios:
  - `server.js`: `loadAnalysisWithTelegram()` solo sirve stale sin reconstruir cuando el cache esta fresco o cuando `getOddsApiRateLimitState()` sigue activo. Si no, reconstruye.
  - `public/index.html`: `CLIENT_MODULE_CACHE_KEY` sube a `dany-picks-module-cache-v2` para invalidar sesiones con snapshots malos.
  - `public/index.html`: `collectPicks()` no aplica filtro estricto por fecha Madrid a MLB/Futbol/NBA/WNBA/NFL porque esos modulos ya vienen filtrados por ventana del backend.
- Verificacion post-deploy:
  - MLB API: `coverage.odds=0.93`, `readyRecommendations=3`, picks: Yankees ML, Cubs/ Cardinals Over 8.5, Cubs ML.
  - Browser: boton MLB muestra `3 PICKS`, TOP PICKS ya no dice `Sin picks hoy`.
  - WNBA sigue en `0 picks` porque solo hay Winamax FR en cuotas actuales y no pasa value gates; no es fallo de UI.

---

## 2026-05-31 - Recalibracion post-auditoria por deporte

- Esta seccion reemplaza la politica conservadora del 2026-05-30 para NBA, WNBA, NFL, MLB y Futbol.
- Umbrales vigentes en `src/services/sport-bettable-thresholds.js`:
  - NBA: verde 55 / amarillo 47; gates dq 0.58, EV 0.03, gap 0.20, edge 0.04.
  - WNBA: verde 57 / amarillo 43; gates dq 0.50, EV 0.03, gap 0.22, edge 0.04, confianza minima 48.
  - MLB: verde 62 / amarillo 50; gates dq 0.50, EV 0.02, gap 0.20, edge 0.03.
  - NFL: verde 62 / amarillo 50; gates dq 0.60, EV 0.02, gap 0.18, edge 0.04.
  - Futbol: verde 62 / amarillo 50; gates dq 0.55, EV 0.03, gap 0.20, edge 0.03.
- `src/services/pro-odds-scoring.js`:
  - `modelBasePoints` sube a `Math.min(12, Math.round(dataQuality * 14))`.
  - `computeDataQuality()` suma bonus por `pitcher_confirmado` y `espn_win_prob_disponible`.
  - `evaluateValueGates()` devuelve `gates` para diagnostico y `logValueGateFailure()` escribe solo con `DEBUG_GATES=true`.
- EV:
  - `pick-calibration.js` separa `calibrateForScoring()` (cap 8%) de `calibrateForDisplay()` (shrink 0.65, cap 30%).
  - Los policies usan `ev_model` para scoring/gates, conservan `ev_raw` y agregan `ev_display`/`evDisplay` para UI.
  - `spreadScorePro()` mantiene rango 40-90 sin duplicar agresivamente el peso del EV.
- WNBA:
  - `espn-wnba.js` extrae `espnWinProbHome/Away` del scoreboard y marca `espn_win_prob_disponible`.
  - `wnba-odds-policy.js` ancla ML a ESPN win probability cuando el gap supera 12 pp.
  - `wnba-projection.js` mezcla totales con H2H reciente al 30% cuando hay al menos 2 partidos validos.
- Public splits:
  - `public-splits-store.js` no usa snapshots con mas de 6 h para LM; devuelve neutral hasta refrescar datos.
- Verificacion aplicada:
  - `scripts/verify-threshold-scenarios.mjs`, `scripts/verify-nba-thresholds.mjs`, `scripts/verify-wnba-thresholds.mjs`, `scripts/verify-data-quality.mjs`.
  - Import chain de policies/providers OK e inline scripts de `public/index.html` OK.

---

## 2026-05-30 - Calibracion pro conservadora por deporte

- **Superseded el 2026-05-31 por la recalibracion post-auditoria anterior.**

- Modulos activos revisados: MLB, Futbol, NBA, WNBA, NFL y Quiniela.
- Score Pro:
  - `src/services/pro-odds-scoring.js` usa `spreadScorePro()` para rango util 40-90.
  - Umbrales pro endurecidos en `src/services/sport-bettable-thresholds.js`:
    - NBA/WNBA/NFL/Futbol: verde score 72, amarillo 60.
    - MLB: verde score 70, amarillo 58.
  - Las senales de mercado solo bajan umbral verde si estan alineadas con el lado del pick.
- EV:
  - `pick-calibration.js` mantiene `DISPLAY_EV_CAP=0.08`; EV visible se comprime para que +5-8% sea el rango alto normal.
  - NBA, WNBA, NFL, MLB y Futbol ya usan EV calibrado para scoring/display; se conserva `ev_raw` cuando aplica.
- Confianza minima:
  - `MIN_RECOMMENDATION_CONFIDENCE=58`.
  - `evaluateValueGates()` agrega fallo `confianza_baja`.
  - `bettable` y persistencia backtesting no aceptan picks bajo ese suelo.
- Drop 12h:
  - NBA/NFL/WNBA indexan `drop12h`, `dropBetSide` y `dropMarket`.
  - El drop solo cuenta como confirmado si `dropBetSide` coincide con el lado del pick; si no, puede aparecer como fade.
  - UI muestra "Sin dato" cuando no hay feed 12h para ese mercado.
- Hoy vs manana:
  - La home filtra picks por fecha activa usando fecha Madrid, no `slice(0,10)` UTC.
  - El agrupado visual usa `diffMadridDaysFromToday()` para separar Hoy / Manana sin depender de texto con acentos.
- Kelly:
  - UI pasa de Kelly 15% a Kelly 5%, cap max 1.0% del bankroll y no calcula stake si confianza <58.
- Historico:
  - `/api/backtest/stats` expone `by_market_type` (ML, Runline, Totales).
  - La home carga historico por deporte y lo usa en ranking (`pickHistoricalHitRate`) cuando hay al menos 3 picks resueltos por tipo.

---

## Decision principal vigente

### Tenis
- Estado actual: legacy/no activo en la home actual.
- `server.js` no expone `GET /api/analyze` ni `/api/providers`.
- `public/index.html` no registra modulo `tennis` en `MODULES`.
- Si se reactiva, reconstruir contratos desde cero antes de usar secciones antiguas de tenis.

### MLB
- `MLB Stats API` (schedule, pitchers, lineups, stats, feed de partido para umpire)
- Cuotas: `Odds-API.io` (Bet365 + Winamax FR) o fallback `The Odds API`
- Clima: `Open-Meteo` por coordenadas del estadio (sin API key)
- Motor de probabilidad: `src/services/mlb-probability.js` (Poisson + Monte Carlo ~4k sims)
- Contexto pro: `src/services/mlb-game-context.js` (fatiga bullpen, calendario, clima, umpire del feed)
- EV: `evFromProbability(prob, odds)` = `prob x cuota - 1`; se acota a `MLB_EV_ABS_CAP=0.08` para scoring (no se anula a `null`)
- `topPicks`: ranking por `mlbPickRankScore` (EV + confianza); reserva hueco para run line bettable con conf≥75 y EV≥5%
- Pick bettable: value gates por deporte; MLB usa confianza minima 50 en modo value y gates pro.
- Totals MLB penalizan push si la proyeccion queda cerca de la linea; pitchers abridores dominantes reducen mas la proyeccion rival.
- Scoring 0-100 en `mlb-analyzer.js` + ajustes bullpen rival fatigado, calendario y parque/clima

### Futbol
- Modulo beta activo: **Odds-API.io** (`/value-bets`, `/dropping-odds`, `/odds/multi`, `/events`)
- Ventana operativa UI/API: `date` ancla + barrido de `3 dias` (`date`, `date+1`, `date+2`)
- En home y tabs solo se exponen `verdes` y `amarillos` reales; `sin_valor` / `modelo` no deben entrar como alternativas visibles
- Scoring 10 factores en `football-analyzer.js` -> `calcularScorePick()`
- Adapter UI legacy en `buildFootballAnalysis()` (campos `matches`, `picks`, `parlays` + nuevos `partidos`, `top5_jornada`)
- ESPN Soccer / Site API activo: `src/providers/espn-soccer.js` -> `loadEspnSoccerInsights()` cruza forma, H2H, standings, tiros, corners y tarjetas
- API-Sports Football opcional (`APISPORTS_FOOTBALL_*`) para alineaciones/fixture; merge en `mergeFootballSupportContext()`
- Mercados de tarjetas (`Bookings Totals` / `Bookings Spread`): **no se generan ni muestran** si `referee` viene vacio (filtro backend + UI)
- Labels over/under en español con prefijo `(+)` / `(-)`; deduplicacion semantica de lineas en tab Partidos (`collectEventRecommendations` + `buildMatchRows`)

### Quiniela (NUEVO)
- Endpoint activo: `GET /api/quiniela/analyze?date=YYYY-MM-DD` (en `server.js`)
- Orquestador: `src/services/quiniela-analyzer.js`
- Caché compartida (2026-05-28):
  - Endpoint `/api/quiniela/analyze` usa `getCachedAnalysis` (TTL 10 min, stale 6 h; 30 min de 03:30–07:00 Madrid)
  - Reutiliza `futbol:${date}` de `analysis-response-cache.js` (no duplica Odds-API/ESPN si fútbol ya está en caché)
  - Boleto oficial SELAE cacheado con `loadWithCache` (`quiniela-official-cache.js`, TTL 15 min, stale 2 h)
  - Filas oficiales en memoria para excluir partidos del desk fútbol (`getCachedOfficialQuinielaRows`)
- Capa independiente (2026-05-28):
  - `src/services/quiniela-football-bridge.js` — empareja boleto oficial ↔ `football.partidos` (+ ESPN directo)
  - `src/services/quiniela-probability.js` — fusión modelo ESPN/API-Sports + cuotas ML + dropping odds
- `football-analyzer.js` expone en cada `partido` (solo lectura): `mlOdds`, `footballCtx`, `oddsDrop` — **sin cambiar** lógica EV/picks
- Fuente oficial: `https://www.loteriasyapuestas.es/es/resultados/quiniela` (vía `r.jina.ai`)
- Modo vigente: **solo oficial**
  - si NO hay composición oficial publicada: `dataAvailable=false` + aviso explícito en UI
  - si SÍ hay composición oficial: genera `propuestaOficial[]` (fijo/doble, máx. 4 dobles por riskScore)
- Sin placeholder PPG (1.3/1.15) si `dataQuality < 0.45`
- Fijo natural: top ≥50%, edge ≥12 pp, confianza ≥70%, desacuerdo modelo/mercado ≤12 pp
- Respuesta incluye:
  - `officialSource` (`cardDetected`, `jornadaEnVenta`, `jornadaAnalizada`, `pleno15`)
  - `propuestaOficial[]` con `order`, `partido`, `pick`, `tipo`, `confianza`, `explicacion`
  - `quinielaMeta` por partido: `dataQuality`, `confidence`, `disagreement`, `method`, `bridgeSource`
- UI (`public/index.html` + `public/styles.css`):
  - card módulo Quiniela con badge en vivo:
    - `OFICIAL PUBLICADA` (verde)
    - `ESPERANDO OFICIAL` (amarillo)
    - `VERIFICANDO OFICIAL` / `ERROR FUENTE`
  - bloque “Boleto oficial” moderno
  - explicación visible por partido propuesto (`explicacion`)
- Telegram:
  - `src/services/telegram-notifier.js` añade `notifyQuinielaOfficialProposal()`
  - cuando hay jornada oficial + 14 partidos propuestos, envía automáticamente resumen a Telegram con la propuesta y P-15
  - lock/dedupe por jornada en memoria (`TELEGRAM_QUINIELA_JORNADAS_SENT`)

### Legacy (no por defecto)
- `community-stack`, `api-tennis`, `sportradar`, snapshots Flashscore/OddsHarvester

---

## Fecha y zona horaria

- Siempre filtrar por el dia actual en Madrid (`TENNIS_TIMEZONE=Europe/Madrid`)
- `server.js` usa `resolveAnalysisDate()` -> `getMadridTodayDateString()` si no hay `?date=YYYY-MM-DD`
- Comparacion horarios: `src/utils/madrid-date.js` (`isSameCalendarDayInTimezone`)
- `/api/health` devuelve `timezone` y `analysisDate`

---

## Como sacar picks por deporte

Referencia rapida para saber **de donde sale cada pick** y **que mirar en la respuesta JSON**.

### Tenis (legacy/no activo) — `GET /api/analyze?date=YYYY-MM-DD`

> Nota 2026-05-31: esta seccion es historica. En el arbol actual no existen `src/services/analyzer.js`, `src/services/slate-service.js`, `src/services/tennis-odds-policy.js` ni endpoint `/api/analyze`.

**Archivo:** `src/services/analyzer.js` -> `buildAnalysis()`

**Pipeline:**

```txt
1. loadSlate(date)                    -> calendario tenis (odds-api-io o matchstat)
2. En paralelo:
   - loadTennisValueBets("Bet365")
   - loadTennisValueBets("Winamax FR")
   - loadTennisDroppingOdds(TENNIS_DROP_MIN, "12h")
3. Indexar por eventId: vbIndex, dropIndex
4. analyzeMatch() por partido pendiente -> recommendations[] (winner, totals, ...)
5. enrichTennisRecommendation()       -> evaluateTennisPick() + odds gap + drop
6. partitionTennisPicks()             -> picks / comboLegs / modelLeans
7. buildTennisParlays()               -> combinadas tenis
8. UI publica picks solo desde `picks[]` y `comboLegs[]`; `modelLeans[]` queda para analisis interno / tab de partido
```

**Clasificacion (`tennis-odds-policy.js`):**

| Estado | Condicion |
|--------|-----------|
| `verde` | EV >= 5%, cuota 1.40-3.00, confianzaTotal >= 60 |
| `amarillo` | EV >= 3%, cuota en rango, confianza >= 50, no verde |
| `sin_valor` | resto |

**Scoring confianza (factores A-K):**

| Factor | Que mide | Max pts |
|--------|----------|---------|
| A | EV del value-bet | 20 |
| B | Drop sharps 12h alineado al lado | 12 |
| C | Gap Winamax - Bet365 | 8 |
| D | Rango cuota optimo (1.5-2.2) | 8 |
| K | Consistencia (EV + drop + gap) | 6 |
| Contexto | surface, forma, medical, h2h, fatiga... | 46 (escalado de max 52) |

**Donde leer picks:**

| Vista UI | Campo JSON | Contenido |
|----------|------------|-----------|
| Tab **Picks** | `picks[]` | Solo verdes (`readyToBet` + `safeForSingle`), max 6, orden EV |
| Tab **Partidos** | `matches[]` | Tarjetas de partido enriquecidas; si no hay valor/alternativa real el partido se oculta del resumen principal |
| Tab **Combinadas** | `parlays[]` | 2 patas tenis, EV combinado >= 5% |
| Alternativas | `comboLegs[]` | Amarillos validos para combinada |

**Campos clave por recomendacion:**
`estado`, `ev`, `evPercent`, `confidence`, `bet365Odds`, `winamaxOdds`, `valueBook`, `oddsGap`, `drop12h`, `senalDoble`, `readyToBet`, `safeForSingle`, `safeForComboLeg`, `rationale`, `riskFlags`, `participantInsights`

---

### Futbol — `GET /api/futbol/analyze?date=YYYY-MM-DD`

**Archivo:** `src/services/football-analyzer.js` -> `analyzeFootballSlate()` + `buildFootballAnalysis()`

**Pipeline:**

```txt
1. En paralelo:
   - loadFootballValueBets("Bet365")
   - loadFootballValueBets("Winamax FR")
   - loadFootballDroppingOdds(FOOTBALL_DROP_MIN, "12h")
   - loadFootballEvents()
2. Filtrar eventos en ventana Madrid de `3 dias`, excluir jugados, max FOOTBALL_MAX_MATCHES
3. loadFootballOddsMulti() en lotes de 10 -> oddsMap (Bet365 + Winamax por mercado)
4. Por partido + mercado en MERCADOS[]:
   - EV desde value-bet (normalizeExpectedValue)
   - calcularScorePick() 10 factores
   - esVerde() / esAmarillo()
5. top5_jornada: mejores verdes globales (max 2 por partido, top 5)
6. buildValueParlays(allGreen) -> combinadas_top (max 3)
7. buildFootballAnalysis() adapta a UI legacy (matches, picks, parlays...)
```

**Mercados escaneados:** ML, Totals, Spread, Corners Totals, Bookings Totals, Team Total Home/Away, Corners Spread, Bookings Spread

**Clasificacion:**

| Estado | Condicion |
|--------|-----------|
| `verde` | EV >= 5%, cuota 1.40-3.40, conf >= 60, bajas titulares < 3 |
| `amarillo` | EV >= 3%, conf >= 50, bajas < 3, no verde |
| sin valor | resto (en `partidos[].sin_valor[]`) |

**Scoring 10 factores (A-J):** EV, drop, gap casas, rango cuota, forma, goles esperados, local/visitante, lesiones, posicion tabla, consistencia senales.

**Donde leer picks:**

| Vista UI | Campo JSON | Contenido |
|----------|------------|-----------|
| Tab **Picks** | `picks[]` | Verdes adaptados (`bettable=true`), max 8 |
| Tab **Partidos** | `matches[]` | Partidos con resumen visible solo si hay verde o amarillo real |
| Top jornada | `top5_jornada[]` | 5 mejores verdes del dia |
| Combinadas | `parlays[]` / `combinadas_top[]` | Combinadas EV >= 5% |
| Tendencias | `trendPicks[]` | Uso interno / fallback; no tratar `sin_valor` o `modelo` como alternativa visible |

**Campos clave (formato interno `partidos[].picks[]`):**
`mercado`, `seleccion`, `ev`, `evPercent`, `confianza`, `estado`, `bet365_odds`, `winamax_odds`, `mejor_cuota`, `valueBook`, `gap`, `drop_12h`, `senalDoble`, `scores`

**Nota tecnica:** `bookmakers` en `/odds/multi` llega como **objeto**, no array. Normalizar con `ingestOddsMultiEntry()`.

---

### MLB — `GET /api/mlb/analyze?date=YYYY-MM-DD`

**Archivo:** `src/services/mlb-analyzer.js` -> `buildMlbAnalysis()`

**Pipeline:**

```txt
1. MLB Stats API -> calendario del dia (+ schedule reciente para fatiga)
2. loadMlbOddsMap() -> cuotas Bet365/Winamax (odds-api-io o the-odds-api)
3. loadTeamContext() -> abridor, bateo, bullpen + scoreBullpenFatigue + computeScheduleFatigue
4. buildGameContext() -> proyeccion carreras, clima Open-Meteo, umpire feed, simulation Poisson/MC
5. build*Recommendation() -> ML, totals, team totals, run line con resolveModelProbability()
6. enrichRecommendation() -> EV (prob×odds−1), openingOdds, oddsComparison, oddsGap
7. topPicks() -> bettable && confidence >= 70, max 6
8. buildParlays() -> combinadas MLB (2 patas, partidos distintos)
```

**Clasificacion:**

| Vista | Condicion |
|-------|-----------|
| Pick verde (`picks[]`) | `bettable=true` (cuota + conf >= 70 + edge modelo) |
| Lean | `verdict=lean`, conf >= 55 |
| Sin valor | `verdict=avoid` |

**EV:** `prob×cuota−1` con `modelProbability` de Poisson/Monte Carlo (`mlb-probability.js`). Formato relativo legacy: `(modelProbability - implied) / implied` solo en comparaciones internas. **No** usa `/value-bets` de odds-api.io.

**Archivos auxiliares MLB:**

| Archivo | Rol |
|---------|-----|
| `mlb-probability.js` | `probHomeWin`, `probTotalOver`, `probTeamTotalOver`, `runMonteCarlo`, `evFromProbability` |
| `mlb-game-context.js` | `scoreBullpenFatigue`, `computeScheduleFatigue`, `loadGameWeather`, `parseUmpireFromFeed` |
| `mlb-copy.js` | Textos UI: metodologia Poisson/MC, risk notes (clima, umpire, calendario) |

**Donde leer picks:**

| Vista UI | Campo JSON |
|----------|------------|
| Tab **Picks** | `picks[]` |
| Tab **Partidos** | `games[]` con `recommendations[]` |
| Combinadas | `parlays[]` |
| Modelo | `modelPicks[]`, `runsPicks[]`, `teamPicks[]` |

---

## Estrategia de dos casas: Bet365 + Winamax FR

| Casa | Perfil | Uso en el modelo |
|------|--------|------------------|
| **Bet365** | Sharp - mueve lineas antes | Referencia precio; EV en `/value-bets`; dropping-odds |
| **Winamax FR** | Retail - cuotas mas altas en favoritos | Detectar valor cuando paga mas que Bet365 |

```txt
gap = winamax_odds - bet365_odds
gap >= 0.08 -> valor en Winamax
gap <= -0.08 -> valor en Bet365
senalDoble = EV >= 5% + drop 12h alineado al mismo lado
```

Archivo: `src/services/odds-comparison.js` -> `buildOddsComparison()`, `buildOddsGapFactor()`

---

## Principio EV (Expected Value)

```txt
probabilidad_implicita = 1 / cuota_decimal
EV = (prob_modelo - prob_implicita) / prob_implicita

Pick verde solo si EV >= +5% (EV_THRESHOLD)
```

- **Tenis/futbol:** EV viene de Odds-API.io `/value-bets` (normalizado con `normalizeExpectedValue()`)
- **MLB:** EV calculado con `modelProbability` del analizador local

Umbrales globales tenis (`tennis-odds-policy.js`):

```js
EV_THRESHOLD = 0.05   // verde
EV_YELLOW_MIN = 0.03  // amarillo
MIN_ODDS = 1.40
MAX_ODDS = 3.00       // tenis; futbol hasta 3.40
MIN_CONFIDENCE = 60
TENNIS_DROP_MIN = 5   // % minimo drop 12h
FOOTBALL_DROP_MIN = 8
```

---

## Combinadas multi-deporte

**Archivo:** `src/services/parlay-builder.js` -> `buildValueParlays(allGreenPicks)`

**Reglas:**
1. Cada pata EV >= +5%
2. Cuota combinada 1.80 - 4.00
3. Patats independientes (distinto partido; evita mismo torneo/ronda en tenis)
4. Max 3 combinadas devueltas (futbol); tenis usa `buildTennisParlays()` propio

**Estado:** activo en tenis (`parlays[]`) y futbol (`combinadas_top[]` / `parlays[]`). Endpoint unificado `/api/combined/picks` **pendiente**.

---

## Tracker PostgreSQL

- Estado: **activo** en `docker compose` con servicio `postgres:16-alpine`
- Script SQL: [001_create_picks_tracker.sql](/D:/Daniel/APLICACIONES%20VARIAS/001_create_picks_tracker.sql)
- Servicio DB backend: [src/services/picks-db.js](/D:/Daniel/APLICACIONES%20VARIAS/src/services/picks-db.js)
- Endpoints nuevos en [server.js](/D:/Daniel/APLICACIONES%20VARIAS/server.js):
  - `GET /api/db/health`
  - `GET /api/stats`
  - `GET /api/picks`
  - `GET /api/picks/pending`
  - `POST /api/picks`
  - `PATCH /api/picks/:id/resultado`
  - `PATCH /api/picks/:id/corregir` (correccion de resultado ya resuelto + ajuste bankroll)
  - `DELETE /api/picks/:id`
  - `PUT /api/bankroll`

### Reglas actuales del tracker

- No duplica picks pendientes iguales: mismo `pick_date`, `sport`, `partido`, `pick_label` y `mercado`
- `DELETE /api/picks/:id` solo borra picks en `resultado='pendiente'`
- `PATCH /api/picks/:id/resultado` recalcula `ganancia_neta` y actualiza `bankroll_actual`
- `updateBankroll()` no pisa el bankroll actual si ya habia resultados; solo lo resetea junto al inicial cuando ambos siguen iguales

### UI tracker

- La home activa en [public/index.html](/D:/Daniel/APLICACIONES%20VARIAS/public/index.html) ya integra:
  - Boton `+ Anadir a mi tracker` en cards de picks
  - Caja Kelly con `% a apostar`, `Si acierta` y `EV esperado`
  - Botones por partido: `+ Anadir picks al tracker` y `Quitar del tracker`
  - Resumen superior `Resultados de hoy` con tabs plegables `Todos / Ganados / Perdidos / Pendientes`
  - Los tabs del resumen del tracker empiezan cerrados; un toque abre el grupo y un segundo toque sobre el mismo tab lo vuelve a plegar
  - El tab `Pendientes` usa el tracker pendiente completo y se refresca al anadir o eliminar picks del tracker
  - Los picks pendientes iniciados en el dia actual ya muestran senal `EN VIVO` en la home del tracker
  - Las cards de `TOP PICKS DEL DIA` ya usan reticula estable en acciones (`Detalle`, tracker, `Eliminar`) para evitar desalineados entre tarjetas con textos largos
  - Las cards de `TOP PICKS DEL DIA` reservan una segunda fila de acciones tambien cuando no aparece `Eliminar`, para que tracked/untracked mantengan la misma estructura vertical
  - **`MEJOR PICK DEL DIA`** (`public/index.html`, `collectBestPicksOfDay`):
    - Solo picks value candidatos con confianza minima `58`; podio si confianza >=68, score >=72, edge fuerte o EV >= corte deporte + 1 pp
    - Verdes que no alcanzan podio siguen en **`TOP PICKS DEL DIA`**, no en el podio
    - Puede haber **varios** banners (uno por pick que cumple)
    - Ranking del podio: `sortPicks` -> **confianza** (mayor primero), luego **EV**, luego nombre del pick
    - Coronas: `#1 ORO`, `#2 PLATA`, `#3 BRONCE`, `#4+ HONOR` (icono 💎)
  - El bloque puede abrirse mas ancho que el contenedor principal para dar aire al resumen
  - El `float-pick-tray` ahora vive en la esquina inferior derecha con look redondo/orbital, conteo como badge y animacion suave; en desktop queda apilado en vertical, y en movil se convierte en un mini dock horizontal mas pequeno para reducir solape sobre las cards sin perder visibilidad
  - Los encabezados del desk de picks ya usan copy mas editorial: `Valor de Alta Conviccion` y un subtitulo descriptivo debajo, con mejor jerarquia tipografica
  - Panel `ESTADISTICAS TRACKER` debajo del desk con tabs:
    - `Historial`
    - `Por deporte`
    - `Pendientes`

### Notificaciones Telegram (activo)

- Servicio: `src/services/telegram-notifier.js`
- Flags en BD: tabla `pick_telegram_sent` + `src/services/pick-telegram-flags.js` + clave `src/utils/pick-identity.js`
- Integracion en `server.js`:
  - `POST /api/picks` -> notifica si `created`, `tierUpgraded`, `tierDowngraded` o `dataEnriched` (sin auto-notify en refresh de analisis)
  - `PATCH /api/picks/:id/resultado` y `PATCH /api/picks/:id/corregir` -> notifica **resuelto**; al resolver se borran flags del pick
- Criterio de envio:
  - Solo `estado_color` **`verde`** o **`amarillo`**
  - Minimos: `sport`, `partido`, `pick_label`, `mercado` (`hasMinimumTelegramFields`)
  - Dedupe por tier en BD: no reenvia mismo tier si ya se envio con igual o mayor `completeness`
  - **Amarillo -> verde** (verde no enviado): envia verde + banner `SUBE A TOP PICK` + confianza anterior/nueva + motivo (`notas`)
  - **Verde -> amarillo** (amarillo no enviado): envia amarillo + banner `BAJA A ALTERNATIVA` + motivo
  - Reenvio mismo tier si el pick gana datos (`completeness` mayor en `picks-db.savePick`)
- `picks-db.savePick`: upgrade `amarillo->verde` y downgrade `verde->amarillo` en duplicado pendiente; devuelve `tierChange`, `previousPick`
- Formato mensaje (HTML):
  - Cabecera: `🟢 TOP PICK` / `🟡 ALTERNATIVA` + `🔴 EN VIVO` o `🕒 HH:mm (Madrid)` o `Hora por confirmar` + deporte
  - Cuerpo: partido, seleccion, mercado legible, cuota, EV, confianza
  - Resolucion: `✅ GANADO` / `❌ PERDIDO` / `⚪ VOID` + neto
- Variables `.env`: `TELEGRAM_ENABLED`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (grupo negativo recomendado)
- Envio no bloqueante: fallo Telegram no rompe la API (solo log `[telegram]`)

### Variables de entorno relevantes

- `DATABASE_URL`
- `PGHOST`
- `PGPORT`
- `PGDATABASE`
- `PGUSER`
- `PGPASSWORD`
- `PGSSL`
- `MLB_MAX_ODDS`
- `MLB_MIN_ODDS`
- `TELEGRAM_ENABLED`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

---

## UX / Diseno

### Principios
1. El usuario ve EV% y estado, no formulas
2. Jerarquia: Resumen -> Picks verdes -> Partidos (todos mercados) -> Combinadas
3. Semaforo: verde (EV>=5%), amarillo (EV 3-5%), opaco sin valor
4. Bet365 vs Winamax siempre visibles en tarjeta tenis v2

### Estructura tabs

```txt
RESUMEN   -> titular + top picks + alertas dataAvailable
PICKS     -> solo verdes globales por deporte
PARTIDOS  -> calendario completo; tenis usa tarjeta v2
COMBINADAS -> parlays con EV combinado
SENALES   -> (planificado) drops y gaps por partido
```

### Tarjeta tenis v2 (implementada)

- **JS:** `public/tennis-match-card.js` -> `renderTennisMatchCard()`
- **CSS:** bloque `.tennis-match-v2` en `public/styles.css`
- **Integracion:** `public/app.js` -> `renderMatchesPanel()`
- Mercados ordenados: verde -> amarillo -> sin valor (55% opacidad, no expandible)
- Iconos: Ganador morado, Total amarillo, Handicap verde, 1er Set azul

---

## Filtros activos (orden de aplicacion)

### 1. Sin datos mock
- Proveedor `mock` deshabilitado
- Error de API -> respuesta `dataAvailable: false` + mensaje en UI

### 2. Partidos ya jugados - `src/utils/event-status.js`

| Deporte | Se excluye si |
|---------|----------------|
| Tenis | `finished`, `settled`, `final`, `completed`, cancelado |
| MLB | `Final`, `Game Over`, `completed` |
| Futbol | `finished`, `settled`, `cancelled`, `postponed`, `complete` |

### 3. Solo del dia (Madrid)
`filterUpcomingDayMatches()` en `src/utils/bettable-events.js`

### 4. Carga tenis (Odds-API.io)
`src/providers/odds-api-io.js` -> `loadOddsApiIoTennisSlate()`
- Solo `pending`/`live`; prioridad ATP/WTA -> Challenger/ITF (sin UTR)
- Max `TENNIS_MAX_MATCHES` (default 12)

### 5. Clasificacion por deporte

| Deporte | Verde | Amarillo | Tab Picks | Tab Partidos |
|---------|-------|----------|-----------|--------------|
| **Tenis** | `estado=verde`, `safeForSingle`, EV>=5%, conf>=60 | `estado=amarillo`, `safeForComboLeg` | `picks[]` (max 6) | `matches[].recommendations[]` con tarjeta v2 |
| **Futbol** | `estado=verde`, `bettable=true` | `estado=amarillo`, `verdict=lean` | `picks[]` (max 8) | `matches[]` con `recommendations[]` |
| **MLB** | `bettable=true`, conf>=70 | `verdict=lean`, conf>=55 | `picks[]` (max 6) | `games[]` con `recommendations[]` |

---

## Arquitectura funcional (pipeline comun)

1. Cargar calendario + cuotas (Odds-API.io / MLB Stats API)
2. Cargar en paralelo **value-bets** y **dropping-odds** (tenis y futbol)
3. Normalizar a modelo comun por partido
4. Calcular factores explicitos (scoring por deporte)
5. Enriquecer cada recomendacion con EV, gap Bet365/Winamax, drop 12h
6. Clasificar: `verde` / `amarillo` / `sin_valor`
7. Particionar picks globales + construir combinadas (`parlay-builder.js`)
8. UI: Picks = solo verdes globales; Partidos = todos los mercados del dia con prioridad visual

---

## Backend core

| Archivo | Rol |
|---------|-----|
| `server.js` | HTTP, fecha Madrid, cache analisis ~10 min + stale fallback si Odds-API.io entra en rate limit |
| `src/services/football-analyzer.js` | Scoring futbol 10 factores + adapter UI legacy |
| `src/services/mlb-analyzer.js` | Scoring MLB, Poisson/MC, contexto clima/bullpen, ajuste pitcher elite y riesgo push |
| `src/services/mlb-probability.js` | Poisson + Monte Carlo + EV |
| `src/services/mlb-game-context.js` | Fatiga bullpen, calendario, clima, umpire |
| `src/services/nba-analyzer.js` | NBA pro analyzer |
| `src/services/wnba-analyzer.js` | WNBA pro analyzer |
| `src/services/wnba-odds-policy.js` | WNBA gates + selection/bookmaker/EV normalizados |
| `src/services/nfl-analyzer.js` | NFL pro analyzer |
| `src/services/sport-bettable-thresholds.js` | Umbrales por deporte y confidence gates |
| `src/services/pick-calibration.js` | EV display/scoring + confianza minima por deporte |
| `src/services/parlay-builder.js` | Combinadas multi-deporte con EV combinado |
| `src/services/odds-comparison.js` | Comparativa Bet365 vs Winamax, oddsGap |
| `src/providers/odds-api-io.js` | value-bets, dropping-odds, odds/multi y eventos para deportes activos |
| `src/providers/shared/resource-cache.js` | Cache in-memory por recurso: TTL, stale, dedupe de requests en vuelo |
| `src/config/runtime.js` | Auto-detecta proveedores por env |
| `src/utils/madrid-date.js` | Fecha Madrid |
| `src/utils/event-status.js` | Jugado vs pendiente |
| `src/utils/bettable-events.js` | Filtros dia + favorable |
| `public/index.html` | Home tracker, desk picks, `collectPicks` / `buildMatchRows`, timing `getTrackerTimingMeta` |
| `public/styles.css` | UI principal, incluido badge Edge de MEJOR PICK |

### Planificados / no activos
- `/api/combined/picks` cross-deporte.
- Tenis legacy: no hay `src/services/analyzer.js`, `slate-service.js`, `tennis-odds-policy.js` ni `public/tennis-match-card.js` en el arbol actual.

---

## API

| Endpoint | Builder | Descripcion |
|----------|---------|-------------|
| `GET /api/health` | inline | timezone, analysisDate (Madrid) |
| `GET /api/mlb/analyze?date=` | `buildMlbAnalysis()` | MLB |
| `GET /api/futbol/analyze?date=` | `buildFootballAnalysis()` | Futbol (adapter UI + campos nuevos) |
| `GET /api/nba/analyze?date=` | `buildNbaAnalysis()` | NBA |
| `GET /api/wnba/analyze?date=` | `buildWnbaAnalysis()` | WNBA |
| `GET /api/nfl/analyze?date=&week=&season=` | `buildNflAnalysis()` | NFL |
| `GET /api/quiniela/analyze?date=` | `buildQuinielaAnalysis()` | Quiniela oficial (solo cuando existe composición oficial) |
| `GET /api/public-splits/status` | inline | estado/refresco de public splits |
| `GET /api/stats` / `GET /api/picks*` | `picks-db.js` | tracker, pendientes, resultados y bankroll |

Fecha default: Madrid (`resolveAnalysisDate()`).

### Cache y rate limit

- `server.js` mantiene `analysisCache` por `sport:date`:
  - fresco: ~10 min
  - stale fallback: ~6 h solo para sobrevivir a ventanas de rate limit sin vaciar la UI
- `src/providers/shared/resource-cache.js` deduplica requests iguales, aplica TTL por recurso y permite reutilizar stale si el fetch falla.
- `src/providers/odds-api-io.js` aplica cache por endpoint:
  - `/events`: 15 min
  - `/odds` y `/odds/multi`: 5 min
  - `/value-bets`: 5 min
  - `/dropping-odds`: 5 min
- Si Odds-API.io responde `429`, se registra `retryAt` global y mientras siga activa esa ventana:
  - el provider deja de golpear la API si ya hay cache reutilizable
  - el backend devuelve el ultimo snapshot valido marcado como `staleBecauseRateLimit`
  - la home muestra `Datos no actualizados` y conserva el ultimo modulo cargado

### Campos JSON tenis (`/api/analyze`) - legacy/no activo

> Nota 2026-05-31: contrato historico; no usar como referencia de la app actual.

**Globales:**
- `date`, `dataAvailable`, `generatedAt`, `runtime`, `coverage`, `slateSummary`
- `picks` - solo verdes listos (`readyToBet` + `safeForSingle`), max 6, ordenados por EV
- `comboLegs` - amarillos validos para combinada, max 6
- `modelLeans` - inclinaciones sin valor suficiente
- `parlays` - combinadas tenis (`buildTennisParlays`)
- `matches` - todos los partidos del dia con recomendaciones completas
- `bettableMatches` - subset con pick verde en el partido

**Por partido (`matches[]`):**
- `id`, `tournament`, `category`, `surface`, `round`, `scheduledAt`, `schedule`
- `participants[0/1]`: `name`, `ranking`, `form`, `surface`, `inactivityDays`, `medical`
- `dataCompleteness` (0-1, UI muestra %)
- `recommendations[]` - todos los mercados analizados

**Por recomendacion (`recommendations[]` / `picks[]`):**
- `id`, `type` (`winner`/`totals`), `selection`, `label`, `confidence`
- `estado`: `verde` | `amarillo` | `sin_valor`
- `ev`, `evPercent`, `bestOdds`, `bet365Odds`, `winamaxOdds`, `oddsGap`, `valueBook`
- `drop12h`, `senalDoble` (EV>=5% + drop alineado al lado)
- `readyToBet`, `safeForSingle`, `safeForComboLeg`, `verdict`, `verdictLabel`
- `rationale`, `riskFlags`, `participantInsights`, `oddsComparison`
- `oddsScores`: desglose A_ev, B_drop, C_gap, D_cuota, K_consistencia, contexto

### Campos JSON futbol (`/api/futbol/analyze`)

**Campos nuevos (motor real):**
- `partidos[]`, `top5_jornada[]`, `combinadas_top[]`
- `picks_verdes`, `picks_amarillos`, `partidos_analizados`, `hora_analisis`

**Campos legacy (adapter UI en `buildFootballAnalysis`):**
- `matches[]`, `picks[]`, `trendPicks[]`, `goalsPicks[]`, `cornersPicks[]`, `resultPicks[]`, `parlays[]`
- `bestPick`, `bettableMatches`, `slateSummary`

**Por pick (interno en `partidos[].picks[]`):**
- `mercado`, `betSide`, `seleccion`, `linea`, `ev`, `evPercent`, `confianza`, `estado`
- `bet365_odds`, `winamax_odds`, `mejor_cuota`, `valueBook`, `gap`, `drop_12h`, `senalDoble`
- `scores`: A_ev, B_drop, C_gap, D_cuota, E_forma, F_goles, G_local, H_lesiones, I_tabla, J_consistencia

### Campos JSON quiniela (`/api/quiniela/analyze`)

- Si no hay composición oficial:
  - `dataAvailable: false`
  - `unavailableReason`: aviso de espera de publicación oficial
  - `officialSource.cardDetected: false`
- Si hay composición oficial:
  - `dataAvailable: true`
  - `partidos[]`: estructura tipo fútbol + `officialOrder`
  - `propuestaOficial[]`: ticket propuesto por IA para los 14 partidos oficiales
  - `officialSource`: metadatos de jornada y `pleno15`
  - `slateSummary`: `fixed`, `doubles`, `triples`, `officialCardDetected`, `officialJornada`

### Campos JSON MLB (`/api/mlb/analyze`)

- `games[]`, `bettableGames[]`, `slateSummary`, `coverage` (incl. `weather`, `simulation`, `bullpen`)
- `runtime.probabilityEngine`: `poisson-monte-carlo`; `runtime.weatherProvider`: `open-meteo`
- `picks` - `bettable && confidence >= 70`, max 6
- `modelPicks`, `runsPicks`, `teamPicks`, `leans`, `parlays`
- Por partido (`games[]`):
  - `simulation`: `{ homeWinProb, totalOverProb, iterations, homeRuns, awayRuns }`
  - `proContext`: proyecciones ajustadas, flags bullpen/calendario
  - `weather`: temperatura, viento, label
  - `umpire`: nombre parseado del feed MLB (sin historial aún)
  - `homeTeam.bullpen.fatigue`, `scheduleFatigue` en ambos equipos
- Recomendaciones: `modelProbability`, `expectedValue`, `openingOdds` (cuando hay cuota)
- Sin endpoints `/value-bets` de odds-api.io (usa modelo + cuotas emparejadas)

---

## Providers

### Activos / recomendados
- `src/providers/odds-api-io.js` - value-bets, dropping-odds, odds/multi y odds por deporte activo
- `src/providers/espn-nba.js`, `espn-wnba.js`, `espn-nfl.js`, `espn-soccer.js` - contexto deportivo
- `src/providers/api-sports-football.js`, `api-sports-basketball.js`, `api-sports-american-football.js` - contexto opcional por env
- `src/providers/medical-intel.js` - reglas + overrides locales
- `src/providers/the-odds-api.js` - fallback cuotas gratuito
- Clima MLB: Open-Meteo directo desde `mlb-game-context.js` (no provider separado)

### Futbol (estado actual)
- Motor: **Odds-API.io** (`/value-bets`, `/dropping-odds`, `/odds/multi`, `/events`)
- Contexto: **ESPN Site API** (`espn-soccer.js`) + opcional **API-Sports** (alineaciones)
- Mercados escaneados: ML, Totals, Spread, Corners, Bookings, Team Totals, Double Chance, spreads corners/bookings
- Max 2 picks verdes/amarillos por partido en respuesta interna; `top5_jornada` global; dedupe en analisis de partido evita lineas duplicadas en UI

### Planificados
- `football-data.org`, xG, ESPN stats reales en factor E-H
- `baseball-savant.js` (Statcast MLB)
- `line-movement.js` + `snapshot-service.js`

### Legacy
- `api-tennis`, `sportradar`, `community-stack`, `flashscore-live`, `oddsharvester`

---

## Configuracion (.env)

```env
# Casas activas
ODDS_API_IO_BOOKMAKERS=Bet365,Winamax FR
SHARP_BOOK=Bet365
RETAIL_BOOK=Winamax FR

# Tenis
TENNIS_DATA_PROVIDER=odds-api-io
TENNIS_ODDS_PROVIDER=odds-api-io
ODDS_API_IO_KEY=...
TENNIS_TIMEZONE=Europe/Madrid
TENNIS_MAX_MATCHES=12
TENNIS_DROP_MIN=5

# Politica EV global (tenis)
EV_THRESHOLD=0.05
MIN_ODDS=1.40
MAX_ODDS=3.00
MIN_CONFIDENCE=60
PARLAY_MIN_ODDS=1.80
PARLAY_MAX_ODDS=4.00

# MLB
MLB_ODDS_PROVIDER=odds-api-io

# Futbol
FOOTBALL_MAX_MATCHES=12
FOOTBALL_EV_THRESHOLD=0.05
FOOTBALL_MIN_ODDS=1.40
FOOTBALL_MAX_ODDS=3.40
FOOTBALL_MIN_CONFIDENCE=60
FOOTBALL_DROP_MIN=8

# Stats tenis (opcional)
MATCHSTAT_RAPIDAPI_KEY=...

# Fallback cuotas
THE_ODDS_API_KEY=...

# Telegram (grupo recomendado para varios destinatarios)
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=-100xxxxxxxxxx

# API-Sports futbol (opcional)
APISPORTS_FOOTBALL_ENABLED=true
APISPORTS_FOOTBALL_KEY=...
```

---

## Matching de nombres (cuello de botella principal)

**Archivo:** `src/providers/shared/player-name-matching.js`

Sin match correcto -> cuotas vacias -> EV=0 -> `sin_valor`. Critico para MLB/futbol/NBA/WNBA/NFL y cualquier modulo reactivado.

---

## Validacion conocida

- Docker `:3000`, `/api/health` OK
- 2026-05-31: sintaxis OK en `mlb-analyzer.js`, `mlb-odds-policy.js`, `pick-calibration.js`, `sport-bettable-thresholds.js`, `wnba-odds-policy.js` e inline script de `public/index.html`.
- 2026-05-31: regresion OK en `scripts/verify-threshold-scenarios.mjs`, `scripts/verify-wnba-fixes.mjs`, `scripts/verify-mlb-model.mjs` y `scripts/verify-ui-apis.mjs`.
- 2026-05-31: Playwright headless contra `http://localhost:3000` OK: HTTP 200, sin `pageerror`, sin errores de consola y badges `.best-pick-edge` renderizados.
- 2026-05-31: Docker rebuild OK; navegador recargado en `http://localhost:3000`. Estado visible: MLB 4 picks con valor, Futbol 0, WNBA 0, Quiniela 14.
- 2026-05-31: `/api/futbol/analyze?refresh=1` OK con `picks=0`, `picks_value=0`; el scoring declara confianza minima 55.
- Futbol: `/api/futbol/analyze` -> `dataAvailable: true`; bookmakers como objeto (fix `ingestOddsMultiEntry`)
- EV anomalo de API normalizado con `normalizeExpectedValue()` (tenis y futbol)
- UI tenis Partidos: tarjeta v2 activa con mercados ordenados por estado
- Sin mock: fallo API -> `dataAvailable: false`
- Odds-API.io ahora tiene cache in-memory por recurso + stale fallback; si entra en `429`, se mantiene el ultimo snapshot en vez de vaciar el modulo

---

## Limites reales

- Tenis solo Odds-API.io: H2H/forma limitados sin Matchstat key
- Cuotas ITF/Challenger a menudo vacias
- Futbol: ESPN Site API ya aporta contexto real (forma, H2H, standings, tiros, corners, tarjetas), pero sigue sin feed xG dedicado
- MLB: EV local Poisson/MC, no `/value-bets`; xFIP es proxy; Statcast/Savant y CLV en BD pendientes; umpire sin historial
- No hay aun persistencia de snapshots analiticos ni modulo de backtesting; el tracker si persiste picks, resultados y bankroll en PostgreSQL
- La cache actual es in-memory del proceso; si se reinicia el contenedor se pierde el snapshot y el primer refresco vuelve a depender del proveedor externo
- `/api/combined/picks` no implementado (combinadas por deporte si)

---

## Hoja de ruta EV / odds-api.io

| # | Tarea | Estado |
|---|-------|--------|
| 2 | Politica EV tenis (`tennis-odds-policy.js`) | COMPLETADO |
| 3 | Factor discrepancia Bet365/Winamax | COMPLETADO |
| 8 | `/value-bets` tenis activo | COMPLETADO |
| 9 | `/dropping-odds` tenis activo | COMPLETADO |
| 10 | `/value-bets` futbol activo | COMPLETADO |
| 11 | `/dropping-odds` futbol activo | COMPLETADO |
| 12 | Scoring futbol 10 factores | COMPLETADO |
| 13 | Top5 jornada futbol | COMPLETADO |
| 14 | Tarjeta tenis v2 (Partidos) | COMPLETADO |
| 7 | Matchstat H2H y forma | Pendiente |
| 15 | `line-movement.js` | Pendiente |
| 16 | `snapshot-service.js` + backtesting | Pendiente |
| 17 | `/api/combined/picks` unificado | Pendiente |
| 18 | ESPN stats reales en futbol | COMPLETADO |
| 19 | Notificaciones Telegram tracker | COMPLETADO |
| 20 | Fixes dedup/labels futbol + filtro tarjetas sin arbitro | COMPLETADO |

---

## Hoja de ruta de mejoras (priorizada)

| # | Tarea | Impacto | Estado |
|---|-------|---------|--------|
| 1 | Fix matching nombres | Alto | COMPLETADO |
| 2 | Politica EV tenis | Alto | COMPLETADO |
| 3 | Factor odds gap | Alto | COMPLETADO |
| 4 | `parlay-builder.js` | Medio | COMPLETADO |
| 5 | Endpoint `/api/combined/picks` | Medio | Pendiente |
| 6 | UX tarjeta tenis v2 | Alto | COMPLETADO |
| 7 | `line-movement.js` | Medio | Pendiente |
| 8 | Matchstat H2H/forma | Alto | Pendiente |
| 9 | Baseball Savant MLB | Medio | Pendiente |
| 10 | Selector fecha UI | Bajo | Pendiente |
| 11 | Snapshot + backtesting | Alto | Pendiente |
| 12 | ESPN stats futbol | Medio | COMPLETADO |
| 13 | Redisenar tarjetas futbol/MLB al estilo tenis v2 | Medio | Pendiente |
| 14 | Telegram multi-chat (`TELEGRAM_CHAT_IDS`) | Bajo | Pendiente |
| 15 | Notificaciones automaticas al detectar nuevo verde en analisis (sin pasar por tracker) | Medio | Pendiente |

---

## 2026-05-28 - Quiniela: capa bridge + probability (modelo + mercado)

- Arquitectura en 3 capas: `football-analyzer` (lectura) → `quiniela-football-bridge` → `quiniela-probability` → `quiniela-analyzer`.
- Fusión probabilidades: blend modelo (ESPN DC + API-Sports) + implícitas ML Bet365/Winamax; dropping odds como ajuste leve.
- `confidenceScore`, `dataQuality`, desacuerdo modelo/mercado (>12 pp baja confianza).
- Dobles por **riskScore** global (máx. 4); sin placeholder PPG si calidad <45%.
- Fútbol adjunta `mlOdds`, `footballCtx`, `oddsDrop` en cada partido sin tocar picks EV.

---

## 2026-05-28 - Quiniela: solo fijos/dobles, Telegram sin cambios

- Modelo: solo **Fijo** o **Doble** (sin triples). Máx. **4 dobles** en los partidos menos claros.
- Cada fila compara ventaja Fijo vs Doble; icono **★** (fijo) o **⚡** (doble) en la mayor ventaja.
- Telegram quiniela: no reenvía si la propuesta (14 picks + tipo) no cambió respecto al último envío.

---

## 2026-05-28 - Ventana de calendario: ayer (live) + hoy + mañana

- Regla unificada en `bettable-events.js` / `event-status.js` para tenis, MLB y fútbol.
- **Ayer**: solo partidos **en vivo** (empezados y no finalizados).
- **Hoy y mañana**: programados o en vivo; **sin pasado mañana** (`diff >= 2` excluido).
- Sincronizado `public/bettable-events.js` (antes tenía `futureDays: 2` en navegador).
- MLB filtra por `startTime` real (Madrid), no solo el día del payload del schedule.

---

## 2026-05-28 - Fix MLB: línea totales (`hdp`) y proyección de carreras

- **Odds-API.io** (`tennis-normalizers.js`): `totalsLine` y team totals leen `hdp` primero; solo mercado **Totals** del partido (excluye F5, props, team totals).
- **MLB** (`mlb-analyzer.js`): proyección de carreras más conservadora (topes 6.2 / 7.0); ML pondera más Poisson (82/18); confianza alineada con `modelProbability`.

---

## 2026-05-28 - Mejoras modelo tenis / fútbol / MLB (decay, Dixon-Coles, clima pro)

- **Tenis** (`analyzer.js`):
  - ELO de superficie con decay temporal: `λ=0.0018`, `K=32`, `1500 + Σ(Δ × e^(-λ×días))`.
  - `clutchIndex` en tie-breaks bajo presión → integrado en `formIndex` (+0.14) y `formEdge`.
- **Fútbol** (`espn-soccer.js`, `football-analyzer.js`):
  - Poisson **Dixon-Coles** con `τ=0.13` y lambdas desde xG ESPN + `γ` por ventaja local (`computeHomeVenueAdvantage`).
  - Factor G del scoring: **no mezcla PPG** si hay `model_home_prob` del modelo Poisson.
- **MLB** (`mlb-game-context.js`, `mlb-analyzer.js`):
  - Clima Open-Meteo con viento por **bearing CF** + temperatura lineal `(T-72)×0.012`; proyección `×(1+runAdjust)`.
  - Bullpen: `eraVsLeft` / `eraVsRight` (splits `vl`/`vr`) ponderados por mano del abridor rival.

---

## 2026-05-28 - MLB motor pro (Poisson + Monte Carlo + contexto)

- Nuevos modulos `src/services/mlb-probability.js` y `src/services/mlb-game-context.js`.
- `mlb-analyzer.js`:
  - proyeccion de carreras con penalizacion por bullpen rival fatigado y fatiga de calendario
  - `resolveModelProbability()` para ML, totals, team totals y run line
  - `buildGameContext()` expone `simulation`, `proContext`, `weather`, `umpire`
  - `enrichRecommendation()` guarda `openingOdds` y EV `prob×odds−1`
  - `getProviderManifest()` incluye Open-Meteo; `coverage` suma `weather` y `simulation`
- `mlb-copy.js`: metodologia y risk notes actualizados (clima, umpire, calendario, Poisson/MC).
- Pendiente: Statcast/Savant, historial umpire, CLV persistente en PostgreSQL, UI tarjeta MLB v2.

---

## 2026-05-27 - MEJOR PICK podio + Telegram tier + dedupe

### Home `MEJOR PICK DEL DIA`
- `collectBestPicksOfDay()` usa candidatos value (`confianza >=58`, mercado limpio, EV/score/edge) y sube a podio si confianza >=68, score >=72, edge fuerte o EV >= corte deporte + 1 pp.
- Verdes sin fuerza suficiente para podio solo quedan en `TOP PICKS DEL DIA`.
- Varios banners posibles; podio oro / plata / bronce / honor (`#4+` con 💎).
- Orden: confianza desc, luego EV desc (`sortPicks`).

### Telegram (dedupe y cambios de tier)
- Tabla `pick_telegram_sent` (`db/migrations/002_pick_telegram_sent.sql`); columnas tier + `completeness`.
- `notifyNewPickTelegram(pick, { tierChange, previousPick })` con banners de subida/bajada y motivo en `notas`.
- Sin `detectAndNotifyNewPicks` en refresh de analisis (evita duplicados); dedupe centralizado en POST tracker.
- `savePick` actualiza tier en duplicado pendiente (`tierUpgraded` / `tierDowngraded`).

### Futbol (calidad de datos / UI)
- `football-analyzer.js`: mercados Bookings sin arbitro no se procesan; over/under con `(+)` / `(-)`; Totals away/home normalizados a texto de totales de partido.
- `public/index.html`: dedupe semantica en `collectEventRecommendations` y `buildMatchRows`; `collectPicks` dedupe por mercado+linea+seleccion; `getTrackerTimingMeta` ya no marca "iniciado" si falta hora valida el mismo dia (solo compara HH:mm si existe).
- `public/dany-picks-render.js`: no renderiza tarjetas de bookings sin arbitro (guard extra).

### Despliegue
- Tras cambiar `.env` Telegram: `docker compose up -d --force-recreate danny-pick` (o `--build` si cambia codigo del notifier).

---

## Actualizacion 2026-05-24

- `odds-api-io` en Tennis ahora se enriquece con `Jeff Sackmann` tambien en el path normal de produccion, no solo en `community-stack`.
- Se corrigio el matching de nombres `Apellido, Nombre` para que Roland Garros y otros torneos crucen mejor con historico local.
- `inferSurfaceFromText()` ya reconoce torneos de tierra/hierba/indoor por nombre; `French Open / Roland Garros` entra como `Clay`.
- La home muestra arriba un resumen general del tracker (ganados, perdidos, % acierto y ROI del dia) y el detalle completo vive en `public/stats.html`.
- En picks/partidos de la UI ya se refleja si un pick o partido esta anadido al tracker, con opcion visible de eliminarlo.
- Futbol ya cruza `Odds-API.io` con `ESPN Site API` para forma, H2H, standings, tiros, tiros a puerta, corners y tarjetas por partido.
- `src/providers/espn-soccer.js` es la nueva capa de contexto valida para Futbol; no usa SofaScore ni scraping con 403.
- Tennis ahora expone `h2hHistory` por partido desde `Jeff Sackmann`: muestra media de juegos H2H, patron dominante y cuota justa historica aproximada cuando hay muestra.
- Tennis ahora expone tambien `derivedMarkets` por partido: `gana al menos 1 set`, `total juegos 1er set` y `total juegos 2do set` como lecturas `stats-only` cuando no llega cuota emparejada.
- La UI de `public/index.html` ya muestra pills y tarjetas nuevas para `H2H mercado`, `Tiros a puerta`, `Tarjetas` y etiqueta `ESPN cruzado` en Futbol cuando entra el contexto real.

---

## Siguiente paso inmediato

1. Rotar `ODDS_API_IO_KEY` y `TELEGRAM_BOT_TOKEN` si se expusieron en chat
2. Implementar `/api/combined/picks` para combinadas cross-deporte en UI
3. Validar slates reales: contar picks verdes vs amarillos vs sin_valor
4. Si se quiere cerrar mas huecos, buscar fuente valida para lesiones/medical de Tennis y arbitros de Futbol (feed dedicado, no solo nombre en evento)
5. Opcional: redisenar tarjeta futbol con mismo patron que tenis v2
6. Opcional: `TELEGRAM_CHAT_IDS` para varios destinos; notificar picks nuevos del analisis sin anadir al tracker

---

## Prompt de handoff reutilizable

```txt
Estoy continuando Sports Oracle en D:\Daniel\APLICACIONES VARIAS.
Lee AI_CONTEXT.md primero.

PICKS POR DEPORTE:
- Futbol: GET /api/futbol/analyze -> value-bets + dropping-odds + odds/multi -> calcularScorePick (A-J) -> picks[] + top5_jornada + combinadas_top
- MLB: GET /api/mlb/analyze -> MLB Stats API + cuotas + Open-Meteo -> Poisson/MC -> pitcher elite + riesgo push en totals -> picks[] si pasan gates.
- NBA/WNBA/NFL: GET /api/{nba|wnba|nfl}/analyze -> ESPN + Odds-API.io -> policies pro por deporte.
- Quiniela: GET /api/quiniela/analyze -> boleto oficial + bridge futbol + probabilidad.
- Tenis: legacy/no activo; no usar /api/analyze salvo que se reconstruya.

Casas: Bet365 (sharp) + Winamax FR (retail). EV/edge/confianza se gatean por deporte.
Combinadas: parlay-builder.js donde aplique. /api/combined/picks sigue pendiente.
Tracker: POST /api/picks dispara Telegram (dedupe BD, tier change, enriched) si TELEGRAM_ENABLED=true.
MEJOR PICK home: filtra cuota <1.45, conf>=85 con edge<8%, y exige confianza por deporte, edge>=8% o EV +2 pp sobre corte.
Fecha siempre Madrid. Sin mock. Actualiza AI_CONTEXT.md si cambias contratos, politica EV o notificaciones.
```

---

## Regla de mantenimiento

Actualizar este archivo si cambia:
- flujo de generacion de picks por deporte
- proveedor o endpoints odds-api.io usados
- politica EV o umbrales (`sport-bettable-thresholds.js`, `pick-calibration.js`, `*_VALUE_*`, `*_DROP_MIN`)
- contrato JSON de cualquier endpoint
- UI Partidos/Picks/Combinadas (especialmente `public/index.html` y `public/styles.css`)
- tracker PostgreSQL, settlement automatico o reglas Telegram
- estado de items en hoja de ruta

---

## 2026-05-24 - Enfoque de mercados (Tennis / Football / MLB)

- Tennis:
  - `enrichTennisRecommendation()` ya separa `winner` vs `totals` al cruzar `value-bets`.
  - Para `totals`, el `EV` ya busca mercados `total/games/over/under` y usa cuotas `Bet365/Winamax` del propio mercado, no las de `winner`.
- Football:
  - `Double Chance` se añadió a `MERCADOS` con formato en español, scoring propio y umbral de `EV >= 4%`.
  - `resolveFootballContext()` ya trata `1X` como foco local y `X2` como foco visitante.
  - `normalizeMarketRow()` preserva cuotas `1X`, `X2` y `12`.
  - `loadFootballDroppingOdds()` ya solicita `Double Chance` y `Team Total Home/Away` para habilitar `senalDoble` cuando el feed lo entregue.
- MLB:
  - `normalizeBookmakersFromOddsApiIo()` ya extrae `teamTotalHome` y `teamTotalAway`.
  - `buildTeamTotalRecommendation(game, side)` añade `Team Total Home/Away` al motor MLB con proyección, línea, cuota, `EV` y `confidence`.
  - `runsPicks` y `bestRunsPick` ya pueden priorizar `team-total`, no solo `totals` del partido.
- Estado del feed validado:
  - El código quedó listo, pero en la ventana verificada del `2026-05-24` el proveedor no devolvía `Double Chance` ni `Team Total` activos en salida live, así que esos mercados aún no aparecían en los endpoints públicos.

---

## 2026-05-24 - Tracker auto settlement + lock de borrado

- `server.js` ahora llama `reconcilePendingTrackerPicks()` antes de `/api/stats` y `/api/picks/pending`.
- `src/services/tracker-settlement.js` añade conciliación automática para picks pendientes `mlb` usando `MLB Stats API /schedule`:
  - soporta `Ganador del partido`
  - soporta `Total de carreras del juego`
  - soporta `Total de carreras local/visitante`
  - si el estado oficial es `Final`, resuelve `ganado/perdido`
  - si el estado oficial es `Postponed/Cancelled`, resuelve `void`
- `src/services/picks-db.js` ahora calcula `started/can_remove/lock_reason` para pendientes y bloquea `DELETE` si el partido ya empezó.
- `/api/picks/pending` devuelve todos los pendientes por defecto y adjunta metadatos:
  - `started`
  - `can_remove`
  - `lock_reason`
- `public/index.html`:
  - las cards de pick y las líneas analizadas del partido ya muestran estado de tracker (`Añadido`, `Ya inició`, `Bloqueado`)
  - las apuestas dentro del detalle de partido también tienen `Añadir/Eliminar`
  - el botón de quitar desaparece o queda bloqueado si el evento empezó / live / final

---

## 2026-05-26 - Cache defensivo Odds-API.io + stale snapshot

- Se añadió `src/providers/shared/resource-cache.js` como cache compartido para recursos externos:
  - TTL por endpoint
  - reutilización stale si el fetch falla
  - deduplicación de requests idénticas en vuelo
- `src/providers/odds-api-io.js` ahora:
  - cachea `/events`, `/odds`, `/odds/multi`, `/value-bets`, `/dropping-odds` y `/bookmakers/selected`
  - registra `retryAt` global cuando detecta `429`
  - deja de llamar a Odds-API.io durante esa ventana si existe cache reutilizable
- `server.js` ahora guarda el ultimo análisis valido por `sport:date` y lo reutiliza cuando Odds-API.io está limitado, sin marcar ese snapshot como fresco.
- `public/index.html` conserva el ultimo snapshot del modulo, muestra banner `Datos no actualizados` y evita refetches agresivos mientras siga la ventana de rate limit.
- `MODULE_FETCHED_AT` vuelve a actualizarse tras cada carga del modulo; eso reactiva el cooldown de frontend y evita peticiones innecesarias al backend.
---

## 2026-05-24 - Odds API markets explícitos

- `src/providers/odds-api-io.js` ahora solicita mercados explícitos para MLB en `/odds/multi` y `/odds`:
  - `ML,Totals,Runline,Team Total Home,Team Total Away`
- Fútbol:
  - `loadFootballValueBets()` ya usa `markets` explícitos con el mismo bloque que `loadFootballDroppingOdds()`
  - `loadFootballOddsMulti()` también quedó alineado con ese bloque para `ML, Double Chance, Team Totals, Corners, Bookings`
- Se añadió `DEBUG_ODDS` opcional:
  - `.env` expone `DEBUG_ODDS=false`
  - si se activa, el proveedor loguea qué mercados devuelve Odds-API.io por chunk para validar Team Totals / Double Chance
- Tennis:
  - provider por defecto: `odds-api-io` (integración Jeff Sackmann / `external-data` eliminada)

---

## 2026-05-25 - Tracker auto settlement total + limpieza de huerfanos

- `src/services/tracker-settlement.js` ahora liquida automaticamente los 3 deportes:
  - `MLB`: `Ganador del partido`, `Total de carreras del juego`, `Team Total`, `Handicap de carreras (run line)`.
  - `Futbol`: `ML`, `Double Chance`, `Totals`, `Team Total`, `Corners Totals`, `Bookings Totals` y handicaps usando `ESPN Site API`.
  - `Tennis`: `Ganador del partido`, `Ganara al menos un set`, `Ganador 1er/2do set`, `Total de juegos`, `Total juegos 1er/2do set` usando `Odds-API.io /events`.
- `server.js` sigue disparando la conciliacion antes de `/api/stats` y `/api/picks/pending`, asi que el panel y los pendientes se refrescan con el settlement real.
- Se anadio una regla anti-pendiente fantasma:
  - si el partido ya paso su hora prevista y el proveedor confirma que la liga/fecha si tiene cartelera pero ese cruce no existe en el slate real, el pick pasa a `void` automaticamente en vez de quedar pendiente para siempre.
  - umbrales actuales:
    - `Tennis`: 120 min
    - `Futbol`: 180 min
- Validacion local:
  - dos picks `tennis` de `2026-05-25` quedaron auto-void al no existir en el slate real de `Kosice/Chisinau`.
  - `pendientes` bajo de `6` a `4` y `voids` subio a `2`.

---

## 2026-05-31 - Fix settlement WNBA/futbol, reportes y persistencia

- Problema detectado:
  - `tracker-settlement.js` solo conciliaba `mlb`, `futbol` y `tennis`; los picks `wnba` quedaban pendientes aunque ESPN ya tuviera final.
  - Futbol no tenia mapping para `CONCACAF Champions Cup` y solo consultaba la fecha exacta del pick; Toluca vs Tigres estaba en ESPN como `concacaf.champions` en `2026-05-30` UTC aunque el pick era jornada Madrid `2026-05-31`.
  - Labels `A vs B` en futbol se comparaban como away/home; para futbol la orientacion real era home/away.
  - `recordAnalysisSnapshots()`/`persistPolicyPicks()` podia fallar con `savePick: gameId, market y pick son obligatorios` si el pick venia con campos nativos (`mercado`, `betSide`, `mejor_cuota`, etc.).
- Cambios:
  - `src/services/tracker-settlement.js` agrega settlement WNBA via ESPN scoreboard:
    - Moneyline.
    - Game total.
    - Team total local/visitante.
    - Ventana de fechas `D-1`, `D`, `D+1` para evitar desfase UTC/Madrid.
    - Cache de scoreboards con TTL corto (`TRACKER_PROVIDER_CACHE_SECONDS`, default 75s) para ahorrar requests sin congelar marcadores live.
  - Futbol:
    - mapping `concacaf.champions`.
    - consulta fechas adyacentes.
    - score de match en `vs` prueba orientacion directa e invertida.
  - `normalizePickDateKey()` ahora formatea `Date` en timezone de la app, no con corte UTC, para no mover cierres diarios al dia anterior.
  - `server.js` fuerza `reconcilePendingTrackerPicks({ force: true })` antes del resumen diario de Telegram.
  - `backtesting.js` robustece `mapProPickToBacktestRecord()` con fallbacks para `gameId`, `market`, `pick`, `oddsTaken` y `gameDate`.
  - `backtesting-settlement.js` agrega `concacaf.champions` y expande fechas adyacentes.
- Validacion:
  - `node --check`: `tracker-settlement.js`, `backtesting.js`, `backtesting-settlement.js`, `server.js`.
  - Forzado settlement real:
    - WNBA `Seattle Storm @ Toronto Tempo`: picks id `80` y `81` resueltos `ganado` y enviados por Telegram.
    - Futbol `Deportivo Toluca FC vs Tigres UANL`: pick id `89` resuelto `perdido` y enviado por Telegram. El marcador ESPN fue 1-1 con Toluca ganador por penales; como el mercado guardado era `ML`/1X2 con empate posible, el pick a Toluca se liquido como perdido.
    - WNBA `Las Vegas Aces @ Golden State Valkyries`: pick id `92` resuelto `ganado` y enviado por Telegram cuando ESPN paso a final.
  - Stats tras deploy:
    - `pendientes`: 0.
    - Global: 72 picks, 46 ganados, 24 perdidos, 0 pendientes, 2 voids.
    - Bankroll: 327.53.
    - `2026-05-31`: 8 picks, 5 ganados, 3 perdidos, 0 pendientes, ROI 19.88%.
    - `2026-05-30`: 7 picks, 4 ganados, 3 perdidos, 0 pendientes.
  - Contenedor registro cierre diario Telegram para `2026-05-31`: 5G / 3P / 0V, 8 resueltos, 0 pendientes, `gananciaTotalU=1.59`, `roiPct=19.9`.
  - Browser en `http://localhost:3000/`: UI verificada tras primer deploy; luego API final mostro `0 pendientes`.
  - Logs recientes sin `savePick error`, `Snapshot error` ni errores de settlement.

---

## 2026-06-01 - Fix futbol: ligas amateurs/valueBet y ML contra Poisson

- Problema detectado:
  - `shouldIncludeFootballEvent()` dejaba pasar ligas desconocidas si tenian `valueBetCount > 0`; esto metia ligas amateurs/regionales como Australia VPL/Victoria NPL.
  - `isYouthOrExcludedEvent()` solo revisaba liga/slug, no nombres de equipos; casos como `Melbourne Victory Youth` podian sobrevivir si la liga no marcaba youth.
  - `isTopLeague()` hacia match demasiado amplio: `Australia - Victoria Premier League 1` entraba por contener `Premier League`.
  - Picks ML podian ir contra el modelo Poisson/API-Sports (ej. home pick con `mHome < mAway`).
- Cambios en `src/services/football-analyzer.js`:
  - `isYouthOrExcludedEvent()` ahora revisa `leagueName`, `leagueSlug`, `homeName` y `awayName`.
  - `shouldIncludeFootballEvent()` queda estricto: excluye youth/reserve/friendly y solo permite ligas top (`isTopLeague`).
  - Matching de ligas endurecido con `normalizeLeagueKey()`, `leagueEntryIsGeneric()` y `leagueMatchesEntry()`:
    - alias genericos como `premier-league` solo matchean exacto.
    - slugs pais-liga como `england-premier-league` siguen entrando.
    - se agregaron slugs UEFA explicitos (`uefa-champions-league`, etc.) para no perder Champions/Europa/Conference.
  - Nueva validacion `isPickSideCoherentWithModel()`:
    - ML home exige `mHome > mAway` y `mHome > mDraw`.
    - ML away exige `mAway > mHome` y `mAway > mDraw`.
    - ML draw exige `mDraw` como mayor probabilidad.
    - Se aplica tanto en value-bets como en fallback `buildFootballModelLeanFromOdds()`.
- Validacion:
  - `node --check src/services/football-analyzer.js` OK.
  - Deploy Docker OK.
  - `/api/futbol/analyze?refresh=1`: `picks=0`, `partidos=0`, sin `Melbourne`, sin `VPL`.
  - Otros endpoints revisados:
    - MLB: datos propios de MLB, sin `VPL/Melbourne/Youth`.
    - NBA/WNBA/NFL: scoreboards ESPN de liga cerrada, sin `VPL/Melbourne/Youth`.
  - Browser `http://localhost:3000/`: Futbol muestra `Sin partidos en ventana`; TOP PICKS no incluye futbol amateur.

---

## 2026-06-02 - Descripciones de picks de futbol en espanol claro

- Problema detectado:
  - Algunos picks salian con etiquetas tecnicas poco entendibles para usuario final, especialmente `Corners Spread Morocco -4`.
  - La app no explicaba el margen necesario ni cuando una linea entera se devuelve.
- Cambios en `src/services/football-analyzer.js`:
  - `formatFootballSelection()` ahora devuelve textos accionables para:
    - ML.
    - Double Chance.
    - Totales de goles/corners/tarjetas.
    - Team totals.
    - Spreads de goles, corners y tarjetas.
  - Nuevos helpers de formato:
    - `formatFootballLineValue()`.
    - `footballOpponentBySide()`.
    - `footballPeriodLabel()`.
    - `formatFootballOverUnderSelection()`.
    - `formatFootballTeamTotalSelection()`.
    - `formatFootballHandicapSelection()`.
  - Para handicaps enteros se explica el push/devolucion:
    - Ejemplo real: `Morocco -4 corners` ahora sale como `Morocco -4 corners: necesita superar a Madagascar por 5+ corners en el partido. Si gana por 4, se devuelve.`
  - Si el feed no informa linea, ya no se muestra `handicap`; se explica como linea no informada.
- Validacion:
  - `node --check src/services/football-analyzer.js` OK.
  - Deploy Docker con `docker compose up --build -d` OK.
  - `/api/futbol/analyze?refresh=1` respondio `partidos=12`, `totalPicks=9`.
  - Muestras verificadas:
    - `Morocco vs Madagascar` / `Corners Spread`: texto claro con margen `5+` y devolucion por `4`.
    - `Wales vs Ghana` / `Corners Spread`: texto claro con margen `2+` y devolucion por `1`.

---

## 2026-06-02 - Auditoria final app, cache, futbol y UI desplegada

- Cambios principales aplicados:
  - Cache persistente de analisis en DB (`005_analysis_cache.sql`, `db-migrations.js`, `analysis-response-cache.js`) y cache compartida para ESPN soccer scoreboard/summary.
  - `pick-coherence.js` conectado en NBA/WNBA para descartar contradicciones entre game totals y team totals.
  - Runtime limpio para DANY PICKS, sin dependencia de `getRuntimeConfig().tennis`; cuotas sharp/retail salen de `sharpBook` / `retailBook`.
  - `pick-calibration.js`: futbol/futbol baja el minimo a 52.
  - API-Sports futbol normaliza probabilidades 1X2, evita lambdas negativas, expone fortalezas ataque/defensa, H2H, BTTS, over/under y marca `api_sports_has_predictions`.
  - `football-analyzer.js` exige datos reales para recomendar; fixture-only o priors no pasan como verde/amarillo.
  - Mundial/FIFA/UEFA siguen permitidos. Amistosos internacionales senior se permiten; amistosos de clubes, juveniles, reservas y femeninos se excluyen.
  - Picks futbol degradados por `football-odds-policy` (`sin_valor`, `data_quality_baja`, etc.) ya no quedan en `partido.picks`; se mueven a `partido.sin_valor`.
  - `quiniela-football-bridge.js` y `quiniela-probability.js` ahora aprovechan contexto API-Sports/ESPN ampliado, probabilidades Poisson fallback, forma reciente, ataque/defensa y calidad de datos.
  - UI: textos base en espanol claro, nuevos modulos `tennis-copy.js` y `tennis-match-card.js`, `mlb-copy.js` corregido y bloque responsive en `styles.css` para evitar desalineacion/overflow en cards, hero, stats y quiniela.
  - Nombre operativo unificado: `/api/health` reporta `service=danny-pick` y quiniela usa `User-Agent: danny-pick/quiniela-module`.
- Validacion:
  - `node --check` OK en archivos backend/frontend tocados.
  - `docker compose up --build -d` OK; contenedor `danny-pick` recreado y arriba en `0.0.0.0:3000->3000`.
  - `/api/health`: `status=ok`.
  - `/api/futbol/analyze`: `partidos=9`, `picks=0`; `Wales vs Ghana` queda como `sin_valor` anidado, no como recomendado global.
  - `/api/quiniela/analyze`: 14 partidos cargados.
  - Logs recientes sin crash del contenedor; `quiniela-results` omite polling cuando la jornada esta abierta.
  - Verificacion visual en navegador embebido no pudo completarse porque la politica interna bloqueo `http://localhost:3000/`; se uso verificacion HTTP/API/logs/sintaxis y revision estatica CSS/HTML.

---

## 2026-06-02 - Contexto real adicional para EV NBA/WNBA/NFL

- Objetivo:
  - Revisar campos reales ya disponibles que no estaban pesando bien en EV/probabilidad para NBA, WNBA y NFL.
  - Mantener los value gates estrictos; no subir picks por relajar filtros.
- Hallazgos:
  - NBA/WNBA parseaban `defRtg`, pero `project*TeamTotal()` usaba `offRtg1h` del rival como defensa. Ademas el sentido del factor estaba invertido para defensas mejores/peores.
  - NBA declaraba defensa rival y H2H como factores, pero el total de partido no tenia H2H full-game real y el ML dependia demasiado de ofensiva.
  - NBA tenia provider API-Sports Basketball disponible como fallback, pero `buildNbaGameContext()` no lo llamaba cuando ESPN no completaba stats de temporada.
  - NFL traia schedule reciente y API-Sports puede traer yardas, pero el modelo no usaba puntos permitidos/yardas permitidas y la varianza del equipo podia basarse en total del partido, no puntos del equipo.
- Cambios:
  - `src/providers/shared/espn-pro.js`:
    - Nuevo `parseEspnTeamRecentScoring()` con puntos a favor, puntos permitidos y totales recientes por equipo.
    - Nuevo `parseEspnH2hFullTotal()` para promedio H2H de partido completo.
  - `src/providers/shared/api-sports-pro.js`:
    - `parseAmericanFootballTeamStats()` ahora expone `ptsAllowedPerGame` y `yardsAllowedPerGame` si el feed los trae.
    - Nuevo `parseApiSportsH2hFullTotal()`.
  - `src/providers/espn-nba.js`:
    - Usa API-Sports Basketball como fallback real cuando ESPN no trae temporada completa de ambos equipos.
    - Agrega `ctx.h2h.averageTotal`.
  - `src/providers/espn-nfl.js`:
    - Enriquecimiento desde schedule con `recentScores`, `recentPointsAllowed`, `ptsAllowedPerGame`, `recentGameTotals` y `h2h.averageTotal`.
    - La completitud ESPN exige stats de temporada de ambos equipos antes de omitir fallback API-Sports.
  - `src/services/nba-projection.js`:
    - First half, team totals y game totals usan `defRtg` del rival con direccion correcta.
    - ML usa diferencial net rating `(offRtg - defRtg)` + forma + lesiones.
    - Totales mezclan H2H full-game solo si la diferencia contra el modelo es razonable.
  - `src/services/wnba-projection.js`:
    - Team totals usan `defRtg` real del rival con direccion correcta.
    - ML usa net rating real + forma + lesiones + fatiga.
  - `src/services/nfl-projection.js`:
    - Team totals usan puntos anotados, puntos permitidos del rival, yardas vs yardas permitidas, QB, clima, fatiga y lesiones.
    - ML usa diferencial neto real, yardas y QB.
    - Game total mezcla H2H full-game conservador y usa sigma dinamico sobre puntos del equipo.
- Validacion:
  - `node --check` OK en providers/projections tocados.
  - `docker compose up --build -d` OK.
  - `/api/health`: `status=ok`, `service=danny-pick`.
  - `/api/nba/analyze?refresh=1`, `/api/wnba/analyze?refresh=1`, `/api/nfl/analyze?refresh=1`: HTTP 200. En la fecha actual no habia juegos en ventana, por eso `games=0`, `picks=0`.
  - Prueba controlada de proyecciones confirma uso de `defRtg`, `ptsAllowedPerGame`, `yardsAllowedPerGame` y `h2h.averageTotal`.
  - Logs del contenedor filtrados por errores fuertes sin coincidencias.
