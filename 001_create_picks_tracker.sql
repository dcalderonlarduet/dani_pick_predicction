-- DANY PICKS Tracker schema
-- Run once against PostgreSQL.

CREATE TABLE IF NOT EXISTS picks (
  id BIGSERIAL PRIMARY KEY,
  pick_date DATE NOT NULL,
  sport TEXT NOT NULL,
  partido TEXT NOT NULL,
  pick_label TEXT NOT NULL,
  mercado TEXT,
  cuota NUMERIC(6,2),
  casa TEXT,
  ev_pct NUMERIC(6,2),
  confianza INTEGER,
  estado_color TEXT DEFAULT 'verde',
  senal_doble BOOLEAN DEFAULT FALSE,
  stake NUMERIC(10,2) DEFAULT 10.00,
  resultado TEXT DEFAULT 'pendiente',
  ganancia_neta NUMERIC(10,2),
  hora_partido TEXT,
  liga TEXT,
  notas TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bankroll (
  id BIGSERIAL PRIMARY KEY,
  bankroll_inicial NUMERIC(10,2) NOT NULL DEFAULT 100.00,
  bankroll_actual NUMERIC(10,2) NOT NULL DEFAULT 100.00,
  stake_default NUMERIC(10,2) NOT NULL DEFAULT 10.00,
  stake_tipo TEXT NOT NULL DEFAULT 'fijo',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO bankroll (bankroll_inicial, bankroll_actual, stake_default, stake_tipo)
SELECT 100.00, 100.00, 10.00, 'fijo'
WHERE NOT EXISTS (SELECT 1 FROM bankroll);

CREATE INDEX IF NOT EXISTS idx_picks_date ON picks (pick_date DESC);
CREATE INDEX IF NOT EXISTS idx_picks_sport ON picks (sport);
CREATE INDEX IF NOT EXISTS idx_picks_resultado ON picks (resultado);
CREATE INDEX IF NOT EXISTS idx_picks_date_sport ON picks (pick_date DESC, sport);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS picks_updated_at ON picks;
CREATE TRIGGER picks_updated_at
  BEFORE UPDATE ON picks
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS bankroll_updated_at ON bankroll;
CREATE TRIGGER bankroll_updated_at
  BEFORE UPDATE ON bankroll
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE VIEW resumen_diario AS
SELECT
  pick_date,
  COUNT(*) AS total_picks,
  COUNT(*) FILTER (WHERE resultado = 'ganado') AS ganados,
  COUNT(*) FILTER (WHERE resultado = 'perdido') AS perdidos,
  COUNT(*) FILTER (WHERE resultado = 'pendiente') AS pendientes,
  COUNT(*) FILTER (WHERE resultado = 'void') AS voids,
  ROUND(
    COUNT(*) FILTER (WHERE resultado = 'ganado')::NUMERIC /
    NULLIF(COUNT(*) FILTER (WHERE resultado IN ('ganado', 'perdido')), 0) * 100,
    1
  ) AS pct_acierto,
  COALESCE(SUM(ganancia_neta) FILTER (WHERE resultado != 'pendiente'), 0) AS ganancia_neta_dia,
  COALESCE(
    SUM(stake) FILTER (WHERE resultado NOT IN ('pendiente', 'void')),
    0
  ) AS total_apostado,
  ROUND(
    COALESCE(SUM(ganancia_neta), 0) /
    NULLIF(COALESCE(SUM(stake) FILTER (WHERE resultado NOT IN ('pendiente', 'void')), 0), 0) * 100,
    2
  ) AS roi_pct
FROM picks
GROUP BY pick_date
ORDER BY pick_date DESC;

CREATE OR REPLACE VIEW resumen_por_deporte AS
SELECT
  sport,
  COUNT(*) AS total_picks,
  COUNT(*) FILTER (WHERE resultado = 'ganado') AS ganados,
  COUNT(*) FILTER (WHERE resultado = 'perdido') AS perdidos,
  ROUND(
    COUNT(*) FILTER (WHERE resultado = 'ganado')::NUMERIC /
    NULLIF(COUNT(*) FILTER (WHERE resultado IN ('ganado', 'perdido')), 0) * 100,
    1
  ) AS pct_acierto,
  COALESCE(SUM(ganancia_neta), 0) AS ganancia_neta_total,
  ROUND(
    COALESCE(SUM(ganancia_neta), 0) /
    NULLIF(COALESCE(SUM(stake) FILTER (WHERE resultado NOT IN ('pendiente', 'void')), 0), 0) * 100,
    2
  ) AS roi_pct
FROM picks
WHERE resultado != 'pendiente'
GROUP BY sport;
