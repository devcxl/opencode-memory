---
id: T8
title: "插件 Provider — category 路由到不同 API 端点"
status: pending
phase: P2
dependencies: [T3, T4, T5]
batch: 3
tags: [plugin, provider, http-client]
estimated_hours: 2
---

# T8: 插件 Provider — category 路由到不同 API 端点

## 目标

`RemoteFileStorageProvider` 和 `MemoryClient` 改为按 `category` 路由到正确的 Worker API 端点。

## 路由表

| category | write | read (list) | read (single) | delete |
|----------|-------|-------------|---------------|--------|
| instruction | POST /api/instructions | GET /api/instructions | GET /api/instructions/:id | DELETE /api/instructions/:id |
| learning | POST /api/learnings | GET /api/learnings | GET /api/learnings/:id | DELETE /api/learnings/:id |
| daily | POST /api/dailies | GET /api/dailies | — | DELETE /api/dailies/:id |

## Acceptance

- [ ] `MemoryClient` 新增 `writeInstruction()` / `listInstructions()` / `deleteInstruction()`
- [ ] `MemoryClient` 新增 `writeLearning()` / `listLearnings()` / `deleteLearning()`
- [ ] `MemoryClient` 新增 `writeDaily()` / `listDailies()` / `deleteDaily()`
- [ ] `RemoteFileStorageProvider` 按 path 中的 category 决定调用哪个 client 方法
- [ ] 搜索仍然走单入口 `POST /api/memories/search`
- [ ] 本地模式 `LocalFileStorageProvider` 不受影响

## Path 格式扩展

```
现有：file_type:date:project_id
新：  category:sub_type:scope:project_id:date
例：  instruction:identity:global::
      learning:episodic:project:devcxl/opencode-memory:
      daily::project:devcxl/opencode-memory:2026-07-22
```

## 产出

- `src/providers/remote/http-client.ts`（扩展）
- `src/providers/remote/FileStorageProvider.ts`（路由逻辑）

## 测试

```bash
bun test tests/remote-providers.test.ts
```
