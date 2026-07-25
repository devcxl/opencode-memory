---
id: T3
title: "Worker API — /api/instructions CRUD"
status: pending
phase: P1
dependencies: [T1]
batch: 2
tags: [worker, api, crud]
estimated_hours: 1.5
---

# T3: Worker API — /api/instructions CRUD

## 目标

实现 instructions 表的完整 CRUD API。

## 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/instructions` | 创建/更新（upsert by id） |
| GET | `/api/instructions` | 列表（支持 type/scope/project_id 过滤） |
| GET | `/api/instructions/:id` | 获取单条 |
| DELETE | `/api/instructions/:id` | 删除 |

## Acceptance

- [ ] POST 创建支持指定 type / scope / path_pattern / priority
- [ ] GET 列表支持 type 过滤（identity/rule/workflow）
- [ ] GET 列表支持 scope + project_id 过滤
- [ ] DELETE 软删除（archived=1）
- [ ] 写入时触发 Vectorize 索引（source_table='instructions'）

## 产出

- `worker/src/services/instruction-service.ts`
- `worker/src/index.ts`（路由注册）

## 测试

```bash
cd worker && bun test tests/instruction-api.test.ts
```
