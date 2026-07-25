---
id: T15
title: "E2E 测试 + 清理"
status: pending
phase: P5
dependencies: [T11, T12, T14]
batch: 8
tags: [test, e2e, cleanup]
estimated_hours: 2
---

# T15: E2E 测试 + 清理

## 目标

端到端验证结构化记忆系统的完整流程，清理废弃代码。

## E2E 测试场景

1. **写入 instruction** → 读回验证
2. **写入 learning** → 跨表搜索可检索
3. **写入 daily** → 触发 extract → 生成 learning（episodic）
4. **路径匹配注入** → 编辑 `src/api/users.ts` 时 context 含 `path_pattern=src/api/**` 的 rule
5. **语义搜索** → 搜索 "部署流程" 返回 workflow 类型 instruction

## 清理

- [ ] 移除旧的 `POST /api/memories` CRUD 路由（保留 search）
- [ ] 移除 `handleWrite` / `handleRead` 中旧 target 的 deprecated 注释
- [ ] 更新 `README.md` 和插件 tool description

## Acceptance

- [ ] 5 个 E2E 场景全部通过
- [ ] 无 TypeError（null field access）
- [ ] typecheck 零错误
- [ ] 所有已有测试仍通过

## 测试

```bash
cd worker && bun test tests/e2e-worker-api.test.ts
bun test
```
