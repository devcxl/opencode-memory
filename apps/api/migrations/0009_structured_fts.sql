-- Migration 0009: 结构化表 FTS 虚拟表 + 触发器
-- learnings / dailies 表在 0007 中只有 content_fts 列，从未创建 FTS5 虚拟表，
-- 导致 crossTableSearch 的关键词检索（learnings_fts / dailies_fts）静默失效。
-- 本迁移补齐虚拟表、同步触发器，并回填存量数据。
-- memories 表已有 memories_fts（0005），无需重建。

-- ============================================================
-- 1. learnings_fts
-- ============================================================
CREATE VIRTUAL TABLE IF NOT EXISTS learnings_fts USING fts5(
  content_fts,
  id UNINDEXED,
  user_id UNINDEXED,
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS learnings_fts_ai AFTER INSERT ON learnings BEGIN
  INSERT INTO learnings_fts (content_fts, id, user_id)
  VALUES (COALESCE(new.content_fts, ''), new.id, new.user_id);
END;

CREATE TRIGGER IF NOT EXISTS learnings_fts_ad AFTER DELETE ON learnings BEGIN
  DELETE FROM learnings_fts WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS learnings_fts_au AFTER UPDATE ON learnings BEGIN
  DELETE FROM learnings_fts WHERE id = old.id;
  INSERT INTO learnings_fts (content_fts, id, user_id)
  VALUES (COALESCE(new.content_fts, ''), new.id, new.user_id);
END;

INSERT INTO learnings_fts (content_fts, id, user_id)
SELECT COALESCE(content_fts, ''), id, user_id FROM learnings;

-- ============================================================
-- 2. dailies_fts
-- ============================================================
CREATE VIRTUAL TABLE IF NOT EXISTS dailies_fts USING fts5(
  content_fts,
  id UNINDEXED,
  user_id UNINDEXED,
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS dailies_fts_ai AFTER INSERT ON dailies BEGIN
  INSERT INTO dailies_fts (content_fts, id, user_id)
  VALUES (COALESCE(new.content_fts, ''), new.id, new.user_id);
END;

CREATE TRIGGER IF NOT EXISTS dailies_fts_ad AFTER DELETE ON dailies BEGIN
  DELETE FROM dailies_fts WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS dailies_fts_au AFTER UPDATE ON dailies BEGIN
  DELETE FROM dailies_fts WHERE id = old.id;
  INSERT INTO dailies_fts (content_fts, id, user_id)
  VALUES (COALESCE(new.content_fts, ''), new.id, new.user_id);
END;

INSERT INTO dailies_fts (content_fts, id, user_id)
SELECT COALESCE(content_fts, ''), id, user_id FROM dailies;
