---
id: T4
title: 测试覆盖
depends_on: [T1, T2, T3]
files:
  - tests/high-risk.test.ts
---

# T4: 测试覆盖

## 目标
新增 L1/L2/L3 测试用例，确保现有测试全部通过。

## L1 测试（6 条）
1. handleWrite 返回 `[scope: project/owner/repo]`
2. handleWrite 返回 `[scope: global]`
3. handleRead 返回含 scope 标签
4. handleEdit 返回含 scope 标签
5. handleDelete 返回含 scope 标签
6. handleSearch 返回含 scope 信息

## L2 测试（5 条）
7. 无 remote 本地 git 仓库返回有效 projectId
8. 非 git 目录使用 basename + 哈希
9. home 目录返回 null
10. memory 目录返回 null
11. 子目录中取 repo root basename

## L3 测试（4 条）
12. `target=daily` + project → `projects/owner/repo/daily/2026-07-20.md`
13. `target=daily` + 无 project → `daily/2026-07-20.md`
14. 项目 daily 文件索引路由到 ProjectStore
15. 全局 daily 不受影响
