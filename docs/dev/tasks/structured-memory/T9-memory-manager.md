---
id: T9
title: "插件 MemoryManager — category/sub_type 改造 + 向后兼容映射"
status: pending
phase: P2
dependencies: [T8]
batch: 4
tags: [plugin, memory-manager, compat]
estimated_hours: 2.5
---

# T9: MemoryManager — category/sub_type 改造 + 向后兼容映射

## 目标

MemoryManager 支持新的 category/sub_type 体系，同时保持旧 target 参数的向后兼容。

## 改造点

### getPathForTarget 扩展

```typescript
getPathForTarget(target: string, date?, project?): { filePath, displayName, category, subType }
```

新增返回 `category` 和 `subType`，Provider 层据此路由。

### 向后兼容映射

```
旧 target         → 新 category    / sub_type
"memory"          → "learning"     / "knowledge"
"identity"        → "instruction"  / "identity"
"user"            → "learning"     / "preference"
"daily"           → "daily"        / null
```

### 新增方法

- `getContextByPath(currentPath)` — path_pattern 匹配
- `extractFromDaily(date)` — 触发 LLM 提取

## Acceptance

- [ ] 旧 target 参数仍可正常使用（向后兼容）
- [ ] `getPathForTarget("memory")` 返回 `category: "learning"` 的路径格式
- [ ] `readFile / writeFile / appendFile` 自动按 category 路由
- [ ] local 模式下路径格式兼容现有 filesystem 结构
- [ ] `getContextFiles()` 返回 category + subType 标记

## 产出

- `src/memory/MemoryManager.ts`

## 测试

```bash
bun test tests/high-risk.test.ts
```
