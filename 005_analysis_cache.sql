CREATE TABLE IF NOT EXISTS analysis_cache_snapshots (
  cache_key        TEXT        NOT NULL,
  payload          JSONB       NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL,
  stale_until      TIMESTAMPTZ NOT NULL,
  stored_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cache_key)
);

-- Indice para limpiar snapshots expirados eficientemente
CREATE INDEX IF NOT EXISTS idx_analysis_cache_stale_until
  ON analysis_cache_snapshots (stale_until);

COMMENT ON TABLE analysis_cache_snapshots IS
  'Snapshots de analisis por deporte/fecha. Permite recuperar el ultimo snapshot valido tras reiniciar el contenedor. TTL gestionado por la aplicacion.';
