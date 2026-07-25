---
id: T5
title: "Worker API — /api/dailies + /api/extract"
status: pending
phase: P1
dependencies: [T1]
batch: 2
tags: [worker, api, crud, extract]
estimated_hours: 2
---

# T5: Worker API — /api/dailies + /api/extract

## 目标

实现流水账写入/查询 API 和提取触发端点。

## 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/dailies` | 写入流水账 |
| GET | `/api/dailies` | 按 date + project_id 查询 |
| DELETE | `/api/dailies/:id` | 删除 |
| --- | --- | --- |
| POST | `/api/extract` | 触发提取任务 |
| GET | `/api/extract/status` | 查询提取状态 |

## Acceptance

- [ ] POST dailies 支持 date/project_id 参数
- [ ] GET dailies 返回指定日期所有条目（按时间排序）
- [ ] POST extract 接受 date 参数，创建 extraction_log 并后台执行
- [ ] GET extract/status 返回最新任务的进度
- [ ] dailies 写入触发 Vectorize 索引（source_table='dailies'）

## 产出

- `worker/src/services/daily-service.ts`
- `worker/src/services/extraction-service.ts`
- `worker/src/index.ts`（路由注册）

## 测试

```bash
cd worker && bun test tests/daily-api.test.ts
```
