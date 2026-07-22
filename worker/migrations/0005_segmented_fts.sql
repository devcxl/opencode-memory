-- Migration 0005: 引入 text_fts 列支持中文分词
-- 1. 为 memories 表增加 text_fts 列，存储分词后的文本
-- 2. 重建 FTS5 虚拟表，基于 text_fts 列
-- 3. 重建触发器

-- 1. 增加 text_fts 列
ALTER TABLE memories ADD COLUMN text_fts TEXT NOT NULL DEFAULT '';

-- 2. 删除旧的 FTS 触发器和虚拟表
DROP TRIGGER IF EXISTS memories_fts_ai;
DROP TRIGGER IF EXISTS memories_fts_ad;
DROP TRIGGER IF EXISTS memories_fts_au;
DROP TABLE IF EXISTS memories_fts;

-- 3. 创建新的 FTS5 虚拟表
CREATE VIRTUAL TABLE memories_fts USING fts5(
  memory_id UNINDEXED,
  user_id UNINDEXED,
  kind UNINDEXED,
  text_fts,
  tokenize = 'unicode61'
);

-- 4. 触发器：自动同步 memories → memories_fts（使用 text_fts 列）
CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (memory_id, user_id, kind, text_fts)
  VALUES (new.id, new.user_id, new.kind, new.text_fts);
END;

CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
  DELETE FROM memories_fts WHERE memory_id = old.id;
END;

CREATE TRIGGER memories_fts_au AFTER UPDATE ON memories BEGIN
  DELETE FROM memories_fts WHERE memory_id = old.id;
  INSERT INTO memories_fts (memory_id, user_id, kind, text_fts)
  VALUES (new.id, new.user_id, new.kind, new.text_fts);
END;
