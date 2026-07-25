---
id: T2
title: "跨表搜索引擎"
status: pending
phase: P0
dependencies: [T1]
batch: 2
tags: [worker, search, vectorize, fts]
estimated_hours: 2
---

# T2: 跨表搜索引擎

## 目标

实现跨 instructions / learnings / dailies 三表的统一语义搜索。

## 方案

1. Vectorize 索引时 metadata 中保存 `source_table` 字段
2. 搜索时 Vectorize 返回带 source_table 的结果
3. 按 source_table 分组 → 批量 SQL 查对应表获取完整 record
4. 与 FTS 结果做 RRF 融合

## Acceptance

- [ ] `POST /api/memories/search` 返回 instructions + learnings + dailies 的混合结果
- [ ] 支持按 category/type/scope/project_id 过滤
- [ ] RRF 融合 Vectorize + FTS 结果
- [ ] 搜索结果包含 source_table 和 source_id

## 产出

- `worker/src/search/cross-table.ts`
- `worker/src/services/memory-service.ts` (searchMemories 改造)

## 测试

```bash
cd worker && bun test tests/search-cross-table.test.ts
```
