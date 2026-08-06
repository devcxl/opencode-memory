-- Migration 0003: Chunk-level storage and full-text search for keyword retrieval and RAG
CREATE TABLE memory_chunks (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('short', 'long')),
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  token_count INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_memory_chunks_user_created ON memory_chunks(user_id, created_at DESC);
CREATE INDEX idx_memory_chunks_user_memory ON memory_chunks(user_id, memory_id, chunk_index);
CREATE INDEX idx_memory_chunks_memory ON memory_chunks(memory_id, chunk_index);

CREATE VIRTUAL TABLE memory_chunks_fts USING fts5(
  chunk_id UNINDEXED,
  user_id UNINDEXED,
  memory_id UNINDEXED,
  kind UNINDEXED,
  text,
  normalized_text,
  tokenize = 'unicode61'
);

CREATE TRIGGER memory_chunks_ai AFTER INSERT ON memory_chunks BEGIN
  INSERT INTO memory_chunks_fts (chunk_id, user_id, memory_id, kind, text, normalized_text)
  VALUES (new.id, new.user_id, new.memory_id, new.kind, new.text, new.normalized_text);
END;

CREATE TRIGGER memory_chunks_ad AFTER DELETE ON memory_chunks BEGIN
  DELETE FROM memory_chunks_fts WHERE chunk_id = old.id;
END;

CREATE TRIGGER memory_chunks_au AFTER UPDATE ON memory_chunks BEGIN
  DELETE FROM memory_chunks_fts WHERE chunk_id = old.id;
  INSERT INTO memory_chunks_fts (chunk_id, user_id, memory_id, kind, text, normalized_text)
  VALUES (new.id, new.user_id, new.memory_id, new.kind, new.text, new.normalized_text);
END;
