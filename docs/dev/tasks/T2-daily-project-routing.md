---
id: T2
title: 项目级 daily 日志路由
depends_on: [T1]
files:
  - src/memory/MemoryPaths.ts
  - src/memory/MemoryManager.ts
  - src/handlers/handleWrite.ts
---

# T2: 项目级 daily 日志路由

## 目标
`target=daily` 在 project scope 下写入 `projects/{id}/daily/YYYY-MM-DD.md`

## 改动
1. `MemoryPaths.ts` — 新增 `projectDailyPath(projectId, date)`
2. `MemoryManager.ts` `getPathForTarget` — daily 分支按 project 参数路由
3. `handleWrite.ts` — `ensureProjectDirs` 条件扩展为 `target === "memory" || target === "daily"`

## 验证
- 项目 daily 文件路径正确
- 索引路由到 ProjectStore（现有逻辑已支持）
- git 提交追踪正确
- 全局 daily 不受影响
