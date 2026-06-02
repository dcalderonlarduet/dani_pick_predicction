-- 005_analysis_cache.sql
-- Tabla para persistir snapshots de analisis entre reinicios del contenedor.
-- La cache en memoria se reconstruye desde aqui al arrancar.

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

-- Comentario de uso
COMMENT ON TABLE analysis_cache_snapshots IS
  'Snapshots de analisis por deporte/fecha. Permite recuperar el ultimo snapshot valido tras un reinicio del contenedor. TTL gestionado por la aplicacion.';
