-- Migration 0008: Data migration from old memories table to structured tables
-- Maps file_type to new category/sub_type structure.
-- The old memories table is preserved read-only for 1 month.

-- ============================================================
-- Instructions (identity only from old schema)
-- ============================================================
INSERT OR IGNORE INTO instructions (id, user_id, type, title, content, scope, tags, created_at, archived)
SELECT
  id,
  user_id,
  'identity',
  'AI 身份',
  text,
  'global',
  tags,
  created_at,
  archived
FROM memories
WHERE file_type = 'identity' AND kind = 'long' AND archived = 0;

-- ============================================================
-- Learnings: preference (from old user file_type)
-- ============================================================
INSERT OR IGNORE INTO learnings (id, user_id, type, title, content, content_fts, scope, project_id, source, tags, created_at, archived)
SELECT
  id,
  user_id,
  'preference',
  '用户偏好',
  text,
  text_fts,
  'global',
  project_id,
  'manual',
  tags,
  created_at,
  archived
FROM memories
WHERE file_type = 'user' AND kind = 'long' AND archived = 0;

-- ============================================================
-- Learnings: knowledge (from old memory file_type)
-- ============================================================
INSERT OR IGNORE INTO learnings (id, user_id, type, title, content, content_fts, scope, project_id, source, tags, created_at, archived)
SELECT
  id,
  user_id,
  'knowledge',
  '记忆条目',
  text,
  text_fts,
  CASE WHEN project_id = '' THEN 'global' ELSE 'project' END,
  project_id,
  'manual',
  tags,
  created_at,
  archived
FROM memories
WHERE file_type = 'memory' AND kind = 'long' AND archived = 0;

-- ============================================================
-- Dailies
-- ============================================================
INSERT OR IGNORE INTO dailies (id, user_id, content, content_fts, project_id, date, tags, created_at, archived)
SELECT
  id,
  user_id,
  text,
  text_fts,
  project_id,
  COALESCE(date, ''),
  tags,
  created_at,
  archived
FROM memories
WHERE file_type = 'daily' AND kind = 'long' AND archived = 0;

-- ============================================================
-- Project stats (from migrated data)
-- ============================================================
INSERT OR IGNORE INTO projects (id, user_id, instruction_count, learning_count, daily_count, last_active_at, created_at)
SELECT
  project_id,
  user_id,
  0 AS instruction_count,
  COUNT(*) AS learning_count,
  0 AS daily_count,
  MAX(created_at) AS last_active_at,
  MIN(created_at) AS created_at
FROM learnings
WHERE project_id != ''
GROUP BY project_id, user_id
UNION ALL
SELECT
  project_id,
  user_id,
  0 AS instruction_count,
  0 AS learning_count,
  COUNT(*) AS daily_count,
  MAX(created_at) AS last_active_at,
  MIN(created_at) AS created_at
FROM dailies
WHERE project_id != ''
GROUP BY project_id, user_id;
