---
name: "D1 Migration 0006"
phase: 2
depends_on: ["T2", "T6"]
labels: ["backend"]
worktree_root: ".worktree/t7-d1-migration-0006/"
test_commands:
  - "pnpm --filter @cfmem/api typecheck"
verify_commands:
  - "ls worker/migrations/0006_extend_for_opencode.sql"
  - "wrangler d1 migrations list memory-db"
tdd:
  mode: strict
  min_cycles: 1
acceptance:
  - criteria: "0006_extend_for_opencode.sql 包含 ALTER TABLE ADD COLUMN project_id, file_type, date"
    verification_type: manual
  - criteria: "migration 包含新增索引 idx_memories_project 和 idx_memories_date"
    verification_type: manual
  - criteria: "wrangler d1 migrations apply memory-db 执行成功"
    verification_type: manual
  - criteria: "旧数据自动获得 DEFAULT 值（project_id='', file_type='memory', date=''）"
    verification_type: manual
---

# T7: D1 Migration 0006

**阶段**：Phase 2 — Worker 扩展
**依赖**：T2（worker 迁入）, T6（tsconfig 统一）
**标签**：`backend`
**预估**：0.5h

## 目标

创建 D1 migration 0006，在 `memories` 表上新增 `project_id`、`file_type`、`date` 三列，支持插件远程模式的数据隔离。

## 背景

插件远程模式下需要按 project_id（项目隔离）、file_type（memory/identity/user/daily 文件类型）、date（daily 日志日期）过滤记忆数据。ADM-004 确认使用 `ALTER TABLE ADD COLUMN` + 索引方案。

## 实现步骤

### 1. 创建 migration 文件

`worker/migrations/0006_extend_for_opencode.sql`：

```sql
-- Migration 0006: Extend schema for opencode-memory plugin integration
-- Adds project_id, file_type, date columns for memory file isolation

ALTER TABLE memories ADD COLUMN project_id TEXT NOT NULL DEFAULT '';
ALTER TABLE memories ADD COLUMN file_type TEXT NOT NULL DEFAULT 'memory';
ALTER TABLE memories ADD COLUMN date TEXT DEFAULT '';

-- Index for filtering by user + project + file_type (most common query pattern)
CREATE INDEX idx_memories_project ON memories(user_id, project_id, file_type);

-- Index for daily log queries (filter by user + date)
CREATE INDEX idx_memories_date ON memories(user_id, date);
```

### 2. 执行 migration

```bash
cd worker && wrangler d1 migrations apply memory-db
```

### 3. 验证

- 查询已有记录的 `project_id`、`file_type` 应为 DEFAULT 值
- 写入一条带新字段的记录，确认字段正确存储

## 字段映射

| opencode-memory 概念 | D1 字段 | 值示例 |
|----------|---------|--------|
| MEMORY.md（全局） | file_type='memory', project_id='' | — |
| MEMORY.md（项目） | file_type='memory', project_id='devcxl/opencode-memory' | — |
| IDENTITY.md | file_type='identity', project_id='' | — |
| USER.md | file_type='user', project_id='' | — |
| daily/2026-07-22.md（全局） | file_type='daily', project_id='', date='2026-07-22' | — |
| daily/2026-07-22.md（项目） | file_type='daily', project_id='devcxl/opencode-memory', date='2026-07-22' | — |

## 文件变更

| 操作 | 文件 |
|------|------|
| 🆕 新增 | `worker/migrations/0006_extend_for_opencode.sql` |

## 注意事项

- D1 的 `ALTER TABLE ADD COLUMN` 支持 `NOT NULL DEFAULT`，旧数据自动获得默认值，向后兼容
- Vectorize metadata filter 的扩展在 T8（Worker API 扩展）中处理，因为需要同步更新 `indexing.ts` 和 Vectorize 元数据
- 如果 Vectorize index 需要重建以支持新 metadata filter 字段，记录重建步骤但不在此任务执行
