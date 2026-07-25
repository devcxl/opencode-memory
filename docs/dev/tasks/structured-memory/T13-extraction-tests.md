---
id: T13
title: "提取管道测试"
status: pending
phase: P4
dependencies: [T12]
batch: 5
tags: [test, extraction]
estimated_hours: 1.5
---

# T13: 提取管道测试

## 目标

为 LLM 提取 pipeline 编写完整测试覆盖。

## 测试用例

- [ ] 扫描未提取的 dailies（extracted=0）
- [ ] LLM 成功提取 episodic 类型
- [ ] LLM 成功提取 preference 类型
- [ ] LLM 成功提取 knowledge 类型
- [ ] 无结构化内容的 daily 被跳过
- [ ] confidence < 1.0 正确设置
- [ ] 提取后的 daily.extracted 标记为 1
- [ ] LLM 调用失败时优雅降级
- [ ] 重复提取幂等（已提取的不再处理）

## 测试

```bash
cd worker && bun test tests/extraction.test.ts
```
