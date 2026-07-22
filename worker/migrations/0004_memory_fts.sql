-- Migration 0004: 移除 chunk 层，FTS 直接基于 memories 表
-- 1. 删除旧的 chunk 相关触发器、FTS 虚拟表和表
DROP TRIGGER IF EXISTS memory_chunks_ai;
DROP TRIGGER IF EXISTS memory_chunks_ad;
DROP TRIGGER IF EXISTS memory_chunks_au;
DROP TABLE IF EXISTS memory_chunks_fts;
DROP TABLE IF EXISTS memory_chunks;

-- 2. 创建基于 memories 的 FTS5 虚拟表
CREATE VIRTUAL TABLE memories_fts USING fts5(
  memory_id UNINDEXED,
  user_id UNINDEXED,
  kind UNINDEXED,
  text,
  tokenize = 'unicode61'
);

-- 3. 触发器：自动同步 memories → memories_fts
CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (memory_id, user_id, kind, text)
  VALUES (new.id, new.user_id, new.kind, new.text);
END;

CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
  DELETE FROM memories_fts WHERE memory_id = old.id;
END;

CREATE TRIGGER memories_fts_au AFTER UPDATE ON memories BEGIN
  DELETE FROM memories_fts WHERE memory_id = old.id;
  INSERT INTO memories_fts (memory_id, user_id, kind, text)
  VALUES (new.id, new.user_id, new.kind, new.text);
END;

-- 4. 回填：将现有 memories 数据灌入 FTS 索引
INSERT INTO memories_fts (memory_id, user_id, kind, text)
SELECT id, user_id, kind, text FROM memories WHERE archived = 0;
