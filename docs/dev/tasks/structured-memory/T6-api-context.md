---
id: T6
title: "Worker API — /api/context 按需加载改造"
status: pending
phase: P1
dependencies: [T2]
batch: 3
tags: [worker, api, context]
estimated_hours: 1.5
---

# T6: Worker API — /api/context 按需加载改造

## 目标

改造 `/api/context` 端点，从全量注入改为分层注入：

1. **始终注入**：instructions/type=identity（AI 身份）、learnings/type=preference（用户偏好）
2. **按项目注入**：instructions/scope=project + project_id（项目规则总览）
3. **按路径注入**：接受新参数 `current_path`，返回 path_pattern 匹配的 rules

## 端点变更

```
GET /api/context?project_id=owner/repo&current_path=src/api/users.ts
```

Response 结构：
```json
{
  "identity": "## IDENTITY\n...",
  "preferences": "## USER\n...",
  "project_rules": [],
  "path_rules": [
    { "title": "API 设计规范", "content": "...", "path_pattern": "src/api/**" }
  ]
}
```

## Acceptance

- [ ] path_rules 仅返回 path_pattern 匹配 current_path 的 rule
- [ ] 不匹配的 rules 不返回
- [ ] project_id 为空时降级为全局 rules
- [ ] 输出格式向后兼容旧 buildContext 消费方

## 产出

- `worker/src/services/context-service.ts`

## 测试

```bash
cd worker && bun test tests/context-api.test.ts
```
