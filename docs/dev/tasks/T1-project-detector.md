---
id: T1
title: 增强 projectDetector 项目检测
depends_on: []
files:
  - src/utils/projectDetector.ts
---

# T1: 增强 projectDetector

## 目标
将 `detectProject()` 从单一 `git remote` 依赖，增强为三级 fallback 策略。

## 改动
1. 新增 `tryGetRepoRoot()` — 用 `git rev-parse --show-toplevel` 获取仓库根目录
2. 新增 `deduplicateName()` — basename + SHA256 前 8 位去重
3. 新增 `isExcludedPath()` — 用 `path.relative` 判断排除目录
4. 新增 `isWithinMemoryDir()` — 排除 memory 自身目录
5. 重构 `detectProject()` — 三级策略链式调用

## 验收
- `git rev-parse --show-toplevel` 成功时返回 repo root basename
- 无 git 目录时返回 basename + 哈希
- home 目录返回 null
- memory 目录返回 null
- 已有 `parseGitUrl()` 逻辑不变
