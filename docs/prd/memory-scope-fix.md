# PRD: 记忆作用域修复

## 问题

`opencode-memory` 插件的项目级记忆与全局记忆存在混淆：

1. **项目记忆误写入全局**：当 `detectProject()` 返回 null（无 git remote 或路径被排除），所有带 `target=memory` 的写入静默降级到全局 `MEMORY.md`，用户和 AI 均无感知
2. **项目检测脆弱**：仅依赖 `git remote get-url origin`，无 remote 的项目（本地仓库、非标准 remote 格式）检测失败，fallback 到目录名也不可靠
3. **daily 日志无作用域**：所有 `target=daily` 写入统一存入 `daily/` 目录，不区分项目，导致多项目日志混杂

## 目标

- **L1**：透明化 scope 解析 —— 每次 memory 操作的返回结果中包含实际使用的 scope 和 projectId
- **L2**：增强项目检测 —— 本地 git 仓库（即使无 remote）也能正确生成 projectId
- **L3**：项目级 daily 日志 —— `target=daily` 在 project scope 下写入项目独立目录

## 验收标准

1. `handleWrite` 返回结果包含 `[scope: project/xxx]` 或 `[scope: global]`
2. `handleRead`/`handleSearch` 返回结果包含 scope 信息
3. 本地仓库（无 git remote）`detectProject()` 返回有效 projectId
4. `target=daily` + `scope=project` 写入 `projects/{id}/daily/YYYY-MM-DD.md`
5. 所有现有测试通过 + 新增测试覆盖
6. 全局 `MEMORY.md` 不再混入项目级内容
