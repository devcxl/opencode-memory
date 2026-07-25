---
id: T14
title: "旧数据迁移脚本"
status: pending
phase: P5
dependencies: [T8, T9]
batch: 7
tags: [migration, data]
estimated_hours: 1.5
---

# T14: 旧数据迁移脚本

## 目标

将旧 `memories` 表中的数据迁移到新的三表结构。

## 映射规则

| 旧 file_type | 新 category | 新 sub_type | 说明 |
|-------------|-------------|-------------|------|
| identity | instruction | identity | AI 身份 |
| memory | learning | knowledge | 项目知识（默认） |
| user | learning | preference | 用户偏好 |
| daily | daily | — | 流水账 |

## 迁移脚本

```sql
-- instructions
INSERT INTO instructions (id, user_id, type, title, content, scope, created_at)
SELECT id, user_id, 'identity', 'AI 身份', text, 'global', created_at
FROM memories WHERE file_type = 'identity' AND archived = 0;

-- learnings
INSERT INTO learnings (id, user_id, type, title, content, content_fts, scope, project_id, created_at)
SELECT id, user_id,
  CASE WHEN file_type = 'user' THEN 'preference' ELSE 'knowledge' END,
  '记忆条目', text, text_fts, 'global', project_id, created_at
FROM memories WHERE file_type IN ('memory', 'user') AND archived = 0;

-- dailies
INSERT INTO dailies (id, user_id, content, content_fts, project_id, date, created_at)
SELECT id, user_id, text, text_fts, project_id, date, created_at
FROM memories WHERE file_type = 'daily' AND archived = 0;
```

## Acceptance

- [ ] 迁移脚本可在 Worker 端执行
- [ ] 迁移后旧 memories 表数据完整（只读保留）
- [ ] 迁移不丢失任何行
- [ ] 提供回滚脚本

## 产出

- `worker/migrations/0008-data-migration.sql`

## 测试

```bash
cd worker && bun test tests/migration.test.ts
```
