-- Backtesting + Closing Line Value (CLV)
-- Run once against PostgreSQL after 001_create_picks_tracker.sql

ALTER TABLE picks ADD COLUMN IF NOT EXISTS prob_model NUMERIC(8,5);
ALTER TABLE picks ADD COLUMN IF NOT EXISTS linea_apuesta NUMERIC(8,2);
ALTER TABLE picks ADD COLUMN IF NOT EXISTS linea_cierre NUMERIC(8,2);
ALTER TABLE picks ADD COLUMN IF NOT EXISTS cuota_cierre NUMERIC(6,2);
ALTER TABLE picks ADD COLUMN IF NOT EXISTS clv_value NUMERIC(8,3);
ALTER TABLE picks ADD COLUMN IF NOT EXISTS edge_pct NUMERIC(8,5);
ALTER TABLE picks ADD COLUMN IF NOT EXISTS data_quality NUMERIC(4,2);
ALTER TABLE picks ADD COLUMN IF NOT EXISTS pick_side TEXT;
ALTER TABLE picks ADD COLUMN IF NOT EXISTS market_key TEXT;
ALTER TABLE picks ADD COLUMN IF NOT EXISTS ev_model NUMERIC(8,5);

CREATE TABLE IF NOT EXISTS pick_snapshots (
  id BIGSERIAL PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  sport TEXT NOT NULL,
  partido TEXT NOT NULL,
  market_key TEXT NOT NULL,
  pick_side TEXT NOT NULL,
  pick_label TEXT NOT NULL,
  linea NUMERIC(8,2),
  cuota NUMERIC(6,2),
  prob_model NUMERIC(8,5),
  prob_market NUMERIC(8,5),
  ev_model NUMERIC(8,5),
  edge_pct NUMERIC(8,5),
  data_quality NUMERIC(4,2),
  score INTEGER,
  estado_color TEXT,
  linea_cierre NUMERIC(8,2),
  cuota_cierre NUMERIC(6,2),
  clv_value NUMERIC(8,3),
  resultado TEXT DEFAULT 'pendiente',
  ganancia_unidad NUMERIC(8,3),
  value_gates JSONB,
  modelo_snapshot JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (snapshot_date, sport, partido, market_key, pick_side, linea)
);

CREATE INDEX IF NOT EXISTS idx_pick_snapshots_date ON pick_snapshots (snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_pick_snapshots_sport ON pick_snapshots (sport);
CREATE INDEX IF NOT EXISTS idx_pick_snapshots_resultado ON pick_snapshots (resultado);

CREATE OR REPLACE VIEW backtest_resumen AS
SELECT
  sport,
  COUNT(*) AS total_snapshots,
  COUNT(*) FILTER (WHERE resultado = 'ganado') AS ganados,
  COUNT(*) FILTER (WHERE resultado = 'perdido') AS perdidos,
  COUNT(*) FILTER (WHERE resultado = 'pendiente') AS pendientes,
  ROUND(
    COUNT(*) FILTER (WHERE resultado = 'ganado')::NUMERIC /
    NULLIF(COUNT(*) FILTER (WHERE resultado IN ('ganado', 'perdido')), 0) * 100,
    1
  ) AS pct_acierto,
  ROUND(AVG(clv_value) FILTER (WHERE clv_value IS NOT NULL), 3) AS clv_promedio,
  ROUND(AVG(ev_model) FILTER (WHERE ev_model IS NOT NULL), 4) AS ev_promedio,
  ROUND(AVG(data_quality) FILTER (WHERE data_quality IS NOT NULL), 2) AS dq_promedio,
  COALESCE(SUM(ganancia_unidad) FILTER (WHERE resultado != 'pendiente'), 0) AS unidades_neta
FROM pick_snapshots
GROUP BY sport
ORDER BY sport;

DROP TRIGGER IF EXISTS pick_snapshots_updated_at ON pick_snapshots;
CREATE TRIGGER pick_snapshots_updated_at
  BEFORE UPDATE ON pick_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
