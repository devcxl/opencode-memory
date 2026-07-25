---
id: T4
title: "Worker API — /api/learnings CRUD"
status: pending
phase: P1
dependencies: [T1]
batch: 2
tags: [worker, api, crud]
estimated_hours: 1.5
---

# T4: Worker API — /api/learnings CRUD

## 目标

实现 learnings 表的完整 CRUD API。

## 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/learnings` | 创建/更新 |
| GET | `/api/learnings` | 列表（支持 type/source/project_id） |
| GET | `/api/learnings/:id` | 获取单条 |
| DELETE | `/api/learnings/:id` | 删除 |

## Acceptance

- [ ] POST 创建支持 type（preference/episodic/knowledge）/ source / confidence
- [ ] GET 列表支持 type 过滤
- [ ] GET 列表支持 source 过滤（manual/extracted/imported）
- [ ] 每次 search 召回时更新 recall_count + last_recalled_at
- [ ] 写入时触发 Vectorize 索引（source_table='learnings'）

## 产出

- `worker/src/services/learning-service.ts`
- `worker/src/index.ts`（路由注册）

## 测试

```bash
cd worker && bun test tests/learning-api.test.ts
```
