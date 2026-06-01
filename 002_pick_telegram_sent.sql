-- Registro de notificaciones Telegram enviadas (se borra al resolver el pick; el pick queda en historial)

CREATE TABLE IF NOT EXISTS pick_telegram_sent (
  pick_date DATE NOT NULL,
  identity_key TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('verde', 'amarillo')),
  pick_id BIGINT REFERENCES picks(id) ON DELETE CASCADE,
  completeness SMALLINT NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pick_date, identity_key, tier)
);

CREATE INDEX IF NOT EXISTS idx_pick_telegram_sent_pick_id ON pick_telegram_sent (pick_id);
