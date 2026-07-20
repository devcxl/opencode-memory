---
id: T3
title: handler 返回值 scope 透明化
depends_on: [T2]
files:
  - src/handlers/handleWrite.ts
  - src/handlers/handleRead.ts
  - src/handlers/handleEdit.ts
  - src/handlers/handleDelete.ts
  - src/handlers/handleSearch.ts
---

# T3: handler 返回值 scope 标签

## 目标
所有 memory handler 返回结果中显式标注 `[scope: project/xxx]` 或 `[scope: global]`

## 改动
1. `handleWrite.ts` — 返回值前加 scope 标签
2. `handleRead.ts` — 返回值前加 scope 标签
3. `handleEdit.ts` — 返回值前加 scope 标签
4. `handleDelete.ts` — 返回值前加 scope 标签
5. `handleSearch.ts` — 返回值前加 scope 信息

## 验收
- 有 project 参数时返回 `[scope: project/xxx]`
- 无 project 参数时返回 `[scope: global]`
- search scope=all 时返回 `[scope: all]`
