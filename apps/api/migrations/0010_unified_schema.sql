-- Migration 0010: v2 统一记忆 Schema
-- 新增：users / api_tokens / memory_entities / memory_links / job_runs / memories_v2
-- 旧 memories 等表在 0011 数据迁移、0012 删除后，memories_v2 更名为 memories。

-- ============================================================
-- 1. users（GitHub OAuth 登录）
-- ============================================================
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  github_id     INTEGER NOT NULL UNIQUE,
  login         TEXT NOT NULL,
  name          TEXT,
  avatar_url    TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

-- ============================================================
-- 2. api_tokens（个人中心生成的 Bearer Token，仅存哈希）
-- ============================================================
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);

CREATE INDEX idx_api_tokens_user ON api_tokens(user_id, revoked_at);

-- ============================================================
-- 3. memories_v2（统一记忆表，迁移完成后更名为 memories）
--    type: daily（流水原文）| fact（原子事实）| instruction（规则/身份/工作流）| digest（每日总结）
-- ============================================================
CREATE TABLE memories_v2 (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('daily', 'fact', 'instruction', 'digest')),
  subtype     TEXT NOT NULL DEFAULT '',   -- instruction: identity/rule/workflow；fact: preference/episodic/knowledge
  title       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL,
  content_fts TEXT NOT NULL DEFAULT '',   -- Intl.Segmenter 分词后文本（FTS5 索引列）
  scope       TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'project')),
  project_id  TEXT NOT NULL DEFAULT '',
  date        TEXT NOT NULL DEFAULT '',   -- YYYY-MM-DD（daily/digest 必有）
  tags        TEXT NOT NULL DEFAULT '[]', -- JSON 数组
  source      TEXT NOT NULL DEFAULT 'agent' CHECK (source IN ('agent', 'user', 'digest', 'system')),
  source_ids  TEXT,                       -- JSON 数组：digest → 当天 daily 的 id 列表
  meta        TEXT NOT NULL DEFAULT '{}', -- JSON 扩展（confidence、path_pattern 等）
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER,
  digested_at INTEGER,                    -- daily 被总结的时间（幂等标记）
  archived    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_mem_list    ON memories_v2(user_id, type, archived, created_at DESC);
CREATE INDEX idx_mem_project ON memories_v2(user_id, project_id, archived, created_at DESC);
CREATE INDEX idx_mem_date    ON memories_v2(user_id, type, date);

-- 未消费 daily 的查询（digest cron 的分组扫描）
CREATE INDEX idx_mem_undigested ON memories_v2(user_id, date)
  WHERE type = 'daily' AND digested_at IS NULL AND archived = 0;

-- 每用户 × 每项目 × 每天只允许一条 digest（cron 幂等的数据库级保证）
CREATE UNIQUE INDEX idx_digest_once ON memories_v2(user_id, project_id, date)
  WHERE type = 'digest' AND archived = 0;

-- ============================================================
-- 4. memory_entities（分面实体表：精确过滤维度，如 region=华北）
-- ============================================================
CREATE TABLE memory_entities (
  memory_id TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (memory_id, key, value)
);

CREATE INDEX idx_entities_lookup ON memory_entities(user_id, key, value);

-- ============================================================
-- 5. memory_links（记忆演化链：supersedes / contradicts / references / derived_from）
-- ============================================================
CREATE TABLE memory_links (
  from_id    TEXT NOT NULL,   -- 新记录
  to_id      TEXT NOT NULL,   -- 被指向的旧记录
  relation   TEXT NOT NULL CHECK (relation IN ('supersedes', 'contradicts', 'references', 'derived_from')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, relation)
);

CREATE INDEX idx_links_to ON memory_links(to_id, relation);

-- ============================================================
-- 6. job_runs（定时任务/后台任务执行历史，取代 extraction_log）
-- ============================================================
CREATE TABLE job_runs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT,
  job          TEXT NOT NULL,   -- digest | reindex | ...
  status       TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  detail       TEXT,            -- JSON：条数统计 / 错误信息
  started_at   INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX idx_job_runs_job ON job_runs(job, started_at DESC);
