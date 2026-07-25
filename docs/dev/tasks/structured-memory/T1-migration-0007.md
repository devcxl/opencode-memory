---
id: T1
title: "D1 Migration 0007 — 结构化多表 Schema"
status: pending
phase: P0
dependencies: []
batch: 1
tags: [worker, d1, migration]
estimated_hours: 1.5
---

# T1: D1 Migration 0007 — 结构化多表 Schema

## 目标

在 Worker D1 中创建 instructions / learnings / dailies / projects / extraction_log 五张新表。

## Acceptance

- [ ] `instructions` 表存在，包含 type/scope/path_pattern/priority 字段
- [ ] `learnings` 表存在，包含 type/source/confidence/recall_count 字段
- [ ] `dailies` 表存在，包含 date/extracted 字段
- [ ] `projects` 表存在
- [ ] `extraction_log` 表存在
- [ ] 各表索引全部创建
- [ ] migration 可重复执行（IF NOT EXISTS）

## 产出

- `worker/migrations/0007-structured-tables.sql`

## 测试

```bash
cd worker && bun test --preload src/test-setup.ts
```
