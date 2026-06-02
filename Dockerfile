FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY src ./src
COPY public ./public
COPY 001_create_picks_tracker.sql ./
COPY 002_pick_telegram_sent.sql ./
COPY 003_backtesting_clv.sql ./
COPY 004_picks_history.sql ./
COPY 005_analysis_cache.sql ./

EXPOSE 3000

CMD ["node", "server.js"]

