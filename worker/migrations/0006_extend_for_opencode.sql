-- Migration 0006: Extend schema for opencode-memory plugin integration
-- Adds project_id, file_type, date columns for memory file-based isolation

ALTER TABLE memories ADD COLUMN project_id TEXT NOT NULL DEFAULT '';
ALTER TABLE memories ADD COLUMN file_type TEXT NOT NULL DEFAULT 'memory';
ALTER TABLE memories ADD COLUMN date TEXT DEFAULT '';

-- Index for filtering by user + project + file_type (common query pattern for project-scoped ops)
CREATE INDEX idx_memories_project ON memories(user_id, project_id, file_type);

-- Index for daily log queries (filter by user + date)
CREATE INDEX idx_memories_date ON memories(user_id, date);
