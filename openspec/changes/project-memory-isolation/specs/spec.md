# Spec: project-memory-isolation

## Requirements

### R1: 项目检测

插件必须能在会话启动时检测当前工作目录是否属于某个已知项目，并获取项目标识。

**检测逻辑**：
1. 在 `process.cwd()` 下执行 `git remote get-url origin`
2. 提取 `owner/repo`（去掉协议、域名、`.git` 后缀）
3. 若失败（无 git / 无 remote），fallback 到 `path.basename(cwd)`
4. 若 cwd 是用户 home 目录或与 memoryDir 同级，视为无项目

**输出**：项目标识字符串（如 `"luckyc"` / `"anomalyco/opencode"`），或 `null`（无项目）。

### R2: 项目目录结构

每个检测到的项目在 `memoryDir/projects/{projectId}/` 下维护：

```
projects/{projectId}/
└── MEMORY.md          ← 项目记忆（与全局 MEMORY.md 格式一致，含时间戳）
```

**设计决策**：daily 日志保持全局（`{memoryDir}/daily/`），不拆入项目目录。原因是 daily 是跨项目的时间线流水记录，拆分会破坏时序完整性，且增加不必要的索引和路由复杂度。

**创建时机**：首次写入时自动创建（懒初始化），而非检测到项目时立即创建。

**模板**：首次创建 project MEMORY.md 时写入简要模板头（"# {projectId} Project Memory\n\n"）。

### R3: 上下文注入

`buildContext()` 行为变更：

| 场景 | 注入内容 |
|------|----------|
| BOOTSTRAP.md 存在 | 仅 BOOTSTRAP.md（不变） |
| 正常模式，有当前项目 | 全局 MEMORY + IDENTITY + USER + **项目 MEMORY** |
| 正常模式，无当前项目 | 全局 MEMORY + IDENTITY + USER（不变） |

注入格式：

```
# Memory Context

## MEMORY.md

{全局 MEMORY 内容}

---

## IDENTITY.md

{IDENTITY 内容}

---

## USER.md

{USER 内容}

---

## Project: {projectId}

{项目 MEMORY 内容}
```

**前提**：项目 MEMORY.md 文件存在且非空才注入 Project 区块。

### R4: 语义搜索分层

`memory --action search` 新增 `--scope` 参数：

| scope 值 | 行为 |
|----------|------|
| `all`（默认） | 全局索引 + 当前项目索引（无项目时等同 global） |
| `global` | 仅全局索引（root + daily） |
| `project` | 仅当前项目索引（无项目时返回空） |

**索引结构变更**：

```
root.index/        ← 全局 MEMORY + IDENTITY + USER（不变）
daily.index/       ← 全局 daily/（不变，涵盖所有项目日志）
projects/
  {projectId}/
    root.index/    ← 项目 MEMORY（每项目仅一个索引）
```

每个项目仅维护一个 root 索引（无 daily.index），因为 daily 保持全局。

### R5: 写入路由

`memory --action write --target memory` 新增 `--project` 参数：

| --project | 行为 |
|-----------|------|
| 未指定 | 写入全局 MEMORY.md（向后兼容） |
| 指定项目 ID | 写入 `projects/{projectId}/MEMORY.md` |

`--target daily` 始终写入全局 `daily/`（不受 project 参数影响）。

IDENTITY 和 USER 写入始终路由到全局（不受 project 影响）。

### R6: 读取路由

`memory --action read --target memory` 新增 `--project` 参数：

| --project | 行为 |
|-----------|------|
| 未指定 | 读取全局 MEMORY.md |
| 指定项目 ID | 读取 `projects/{projectId}/MEMORY.md` |

### R7: 列表与分组

`memory --action list` 保留现有行为（按月份分组）。
不新增 project 维度的列表功能（非 MVP 需求）。

## Behavior

### 用户故事 1：项目间切换，记忆互不干扰

1. 用户 cd 到 `~/work/luckyc`，与 AI 讨论采用 MongoDB 和 Redis
2. AI 记录 "项目使用 MongoDB + Redis 缓存" 到 luckyc 的项目 MEMORY
3. 用户 cd 到 `~/work/photosync`，与 AI 讨论采用 SQLite
4. AI 上下文中**不出现** MongoDB/Redis 的记忆
5. 用户切回 luckyc，AI 的上下文中重新出现 MongoDB/Redis 记忆

### 用户故事 2：搜索仅限当前项目

1. 用户在 luckyc 项目中执行 `memory --action search --query "数据库选型"`
2. 默认返回 luckyc 相关的数据库决策 + 全局偏好
3. 用户执行 `memory --action search --query "数据库选型" --scope project`
4. 仅返回 luckyc 项目中的相关内容

### 用户故事 3：非项目目录零影响

1. 用户在 home 目录中执行 memory 操作
2. 行为与插件升级前完全一致（无项目检测、无项目文件夹创建）

### 用户故事 4：全局偏好跨项目生效

1. 用户在全局 MEMORY 中写入 "偏好使用 async/await 而非 Promise.then()"
2. 在 luckyc 项目中，AI 上下文同时包含这条全局偏好 **和** 项目特定记忆
3. 在 photosync 项目中同样生效

## Acceptance Criteria

### AC1: 项目检测
- [ ] 在含 `git remote origin` 的项目目录中，项目 ID 稳定不变
- [ ] 在无 git 的目录中，fallback 到目录名
- [ ] 在 home 目录中，返回 null

### AC2: 目录创建
- [ ] 首次写入项目 MEMORY 时，`projects/{id}/` 自动创建
- [ ] 项目 MEMORY.md 初始化时包含项目名标题

### AC3: 上下文注入
- [ ] 在项目目录中，system prompt 包含 "## Project: {id}" 区块
- [ ] 在非项目目录中，system prompt 不含 Project 区块
- [ ] 项目 MEMORY.md 为空时不注入 Project 区块

### AC4: 搜索分层
- [ ] `--scope all`（默认）返回全局 + 当前项目结果
- [ ] `--scope project` 仅返回当前项目结果
- [ ] `--scope global` 仅返回全局结果
- [ ] 无项目时 `--scope project` 返回空
- [ ] 无项目时 `--scope all` 等同 `--scope global`

### AC5: 写入路由
- [ ] 不指定 `--project` 时写入全局
- [ ] 指定 `--project {id}` 时写入项目

### AC6: 向后兼容
- [ ] 不传 `--scope` / `--project` 参数时，行为与当前版本一致
- [ ] 全局 daily/ 数据不受影响
- [ ] 全局 MEMORY.md / IDENTITY.md / USER.md 不受影响
