-- Historial unificado de picks para backtesting (todos los deportes)
-- Ejecutar tras 001_create_picks_tracker.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS picks_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sport TEXT NOT NULL,
  league TEXT,
  game_id TEXT NOT NULL,
  game_date TIMESTAMPTZ,
  market TEXT NOT NULL,
  pick TEXT NOT NULL,
  line_taken NUMERIC(8,2),
  odds_taken NUMERIC(8,3),
  model_probability NUMERIC(8,5),
  implied_probability NUMERIC(8,5),
  edge NUMERIC(8,5),
  ev NUMERIC(8,5),
  confidence INTEGER,
  score INTEGER,
  data_quality NUMERIC(4,2),
  color TEXT,
  factors_used JSONB,
  line_movement JSONB,
  market_anchor_applied BOOLEAN DEFAULT FALSE,
  closing_line NUMERIC(8,2),
  closing_odds NUMERIC(8,3),
  result TEXT DEFAULT 'pending',
  profit_loss NUMERIC(10,4),
  clv NUMERIC(8,4),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_picks_history_sport ON picks_history (sport);
CREATE INDEX IF NOT EXISTS idx_picks_history_game ON picks_history (game_id);
CREATE INDEX IF NOT EXISTS idx_picks_history_result ON picks_history (result);
CREATE INDEX IF NOT EXISTS idx_picks_history_created ON picks_history (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_picks_history_color ON picks_history (color);
CREATE INDEX IF NOT EXISTS idx_picks_history_market ON picks_history (market);

CREATE UNIQUE INDEX IF NOT EXISTS idx_picks_history_dedupe
  ON picks_history (sport, game_id, market, pick, COALESCE(line_taken, -99999), DATE(created_at AT TIME ZONE 'UTC'));

DROP TRIGGER IF EXISTS picks_history_updated_at ON picks_history;
CREATE TRIGGER picks_history_updated_at
  BEFORE UPDATE ON picks_history
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
