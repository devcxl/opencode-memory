---
id: T10
title: "memory 工具 — 新增 category/sub_type/path_pattern 参数"
status: pending
phase: P2
dependencies: [T9]
batch: 5
tags: [plugin, tool, schema]
estimated_hours: 1.5
---

# T10: memory 工具 — 新增 category/sub_type/path_pattern 参数

## 目标

`memory` 工具 schema 新增结构化参数，同时保留旧参数兼容。

## 新增参数

```typescript
{
  category?:      'instruction' | 'learning' | 'daily',
  sub_type?:      'identity' | 'rule' | 'workflow' | 'preference' | 'episodic' | 'knowledge',
  scope?:         'global' | 'project' | 'user' | 'local',
  path_pattern?:  string,        // glob 模式
  title?:         string,        // instruction/learning 标题
}
```

## 新 action

- `extract` — 触发 daily → learning 提取

## Acceptance

- [ ] 旧参数（target/mode/date/scope）照常工作
- [ ] 新参数与旧参数可混用（新参数优先）
- [ ] `category: "instruction" + sub_type: "rule"` 正确路由
- [ ] `category: "learning" + sub_type: "episodic"` 正确路由
- [ ] `path_pattern` 写入时存储到 instruction.rule
- [ ] `memory --action extract --date 2026-07-22` 触发提取

## 产出

- `src/index.ts`（tool schema + execute）
- `src/handlers/handleWrite.ts`（category/sub_type 路由）
- `src/handlers/handleRead.ts`（同上）
- `src/handlers/handleExtract.ts`（新增）

## 测试

```bash
bun test tests/high-risk.test.ts
```
