# `@devcxl/opencode-memory` 架构与工作流程全景指南

> 适用版本：`2.0.0-rc.1`（OpenCode V2 local-only）  
> 核心运行时：`@opencode/plugin@^2.3.0`、`zod@^4.1.8`、`@huggingface/transformers`、`vectra`

`@devcxl/opencode-memory` 是面向 **OpenCode V2** 的纯本地 Markdown 记忆插件。它以本地磁盘上的 Markdown 文件作为唯一真实数据源（Single Source of Truth），结合 **本地 ONNX 文本嵌入** 与 **Vectra 向量索引** 实现语义召回，并通过 **Git** 自动追踪每一次记忆变更。

> 注：旧版远程模式（Cloudflare Worker + Web 控制台）已在 2.0 中移除并迁移至 `@devcxl/cabbage-memory`。若配置中仍残留 `mode: "remote"`、`remote` 配置块或 `OPM_MODE=remote`，插件会在启动阶段直接抛出迁移错误以阻止静默降级。

---

## 1. 整体系统架构图

```mermaid
flowchart TB
    subgraph Host["OpenCode V2 Server 宿主环境"]
        OC_PLUG["插件加载器<br/>setup(ctx)"]
        OC_CMD["命令系统<br/>ctx.command.transform"]
        OC_TOOL["工具系统<br/>ctx.tool.transform / hook('execute.after')"]
        OC_SESS["会话与推理管线<br/>ctx.session.hook('context') / ctx.session.get"]
        OC_EVT["事件总线<br/>ctx.event.subscribe"]
    end

    subgraph Entry["1. 插件接入与配置层"]
        INDEX["apps/plugin/src/index.ts<br/>createMemoryPlugin()"]
        OPTDEP["search/optionalDependencies.ts<br/>vectra & transformers 预检"]
        CFG["config/runtime.ts + embedding.ts<br/>读取 ~/.config/opencode/opencode.json<br/>解析 memoryDir / embeddingModel / dtype"]
        CMD["commands/registerMemoryInitCommand.ts<br/>注册 /memory-init"]
        TOOL["tool/registerMemoryTool.ts + schema.ts<br/>注册 memory 工具 (6 个 action)"]
    end

    subgraph Session["2. 会话隔离与作用域层"]
        RESOLVER["session/SessionProjectResolver.ts<br/>按 sessionID 缓存 projectId"]
        DETECTOR["utils/projectDetector.ts<br/>三级项目探测: remote → repoRoot → dir+hash"]
        SESS_STORE["session/SessionStateStore.ts<br/>按 sessionID 记录工具调用与 daily 提醒状态"]
    end

    subgraph Core["3. 核心业务编排层"]
        MM["memory/MemoryManager.ts<br/>读写 / 追加 / 编辑 / 删除 / 索引编排"]
        PATHS["memory/MemoryPaths.ts<br/>统一派生全局与项目路径"]
        STATE["memory/StateChecker.ts<br/>状态机: uninitialized / bootstrapping / ready"]
        BOOT["memory/BootstrapManager.ts<br/>首次引导模板创建"]
        SEARCHER["memory/FileSearcher.ts<br/>语义检索 / 关键词检索 / 按月列表"]
        HANDLERS["handlers/handle{Read,Write,Edit,Delete,Search,List}.ts"]
    end

    subgraph Pipeline["4. 切片、嵌入与向量引擎"]
        CHUNKER["search/chunker.ts<br/>按 ##/### 与 &lt;!-- timestamp --&gt; 切片 + SHA256"]
        EMB["search/embedding.ts<br/>@huggingface/transformers ONNX 推理<br/>mean pooling + L2 normalize"]
        VEC["search/vector-store.ts<br/>vectra LocalIndex 增量 upsert / 查询 / stale 清理"]
    end

    subgraph Providers["5. 本地 Provider 与持久化层"]
        P_FS["LocalFileStorageProvider<br/>atomicWrite (tmp + rename)"]
        P_EMB["LocalEmbeddingProvider"]
        P_VEC["LocalVectorIndexProvider<br/>namespace: root / daily / project/{id}"]
        GIT["utils/git.ts<br/>ensureGitRepo + gitCommit"]
    end

    subgraph Disk["6. 本地磁盘存储 (~/.config/opencode/memory/)"]
        D_GLOBAL["全局文件<br/>MEMORY.md / IDENTITY.md / USER.md<br/>BOOTSTRAP.md / daily/YYYY-MM-DD.md"]
        D_PROJ["项目隔离目录<br/>projects/&lt;projectId&gt;/MEMORY.md<br/>projects/&lt;projectId&gt;/daily/YYYY-MM-DD.md"]
        D_IDX["vectra 派生向量索引<br/>root.index / daily.index<br/>projects/&lt;projectId&gt;/root.index"]
        D_GIT[".git/ 自动版本库"]
    end

    OC_PLUG -->|ctx| INDEX
    INDEX --> OPTDEP
    INDEX --> CFG
    INDEX --> CMD
    INDEX --> TOOL
    INDEX --> RESOLVER
    INDEX --> SESS_STORE
    INDEX <--> OC_CMD & OC_TOOL & OC_SESS & OC_EVT

    RESOLVER --> DETECTOR
    TOOL --> RESOLVER
    TOOL --> HANDLERS
    HANDLERS --> MM
    CMD --> BOOT --> MM

    MM --> PATHS & STATE & SEARCHER
    MM --> P_FS & P_EMB & P_VEC & GIT
    SEARCHER --> P_FS & EMB & VEC

    MM --> CHUNKER
    P_EMB --> EMB
    P_VEC --> VEC

    P_FS --> D_GLOBAL & D_PROJ
    VEC --> D_IDX
    GIT --> D_GIT
```

---

## 2. 磁盘目录与存储结构

记忆根目录由 `apps/plugin/src/config/runtime.ts` 中的 `getMemoryDir()` 解析：

- **Linux / macOS**：`~/.config/opencode/memory/`
- **Windows**：`%USERPROFILE%\AppData\Roaming\opencode\memory\`

```text
~/.config/opencode/memory/
├── .git/                         # 插件自动 git init 并提交每次变更
├── MEMORY.md                     # 全局长期记忆（上限 1000 行）
├── IDENTITY.md                   # AI 身份设定（人格、语言、行为规则）
├── USER.md                       # 用户画像（技术栈、偏好、称呼等）
├── BOOTSTRAP.md                  # 仅首次引导时存在，初始化完成后由 AI 删除
├── daily/
│   └── YYYY-MM-DD.md             # 全局每日任务日志
├── root.index/                   # vectra 索引：全局 MEMORY / IDENTITY / USER
├── daily.index/                  # vectra 索引：全局 daily/*.md
└── projects/
    └── <projectId>/              # 如 devcxl/opencode-memory 或 myproj.a1b2c3d4
        ├── MEMORY.md             # 项目级长期记忆（上限 1000 行）
        ├── daily/
        │   └── YYYY-MM-DD.md     # 项目级每日日志
        └── root.index/           # vectra 索引：该项目下的 MEMORY 与 daily
```

> 说明：向量索引目录（`*.index/`）属于**可重建的派生数据**；即使删除索引目录，原始记忆也不会丢失。

---

## 3. 插件核心工作流程（时序图）

插件的完整生命周期由以下 **3 条主链路** 组成：

1. **启动注册、事件监听与首次引导**
2. **记忆存储流程（写入、切片、向量化、原子落盘、Git 提交）**
3. **记忆召回流程（自动上下文注入 + 主动语义检索）**

### 3.1 插件启动、会话监听与 `/memory-init` 引导流程

```mermaid
sequenceDiagram
    autonumber
    participant OC as OpenCode V2 Server
    participant IDX as index.ts setup(ctx)
    participant CFG as config/runtime.ts
    participant RES as SessionProjectResolver
    participant SESS as SessionStateStore
    participant BOOT as BootstrapManager

    OC->>IDX: 调用 setup(ctx)
    IDX->>IDX: assertOptionalVectorDependencies()<br/>(import.meta.resolve 检查 vectra & @huggingface/transformers)
    IDX->>CFG: loadConfig(ctx.options)
    Note over CFG: 读取 ~/.config/opencode/opencode.json<br/>若存在 mode:"remote" / remote 块 / OPM_MODE=remote → 抛迁移错误
    IDX->>IDX: 初始化 MemoryManager / BootstrapManager / Resolver / StateStore

    IDX->>OC: ctx.command.transform → 注册 /memory-init
    IDX->>OC: ctx.tool.transform → 注册 memory 工具
    IDX->>OC: ctx.tool.hook("execute.after") → 记录 memory 工具调用状态
    IDX->>OC: ctx.session.hook("context") → 拦截每次模型请求并注入上下文
    IDX->>OC: 后台异步消费 ctx.event.subscribe(["session.created", "session.deleted"])

    Note over OC,SESS: 会话生命周期事件流（多会话隔离）
    OC-->>IDX: event: session.created (sessionID, location.directory, subpath)
    IDX->>SESS: get(sessionID) 惰性初始化操作状态
    IDX->>RES: setFromDirectory(sessionID, dir, subpath) → detectProject() 并缓存 projectId

    OC-->>IDX: event: session.deleted (sessionID)
    IDX->>SESS: delete(sessionID)
    IDX->>RES: delete(sessionID)

    Note over OC,BOOT: 用户执行 /memory-init 时
    OC->>BOOT: execute({ sessionID, prompt, delivery })
    BOOT->>BOOT: getInitState() == "ready" ? 若是则直接 return
    BOOT->>BOOT: createInitTemplates() 写入 BOOTSTRAP / MEMORY / IDENTITY / USER 模板
    BOOT->>OC: ctx.session.prompt(MEMORY_INIT_PROMPT) 驱动 AI 问答式建档
```

#### 会话项目 `projectId` 探测逻辑（`apps/plugin/src/utils/projectDetector.ts`）

由于 OpenCode V2 的 Server 是多会话共享服务，`ctx.location` 只代表插件加载位置，不能代表各个会话所在的目录。因此插件通过 `SessionProjectResolver` 为每个 `sessionID` 独立解析所在目录并缓存 `projectId`：

1. **排除目录**：若目录是用户主目录 `$HOME`、以 `.` 开头的隐藏目录（如 `~/.config`），或位于 `memoryDir` 自身内部，返回 `null`（走全局记忆）。
2. **策略 1（优先）**：执行 `git remote get-url origin`，解析出 `owner/repo`（支持 HTTPS、SSH、`git@` 三种格式）。
3. **策略 2**：无 remote 的本地 git 仓库（含 worktree / submodule），通过 `git rev-parse --show-toplevel` 取仓库根目录名 + 路径 SHA256 前 8 位（如 `my-repo.a1b2c3d4`）。
4. **策略 3（兜底）**：普通非 git 目录，取 `basename(cwd)` + 路径 SHA256 前 8 位。

---

### 3.2 记忆存储流程（Write / Append / Edit / Delete）

```mermaid
sequenceDiagram
    autonumber
    participant LLM as AI 模型
    participant TOOL as registerMemoryTool.ts
    participant HD as handleWrite / Edit / Delete
    participant MM as MemoryManager
    participant CHK as chunkMarkdown
    participant EMB as LocalEmbeddingProvider
    participant VEC as LocalVectorIndexProvider (vectra)
    participant FS as LocalFileStorageProvider
    participant GIT as utils/git.ts
    participant HOOK as tool.hook("execute.after")

    LLM->>TOOL: 调用 memory(action="write", target, content, scope, mode)
    TOOL->>MM: ensureDirectories()
    Note over MM: 确保 memory/ 与 daily/ 目录存在；<br/>首次调用时执行 refreshStaleIndices()<br/>清理模型或 dtype 变更导致的失效索引并重建
    TOOL->>TOOL: validateAction() & projects.resolve(sessionID) & resolveProjectId(scope)
    TOOL->>HD: 分发到对应 Handler (handleWrite / handleEdit / handleDelete)

    alt write (append 模式，默认)
        HD->>MM: appendFile(filePath, content)
        MM->>MM: 生成本地时间戳 <!-- YYYY-MM-DD HH:MM:SS --> 拼接到旧内容后
    else write (overwrite 模式)
        HD->>MM: writeFile(filePath, content)
    else edit
        HD->>MM: editFile(filePath, oldString, newString) (要求精确匹配 1 次)
    else delete
        HD->>MM: deleteByTimestamp(target, timestamp) (按 <!-- ts --> 解析并剔除条目)
    end

    MM->>MM: checkLineLimit() (仅校验 MEMORY.md ≤ 1000 行)
    MM->>FS: atomicWrite(filePath, newContent)<br/>(写入 *.tmp.<ts> 后 fs.renameSync 原子替换)

    rect rgb(240, 248, 255)
        Note over MM,VEC: 向量化与增量索引 (embedAndIndex)
        MM->>CHK: chunkMarkdown(newContent, filePath)
        Note over CHK: 按 <!-- timestamp --> 与 ## / ### 标题切块<br/>计算 hash = sha256(filePath:heading:timestamp:text)
        MM->>EMB: embedTexts(chunks.map(c => c.text))
        Note over EMB: 懒加载 @huggingface/transformers<br/>mean pooling + L2 normalize → 768 维向量
        EMB-->>MM: vectors[][]
        MM->>VEC: upsert(embeddedChunks, namespace)
        Note over VEC: namespace 路由：<br/>projects/ 下 → project/<id> (projects/<id>/root.index)<br/>含 /daily/ → daily (daily.index)<br/>其余 → root (root.index)<br/>三步增量比对：删失效/消失旧项，跳过同 hash 项，插入新项
    end

    MM->>GIT: gitCommit(operation, filePath, memoryDir, indexPaths)
    Note over GIT: ensureGitRepo → git check-ignore 过滤 → git add → git status 检查 → git commit
    HD-->>TOOL: 返回结果 + [scope: ...] + [REFLECTION TRIGGERED] 反思提示
    TOOL-->>LLM: { content }

    OC-->>HOOK: 触发 tool.hook("execute.after")
    HOOK->>HOOK: sessionStates.record(sessionID, { action, target }, completed)
```

#### 存储链路关键机制

1. **原子写入**：`atomicWrite()` 先写 `${filePath}.tmp.${Date.now()}`，再通过 `fs.renameSync()` 替换目标文件，防止异常中断导致 Markdown 损坏。
2. **Markdown 语义切片**：`chunkMarkdown()` 维护 `heading`（`##` / `###`）、`timestamp`（`<!-- YYYY-MM-DD HH:MM:SS -->`）与 `buffer` 状态，每遇到时间戳或标题就刷新为一个独立 `Chunk`，并计算 `sha256(filePath:heading:timestamp:text)` 用于增量去重。
3. **增量向量更新**：`upsertChunks()` 在 Vectra 索引中比对已有条目的 `hash` 与 `embeddingModel` / `embeddingDtype`，仅删除已失效或已移除的切片、跳过未变化的切片、插入新增切片。
4. **嵌入模型解析优先级**（`apps/plugin/src/config/embedding.ts`）：
   - L1：`~/.config/opencode/opencode.json` 中的插件 `options.embeddingModel`
   - L2：系统 locale 检测（`LANG` / `LC_ALL` / `LC_CTYPE` 以 `zh` 开头 → `Xenova/jina-embeddings-v2-base-zh`，768 维）
   - L3：环境变量 `OPM_EMBEDDING_MODEL`
   - L4：默认 `nomic-ai/nomic-embed-text-v1.5`（768 维）
   - 量化精度 `dtype` 按 `options.dtype` → `OPM_EMBEDDING_DTYPE` → 默认 `"fp32"` 解析（支持 `fp32`、`fp16`、`q8`、`q4`、`int8`、`uint8`）。
5. **嵌入容错**：`embedAndIndex()` 若遇到模型未初始化错误（`"not initialized"`），会静默跳过而不阻塞文件落盘与 Git 提交；向量索引会在后续模型可用时重建。
6. **Git 自动版本控制**：每次写入/编辑/删除都会调用 `gitCommit()`，将变更的 `.md` 文件及对应的索引文件一并提交到本地 `.git` 仓库。

---

### 3.3 记忆召回流程（双通道：自动上下文注入 + 主动语义检索）

记忆召回通过 **被动自动注入** 与 **主动工具查询** 两条通道协同工作：

```mermaid
sequenceDiagram
    autonumber
    participant USER as 用户
    participant OC as OpenCode V2 Server
    participant CTX as session.hook("context")
    participant RES as SessionProjectResolver
    participant BOOT as BootstrapManager
    participant MM as MemoryManager
    participant SESS as SessionStateStore
    participant LLM as LLM 模型
    participant FS as FileSearcher
    participant EMB as embedText()
    participant VEC as vector-store.ts

    rect rgb(245, 250, 240)
        Note over USER,LLM: 通道一：每次模型请求前的自动上下文注入（无缓存，每次从磁盘实时重建）
        USER->>OC: 发送消息
        OC->>CTX: 触发 session.hook("context", event)
        CTX->>RES: resolve(event.sessionID) → projectId | null
        CTX->>BOOT: isBootstrapNeeded() (检查 BOOTSTRAP.md 是否存在)

        alt 处于引导状态 (BOOTSTRAP.md 存在)
            CTX->>MM: readFile(BOOTSTRAP.md)
            CTX->>CTX: 拼接 BOOTSTRAP.md + BOOTSTRAP_INSTRUCTIONS
        else 正常就绪状态
            CTX->>MM: getContextFiles(projectId)
            MM-->>CTX: 按顺序读取：MEMORY.md → IDENTITY.md → USER.md → projects/<id>/MEMORY.md
            CTX->>CTX: 拼接 "# Memory Context" + 静态 memory-awareness.md<br/>(刻意不包含动态日期，避免模型侧 KV Cache 失效)
        end

        CTX->>SESS: needsDailyReminder(event.sessionID)?
        Note over SESS: 若本会话成功调用过 memory 工具<br/>但从未成功操作过 target="daily"
        SESS-->>CTX: true → 追加 "## Memory Reminder" 提示补写 daily 日志
        CTX-->>OC: event.system.push({ type: "text", text })
    end

    OC->>LLM: 携带系统上下文发起推理

    rect rgb(255, 248, 240)
        Note over LLM,VEC: 通道二：模型按需主动召回 (search / read / list)
        LLM->>FS: memory(action="search", query, scope, period, max_results)
        FS->>EMB: embedText(query) → queryVector (768d)

        par 并行向量检索
            alt scope !== "project" 或无 projectId
                FS->>VEC: semanticSearch(queryVector, searchLimit)<br/>同时查询全局 root.index 与 daily.index
            end
        and
            alt 存在 projectId 且 scope !== "global"
                FS->>VEC: ProjectStore(projectId).search(queryVector, searchLimit)<br/>查询 projects/<id>/root.index
            end
        end

        VEC->>VEC: filterCurrentSearchResults()<br/>过滤掉与当前模型/dtype 不匹配的 stale 条目
        VEC-->>FS: 合并所有候选结果并按余弦 score 降序排列

        loop 遍历排序后的结果（直到满足 max_results）
            FS->>FS: 若索引缺失 timestamp，读取源文件匹配正文反推时间戳
            FS->>FS: 若指定了 period (YYYY-MM 或 YYYY)，校验 timestamp.startsWith(period)
        end
        FS-->>LLM: 返回格式化结果：[timestamp] filePath (heading):score: text[:200]
    end
```

---

## 4. 关键行为规则与设计边界

### 4.1 自动注入 vs 主动召回的边界

- **每次请求自动注入**：全局 `MEMORY.md`、`IDENTITY.md`、`USER.md`，以及当前会话对应的 `projects/<projectId>/MEMORY.md`。
- **不会自动注入**：`daily/YYYY-MM-DD.md` 与 `projects/<projectId>/daily/YYYY-MM-DD.md` 不会自动进入 system prompt，必须由模型在需要时通过 `memory(action="read", target="daily")` 或 `memory(action="search")` 主动读取/搜索。
- **无上下文缓存**：`session.hook("context")` 每次模型请求都会从磁盘重新读取记忆文件并拼接；`memory-awareness.md` 保持纯静态文本以保护模型侧 KV Cache 命中率。

### 4.2 `scope` 参数在各动作中的解析规则

| 操作类型                                 | 未传 `scope`（默认）                                            | `scope: "project"`                                           | `scope: "global"`                     | `scope: "all"`                              |
| :--------------------------------------- | :-------------------------------------------------------------- | :----------------------------------------------------------- | :------------------------------------ | :------------------------------------------ |
| **`read` / `write` / `edit` / `delete`** | 自动探测 `projectId`；探测到则操作项目目录，否则降级全局        | 同左（若无项目上下文仍降级全局）                             | 强制操作全局根目录文件                | 不适用（等同自动探测）                      |
| **`search`**                             | 有 `projectId` 时等同 `"all"`，无 `projectId` 时等同 `"global"` | 仅查 `projects/<id>/root.index`（无 `projectId` 时降级全局） | 仅查全局 `root.index` + `daily.index` | 合并检索全局 + 当前项目索引，按得分统一排序 |

### 4.3 初始化状态机（`apps/plugin/src/memory/StateChecker.ts`）

```text
getInitState() 状态判定优先级：
├─ BOOTSTRAP.md 存在                           → "bootstrapping"
├─ MEMORY.md 不存在 / 为空 / 全是模板行         → "uninitialized"
├─ IDENTITY.md & USER.md 均已填写非占位符内容   → "ready"
└─ 其他情况                                     → "uninitialized"
```

### 4.4 代码目录职责速查

| 模块路径                                                   | 核心职责                                                                                        |
| :--------------------------------------------------------- | :---------------------------------------------------------------------------------------------- |
| `apps/plugin/src/index.ts`                                 | 插件入口：`Plugin.define`、依赖预检、命令/工具/Hook/事件订阅注册                                |
| `apps/plugin/src/config/runtime.ts`                        | 解析 `~/.config/opencode/opencode.json`、确定 `memoryDir`、远程配置迁移守卫                     |
| `apps/plugin/src/config/embedding.ts`                      | 嵌入模型与量化 `dtype` 优先级解析                                                               |
| `apps/plugin/src/commands/registerMemoryInitCommand.ts`    | 注册 `/memory-init` 命令，触发模板创建与首次引导                                                |
| `apps/plugin/src/tool/registerMemoryTool.ts` & `schema.ts` | 注册 `memory` 工具（Zod 4 schema）与 6 个 action 的参数分发                                     |
| `apps/plugin/src/handlers/`                                | `read` / `write` / `edit` / `delete` / `search` / `list` 六个动作处理器                         |
| `apps/plugin/src/session/`                                 | `SessionProjectResolver`（会话→项目映射缓存）与 `SessionStateStore`（daily 提醒追踪）           |
| `apps/plugin/src/memory/`                                  | `MemoryManager`、`MemoryPaths`、`StateChecker`、`BootstrapManager`、`FileSearcher`、`templates` |
| `apps/plugin/src/search/`                                  | `optionalDependencies`、`chunker`、`embedding`、`vector-store`                                  |
| `apps/plugin/src/providers/local/`                         | 本地文件、嵌入、向量索引三大 Provider 实现（测试可替换 seam）                                   |
| `apps/plugin/src/utils/`                                   | `atomicWrite`、`git`、`projectDetector`、`timestampParser`、`validation`、`defaultProject`      |
