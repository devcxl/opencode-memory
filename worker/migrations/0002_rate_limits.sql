-- Migration 0002: Add rate limits table
CREATE TABLE IF NOT EXISTS rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  UNIQUE(user_id, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_user_window ON rate_limits(user_id, window_start);
