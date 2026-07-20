# ADR: 记忆作用域修复 — 架构决策记录

**日期：** 2026-07-20
**状态：** 提议中
**关联 PRD：** `docs/prd/memory-scope-fix.md`

---

## 背景

`opencode-memory` 插件存在三层作用域混淆问题：
1. AI 调用 memory 工具后无法感知写入的 scope（全局 vs 项目）
2. 项目检测仅依赖 `git remote`，本地仓库检测失败
3. daily 日志不区分项目作用域

本 ADR 记录修复方案中的关键架构决策。

---

## ADR-001：handler 返回值中显式标注 scope

### 决策

在每个 handler（write/read/edit/delete/search）的返回字符串中，以 `[scope: ...]` 前缀标注实际操作的作用域，而非新建单独的 scope 查询接口。

### 替代方案

| 方案 | 评估 |
|------|------|
| **A. scope 前缀（选中）** | 简洁、无需新接口、AI 直接可读、向前兼容 |
| B. 在返回值中用 JSON 结构包裹 | 需要 AI 解析 JSON，增加理解成本，破坏现有纯文本返回格式 |
| C. 新增 `memory_info` action 查询 scope | 多一次工具调用，增加延迟和复杂度 |
| D. 在 `tool.execute.after` 注入 scope 提示 | 只能提示最近一次调用，无法关联到具体操作内容 |

### 理由

- **最小改动**：仅修改 handler 返回字符串的拼接逻辑，不影响函数签名或调用链
- **AI 友好**：`[scope: project/owner/repo]` 是自然语言可解析的轻量标记
- **向后兼容**：只是前缀，不影响现有输出格式

---

## ADR-002：使用 `git rev-parse --show-toplevel` 作为 project 检测的第二级 fallback

### 决策

在 `detectProject()` 中引入三级策略：
1. `git remote get-url origin` → 解析 owner/repo（现有）
2. `git rev-parse --show-toplevel` → repo root basename（新增）
3. `basename(cwd)` + 路径哈希去重（增强现有 fallback）

### 替代方案

| 方案 | 评估 |
|------|------|
| **A. git rev-parse（选中）** | 标准 git 命令，覆盖 worktree/submodule/workdir 场景 |
| B. 检查 `.git` 目录是否存在 | 不可靠：worktree 的 `.git` 是文件而非目录，submodule 的 `.git` 路径不同 |
| C. 使用 `git worktree list` 解析 | 过于复杂，且仅对 worktree 有用 |
| D. 始终使用路径哈希 | 对人类不友好：`a1b2c3d4` 在日志/列表中无意义 |
| E. 要求用户显式配置 projectId | 增加使用门槛，违背"自动检测"的设计初衷 |

### 路径哈希权衡

basename 冲突场景（同名目录）下，使用 SHA256 前 8 位 hex 后缀：
```
my-project → my-project.a1b2c3d4
```

- **为什么 8 位**：碰撞概率 ~1/4e9，对于个人/小团队足够；更重要的是保持 projectId 简短可读
- **为什么 SHA256 而非 md5**：Node.js crypto 模块无额外依赖，SHA256 是标准选择
- **为什么不是纯哈希**：保留 dirname 前缀有助于人类识别，哈希仅用于去重

---

## ADR-003：项目级 daily 日志存储在 `projects/{id}/daily/` 下

### 决策

当 `target=daily` 且存在 `project` 参数时，文件路径路由到 `projects/{id}/daily/YYYY-MM-DD.md`，而非全局 `daily/YYYY-MM-DD.md`。

### 替代方案

| 方案 | 评估 |
|------|------|
| **A. `projects/{id}/daily/`（选中）** | 与现有 `projects/{id}/MEMORY.md` 结构一致，自然扩展 |
| B. 在 `daily/` 下加 project 前缀，如 `daily/owner-repo-2026-07-20.md` | 扁平但污染全局目录，难以按项目聚合 |
| C. `projects/{id}/` 下直接放 daily 文件 | 与 MEMORY.md 混排，目录结构混乱 |
| D. 不做项目级 daily | 违反 PRD 核心需求 |

### 理由

- **一致性**：延续 `projects/{id}/MEMORY.md` 的目录模式 → `projects/{id}/daily/YYYY-MM-DD.md`
- **索引复用**：现有 `embedAndIndex` 已按 `projectsDir` 前缀将项目文件路由到 ProjectStore，无需额外改动
- **隔离性**：项目 daily 日志与项目 MEMORY 在同一项目目录下，方便 git 追踪和备份

### 影响范围

- `MemoryPaths.projectDailyPath()` — 新增
- `MemoryManager.getPathForTarget()` — daily 分支增加项目路由
- `handleWrite.ensureProjectDirs()` — 扩展条件从 `target === "memory"` 到 `target === "memory" || target === "daily"`

---

## ADR-004：handleList 和 listFiles 暂不改造

### 决策

本次修复（L3）不扩展 `handleList`、`listFiles`、`listFilesGroupedByMonth` 等列表功能以覆盖项目级 daily 日志。仅修复写入和读取路径。

### 理由

- PRD 验收标准未要求列表功能覆盖项目 daily
- 列表功能的项目支持涉及 `FileSearcher`、`listFiles`、`listFilesByPeriod`、`listFilesGroupedByMonth` 等多个方法，改动范围大（>5 个方法）
- 本次修复的核心痛点是"误写入全局 + daily 无隔离"，列表是低频操作
- 可在后续 PRD 中独立规划

---

## ADR-005：L1 scope 标签使用 project 参数直接判断，不二次解析

### 决策

handler 的 scope 标签基于 `params.project` 的有无生成（`project ? "[scope: project/xxx]" : "[scope: global]"`），不在 handler 内部重新调用 `detectProject()` 或 `resolveProjectId()`。

### 理由

- **单一数据源**：`resolveProjectId()` 在 `index.ts` 的 `execute` 中已执行，handler 只做展示
- **避免不一致**：handler 内部重复检测可能与调用方解析结果不同（环境变量、cwd 变化）
- **职责清晰**：`index.ts` 负责 scope 解析，handler 负责实际操作 + 结果标注

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| `git rev-parse --show-toplevel` 在某些环境失败（无 git） | 有 basename 兜底，不会比当前更差 |
| 路径哈希在 Windows 上路径大小写不一致 | `path.resolve` 会规范化，但需在 CI 中验证 Windows |
| L3 daily 路由变更后，已有项目 daily 数据丢失 | 历史 daily 数据在全局目录不受影响；项目 daily 为新增路径 |
| scope 标签格式变化可能影响依赖插件 | 插件生态中无已知消费者；纯文本前缀向前兼容 |
