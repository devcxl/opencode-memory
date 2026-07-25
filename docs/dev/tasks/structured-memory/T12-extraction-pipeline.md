---
id: T12
title: "LLM 提取 Pipeline — daily → learning"
status: pending
phase: P4
dependencies: [T5]
batch: 4
tags: [worker, extraction, llm]
estimated_hours: 3
---

# T12: LLM 提取 Pipeline — daily → learning

## 目标

实现从流水账中自动提取结构化学习记忆的 LLM pipeline。

## 流程

```
1. 扫描 dailies WHERE extracted=0 AND date < today
2. 批量 daily → LLM 分析（每次最多 10 条）
3. LLM 决策：每条 daily 是否提取、提取类型、内容摘要
4. 写入 learnings（source=extracted, source_ids=[...], confidence<1.0）
5. 标记 daily.extracted=1
```

## LLM Prompt

```
分析以下日志条目，决定是否提取为结构化记忆：

{entries}

对每条日志判断：
1. 包含 Bug 修复/解决方案 → 提取为 episodic
2. 包含用户偏好/习惯 → 提取为 preference  
3. 包含架构决策/约定 → 提取为 knowledge
4. 包含可复用工作流/流程 → 提取为 workflow
5. 不包含结构化信息 → 跳过

输出 JSON：
[
  { "daily_id": "...", "action": "extract", "type": "episodic", "title": "...", "content": "..." },
  { "daily_id": "...", "action": "skip" }
]
```

## Acceptance

- [ ] `/api/extract` POST 触发提取，返回 extraction_log id
- [ ] LLM 正确分类 daily 到不同 learnings type
- [ ] `confidence` < 1.0 标记自动提取
- [ ] daily.extracted 正确标记
- [ ] extraction_log 记录统计
- [ ] LLM 不可用时优雅降级（标记 failed，不影响写入）

## 产出

- `worker/src/services/extraction-service.ts`
- `worker/src/services/extraction-llm.ts`

## 测试

```bash
cd worker && bun test tests/extraction.test.ts
```
