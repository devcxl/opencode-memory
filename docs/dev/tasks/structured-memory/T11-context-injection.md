---
id: T11
title: "上下文注入 — 按需加载 + path_pattern 匹配"
status: pending
phase: P3
dependencies: [T9, T10]
batch: 6
tags: [plugin, context, injection]
estimated_hours: 2
---

# T11: 上下文注入 — 按需加载 + path_pattern 匹配

## 目标

改造 `buildContext()` 实现分层上下文注入：

1. **启动时注入**（~200 tokens）：
   - instructions/type=identity
   - learnings/type=preference
   - instructions/scope=project 的规则摘要

2. **路径匹配注入**（操作文件时触发）：
   - 当前编辑文件路径匹配 `path_pattern` 的 rules

3. **搜索注入**（语义检索）：
   - learnings/type=episodic 和 knowledge 通过 search 结果注入

## 实现

```typescript
async buildContext(projectId?, currentPath?) {
  // 1. 始终注入：identity + preferences
  const identity = await fetchInstructions({ type: 'identity' });
  const preferences = await fetchLearnings({ type: 'preference' });

  // 2. 项目规则
  const projectRules = projectId
    ? await fetchInstructions({ scope: 'project', projectId })
    : [];

  // 3. 路径匹配
  const pathRules = currentPath
    ? await fetchInstructions({ path_pattern: matchGlob(currentPath) })
    : [];

  return formatContext({ identity, preferences, projectRules, pathRules });
}
```

## Acceptance

- [ ] identity 和 preferences 始终出现在 context 中
- [ ] 项目 rules 仅在 project 上下文时出现
- [ ] path_pattern 匹配的 rule 在操作匹配文件时追加
- [ ] 不匹配的 rules 不出现在 context 中
- [ ] 语义搜索结果按需注入

## 产出

- `src/index.ts`（buildContext 改造）

## 测试

```bash
bun test tests/high-risk.test.ts
```
