---
id: T7
title: "Worker API — /api/stats 多表聚合"
status: pending
phase: P1
dependencies: [T3, T4]
batch: 3
tags: [worker, api, stats]
estimated_hours: 1
---

# T7: Worker API — /api/stats 多表聚合

## 目标

改造 `/api/stats` 端点，从单表统计改为多表聚合。

## 返回值

```json
{
  "instructions": { "total": 5, "by_type": { "identity": 1, "rule": 3, "workflow": 1 } },
  "learnings": { "total": 120, "by_type": { "preference": 15, "episodic": 45, "knowledge": 60 } },
  "dailies": { "total": 300, "by_month": { "2026-07": 156, "2026-06": 144 } },
  "projects": [{ "id": "devcxl/opencode-memory", "instruction_count": 3, "learning_count": 80 }]
}
```

## Acceptance

- [ ] 三表分别统计
- [ ] 支持 project_id 过滤
- [ ] 响应时间 < 100ms

## 测试

```bash
cd worker && bun test tests/stats-api.test.ts
```
