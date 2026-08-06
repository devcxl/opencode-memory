-- Migration 0001: Initial schema
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('short','long')),
  text TEXT NOT NULL,
  tags TEXT,
  source TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  consolidated_at INTEGER,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_mem_user_created ON memories(user_id, created_at DESC);
CREATE INDEX idx_mem_expires ON memories(expires_at);
