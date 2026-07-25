-- Migration 0007: Structured memory multi-table schema
-- Replaces flat memories table with typed tables:
--   instructions — human-written rules, identity, workflows
--   learnings    — agent-accumulated knowledge, preferences, episodic
--   dailies      — raw daily log entries (source for extraction)
--   projects     — project registry with per-type counters
--   extraction_log — LLM extraction task audit trail
--
-- Vectorize index remains single-namespace with metadata.source_table discriminator
-- for cross-table unified semantic search.

-- ============================================================
-- 1. instructions
-- ============================================================
CREATE TABLE IF NOT EXISTS instructions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,

  type          TEXT NOT NULL CHECK (type IN ('identity', 'rule', 'workflow')),

  title         TEXT NOT NULL,
  content       TEXT NOT NULL,

  scope         TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'project', 'user', 'local')),
  project_id    TEXT DEFAULT '',
  path_pattern  TEXT,
  priority      INTEGER DEFAULT 0,
  tags          TEXT DEFAULT '[]',

  created_at    INTEGER NOT NULL,
  updated_at    INTEGER,
  archived      INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_instructions_user_type  ON instructions(user_id, type, archived);
CREATE INDEX IF NOT EXISTS idx_instructions_project    ON instructions(user_id, project_id, scope);
CREATE INDEX IF NOT EXISTS idx_instructions_path       ON instructions(path_pattern);


-- ============================================================
-- 2. learnings
-- ============================================================
CREATE TABLE IF NOT EXISTS learnings (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,

  type          TEXT NOT NULL CHECK (type IN ('preference', 'episodic', 'knowledge')),

  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  content_fts   TEXT,

  scope         TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'project', 'user')),
  project_id    TEXT DEFAULT '',

  source        TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'extracted', 'imported')),
  source_ids    TEXT,
  confidence    REAL DEFAULT 1.0,

  tags          TEXT DEFAULT '[]',
  recall_count  INTEGER DEFAULT 0,
  last_recalled_at INTEGER,

  created_at    INTEGER NOT NULL,
  updated_at    INTEGER,
  archived      INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_learnings_user_type   ON learnings(user_id, type, archived);
CREATE INDEX IF NOT EXISTS idx_learnings_project     ON learnings(user_id, project_id, scope);
CREATE INDEX IF NOT EXISTS idx_learnings_source      ON learnings(user_id, source);
CREATE INDEX IF NOT EXISTS idx_learnings_recall      ON learnings(user_id, recall_count, last_recalled_at);


-- ============================================================
-- 3. dailies
-- ============================================================
CREATE TABLE IF NOT EXISTS dailies (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,

  content       TEXT NOT NULL,
  content_fts   TEXT,

  project_id    TEXT DEFAULT '',
  date          TEXT NOT NULL,

  extracted     INTEGER DEFAULT 0,
  extracted_at  INTEGER,

  tags          TEXT DEFAULT '[]',
  created_at    INTEGER NOT NULL,
  archived      INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_dailies_user_date     ON dailies(user_id, date, archived);
CREATE INDEX IF NOT EXISTS idx_dailies_project       ON dailies(user_id, project_id, date);
CREATE INDEX IF NOT EXISTS idx_dailies_extracted     ON dailies(user_id, extracted, date);


-- ============================================================
-- 4. projects
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  name              TEXT,

  instruction_count INTEGER DEFAULT 0,
  learning_count    INTEGER DEFAULT 0,
  daily_count       INTEGER DEFAULT 0,
  last_active_at    INTEGER,

  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);


-- ============================================================
-- 5. extraction_log
-- ============================================================
CREATE TABLE IF NOT EXISTS extraction_log (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,

  started_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  daily_count     INTEGER DEFAULT 0,
  extracted_count INTEGER DEFAULT 0,

  status          TEXT DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  error           TEXT,

  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_extraction_log_user ON extraction_log(user_id, status);
