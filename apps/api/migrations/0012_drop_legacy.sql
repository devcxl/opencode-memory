-- Migration 0012: 删除旧表，memories_v2 更名为 memories，重建统一 FTS
-- 旧 memories 表数据已在 0008 迁入结构化表、0011 迁入 memories_v2，此处安全删除。

-- ============================================================
-- 1. 删除旧表（触发器随表删除）
-- ============================================================
DROP TABLE IF EXISTS memories_fts;
DROP TABLE IF EXISTS memories;
DROP TABLE IF EXISTS learnings_fts;
DROP TABLE IF EXISTS learnings;
DROP TABLE IF EXISTS dailies_fts;
DROP TABLE IF EXISTS dailies;
DROP TABLE IF EXISTS instructions;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS extraction_log;
DROP TABLE IF EXISTS rate_limits;

-- ============================================================
-- 2. memories_v2 → memories
-- ============================================================
ALTER TABLE memories_v2 RENAME TO memories;

-- ============================================================
-- 3. 统一 FTS5 虚拟表 + 同步触发器（单表单套，杜绝 0007 式静默失效）
-- ============================================================
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content_fts,
  id UNINDEXED,
  user_id UNINDEXED,
  tokenize = 'unicode61'
);

CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (content_fts, id, user_id)
  VALUES (COALESCE(new.content_fts, ''), new.id, new.user_id);
END;

CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
  DELETE FROM memories_fts WHERE id = old.id;
END;

CREATE TRIGGER memories_fts_au AFTER UPDATE ON memories BEGIN
  DELETE FROM memories_fts WHERE id = old.id;
  INSERT INTO memories_fts (content_fts, id, user_id)
  VALUES (COALESCE(new.content_fts, ''), new.id, new.user_id);
END;

-- 回填存量数据（分词内容沿用 0011 搬运值，/api/reindex 会按当前分词器重建）
INSERT INTO memories_fts (content_fts, id, user_id)
SELECT COALESCE(content_fts, ''), id, user_id FROM memories;
