# DANY PICKS Prediction

Aplicacion web para analizar picks deportivos con valor real, cuotas trazables y control de resultados. El proyecto corre en Docker, expone una UI en `http://localhost:3000` y mantiene un backend Node.js con modulos por deporte.

## Modulos activos

- MLB: modelo propio, cuotas, comparacion de books, CLV/backtesting y settlement.
- Futbol: ligas filtradas, Poisson/contexto ESPN/API-Sports, value gates y control anti-ligas amateur.
- NBA, WNBA y NFL: scoreboards ESPN, politicas de odds por deporte y picks persistentes.
- Quiniela: boleto oficial, pronostico congelado al cierre, resultados vivos y ahorro de requests.
- Tracker: persistencia PostgreSQL, resolucion de picks y reportes por Telegram.

## Stack

- Node.js 20
- PostgreSQL 16
- Docker Compose
- Frontend estatico en `public/`
- Servicios de dominio en `src/services/`
- Providers en `src/providers/`

## Ejecucion local

1. Crea un `.env` tomando como base `.env.example`.
2. Levanta la app:

```bash
docker compose up --build -d
```

3. Abre:

- `http://localhost:3000`
- `http://localhost:3000/api/health`
- `http://localhost:3000/api/picks/stats`
- `http://localhost:3000/api/mlb/analyze`
- `http://localhost:3000/api/futbol/analyze`
- `http://localhost:3000/api/quiniela/analyze`

## Variables importantes

Las claves reales van solo en `.env`, nunca en GitHub.

- `ODDS_API_IO_KEY`
- `THE_ODDS_API_KEY`
- `MATCHSTAT_RAPIDAPI_KEY`
- `SPORTDEVS_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`

## Persistencia local excluida del repo

Estos archivos son estado/runtime y estan ignorados por Git:

- `.env`
- `src/data/picks-history.json`
- `src/data/quiniela-state.json`
- `src/data/community/public-splits.snapshot.json`
- logs, capturas, ZIPs, snapshots temporales y binarios locales.

## Comandos utiles

```bash
docker compose ps
docker compose logs --tail=120 danny-pick
npm run start
```

## Contexto tecnico

El handoff detallado vive en `AI_CONTEXT.md`.
