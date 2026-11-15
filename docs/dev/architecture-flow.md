# opencode-memory 整体流程

> 版本: v2.0 | 日期: 2026-11-15
> 基于 OpenCode V2 插件 API (`@opencode/plugin@2.3.0`)

---

## 1. 系统总览

```mermaid
flowchart TB
    subgraph OpenCode["OpenCode 终端 (apps/plugin)"]
        OC[opencode CLI] --> PLUGIN["MemoryPlugin (src/index.ts)"]
        PLUGIN --> CONFIG["loadConfig()<br/>runtime.ts"]
        PLUGIN --> MM["MemoryManager"]
        MM --> STATE["StateChecker / FileSearcher"]
        MM --> BOOT["BootstrapManager"]
    end

    subgraph Local["local 模式（默认）"]
        LOCALFS[("本地文件<br/>~/.config/opencode/memory/")]
        VECTRA[("vectra 本地索引")]
        GIT[本地 git commit]
        MM -->|LocalFileStorageProvider| LOCALFS
        MM -->|LocalVectorIndexProvider| VECTRA
        MM -->|gitCommit| GIT
    end

    subgraph Remote["remote 模式（Cloudflare）"]
        HTTP["RemoteFileStorageProvider<br/>http-client.ts"]
        MM -->|RemoteFileStorageProvider| HTTP
    end

    subgraph Worker["Cloudflare Worker (apps/api)"]
        HONO["Hono app (index.ts)"]
        AUTH["JWT 认证 + 限流中间件"]
        ROUTES["业务路由"]
        SVC["services/*<br/>memory / instruction / learning / daily / extraction"]
        D1[("D1: memories<br/>instructions<br/>learnings<br/>dailies")]
        VEC[("Vectorize 索引")]
        AI["Workers AI<br/>Qwen3-Embedding"]
        CRON["定时任务<br/>consolidate + cleanup"]
        HTTP -->|HTTPS + Bearer JWT| HONO
        HONO --> AUTH --> ROUTES --> SVC --> D1
        SVC -->|向量化 upsert| VEC
        VEC -.embed.-> AI
        CRON --> D1
    end

    subgraph Web["Web 管理台 (apps/web)"]
        UI[React UI<br/>总览 / 记忆 / AI 问答]
        UI -->|JWT| HONO
    end

    subgraph Shared["packages/shared"]
        SH[共享 schema / api 类型]
        Worker -.类型.-> SH
        PLUGIN -.类型.-> SH
    end
```

---

## 2. 插件生命周期（V2：setup → 注入 → 工具调用）

```mermaid
sequenceDiagram
    participant OC as OpenCode V2 server
    participant P as MemoryPlugin.setup(ctx)
    participant C as loadConfig
    participant F as createProviders
    participant M as MemoryManager
    participant B as BootstrapManager
    participant R as SessionProjectResolver

    OC->>P: 加载插件并执行 setup(ctx)
    P->>C: loadConfig(ctx.options)<br/>确定 mode (local/remote)
    P->>F: remote? 创建 RemoteProvider<br/>local? 由 MemoryManager 自动创建
    P->>M: new MemoryManager(config, providers)
    P->>B: new BootstrapManager(memoryManager)
    P->>OC: ctx.command.transform 注册 /memory-init
    P->>OC: ctx.tool.transform 注册 memory 工具
    P->>OC: ctx.tool.hook("execute.after") 记录 memory 操作
    P->>OC: ctx.session.hook("context") 注入记忆上下文
    P->>OC: ctx.event.subscribe(session.created/deleted)

    Note over OC,P: /memory-init（仅未初始化时执行）
    OC->>P: command execute
    P->>B: createInitTemplates()<br/>BOOTSTRAP/IDENTITY/USER/MEMORY
    P->>OC: ctx.session.prompt(初始化引导 prompt)

    Note over OC,P: 每次模型请求前：系统提示注入
    OC->>P: session.hook("context")
    P->>R: resolve(sessionID) → projectId
    P->>M: getInitState() + getContextFiles(projectId)
    alt 引导阶段
        P->>M: 读取 BOOTSTRAP.md
    else 常规阶段
        P->>M: 读取 MEMORY > IDENTITY > USER > PROJECT
    end
    P-->>OC: event.system.push({ type: "text", text })<br/>Memory Context + 感知指令（无日期）

    Note over OC,P: 会话事件追踪
    OC->>P: session.created → 注册 SessionState + project 缓存
    OC->>P: tool.execute.after (memory) → 记录操作
    OC->>P: 下次 context hook → 有操作未写 daily 则追加 Memory Reminder
    OC->>P: session.deleted → 清理状态与缓存
```

---

## 3. memory 工具调用分发

```mermaid
flowchart TD
    A["memory 工具 execute"] --> B["ensureDirectories()<br/>创建 memory/daily 目录<br/>重建失效索引"]
    B --> C["validateAction(action)"]
    C --> D{"scope → project 解析<br/>resolveProjectId"}
    D -->|"scope=project"| E["SessionProjectResolver<br/>读取 session.location → detectProject()<br/>检测失败降级全局"]
    D -->|"global/all"| F["resolvedProject = null"]
    E --> G
    F --> G{"action 分发 switch"}
    G -->|read| H1[handleRead]
    G -->|write| H2[handleWrite]
    G -->|edit| H3[handleEdit]
    G -->|delete| H4[handleDelete]
    G -->|search| H5[handleSearch<br/>scope 默认 all/global]
    G -->|list| H6[handleList]
    H1 --> M[MemoryManager]
    H2 --> M
    H3 --> M
    H4 --> M
    H5 --> M
    H6 --> M
```

---

## 4. 读写路径：local vs remote

```mermaid
flowchart LR
    subgraph Write["写入 write / append"]
        W1["handleWrite"] --> W2["getPathForTarget<br/>解析 target/category/sub_type/scope"]
        W2 --> W3{"mode?"}
        W3 -->|local| W4["appendFile: 读回 → 拼接 → 整体重写<br/>+ 本地 embed + vectra index + git commit"]
        W3 -->|remote| W5["appendFile: 只写本次内容<br/>+ 时间戳前缀 → writeFile → HTTP API"]
        W5 --> W6["Worker: 解析 path → createInstruction<br/>createLearning / createDaily"]
        W6 --> W7["D1 INSERT + Vectorize upsert<br/>(失败静默 indexed=false)"]
    end

    subgraph Read["读取 / 上下文"]
        R1["readFile / getContextFiles"] --> R2{"mode?"}
        R2 -->|local| R3["fs 读文件"]
        R2 -->|remote| R4["HTTP GET 对应资源<br/>readFile 时生成展示时间戳"]
        R4 --> R5["Worker buildContext / listXxx"]
    end

    subgraph Delete["删除"]
        D1["handleDelete(timestamp)"] --> D2{"mode?"}
        D2 -->|local| D3["读文件 → 按时间戳过滤条目 → 重写"]
        D2 -->|remote| D4["list 该 path 记录 → 匹配 created_at<br/>→ 删除具体那条"]
    end
```

---

## 5. Worker API 请求流程

```mermaid
sequenceDiagram
    participant C as 客户端 (插件/Web)
    participant H as Hono app
    participant A as authMiddleware
    participant R as 路由
    participant S as services/*
    participant D as D1
    participant V as Vectorize
    participant AI as Workers AI

    C->>H: HTTPS 请求 /api/*<br/>(Authorization: Bearer JWT)
    H->>A: CORS(动态 Origin allowlist) → 结构化日志 → JWT 验证
    A->>A: verifyJWT (HS256) → userId/role
    A->>A: checkRateLimit (60s 窗口, D1 计数)
    A->>R: 放行
    R->>R: zod 校验请求体 (400/413)

    alt POST /api/memories (createMemory)
        R->>S: createMemory
        S->>D: INSERT memories<br/>+ text_fts (tokenizer 分词)
        S->>V: upsertMemoryVector<br/>(AI 嵌入 → Vectorize)
        S-->>R: { id, indexed }
    else POST /api/memories/search (语义)
        R->>S: searchMemories → crossTableSearch
        S->>V: 查询向量 + 跨表召回
        S->>D: FTS/元数据过滤
        S-->>R: 排序结果
    else POST /api/memories/search/keyword
        R->>S: searchMemoriesByKeyword (FTS)
        S->>D: 关键词检索
    else POST /api/ask (RAG 问答)
        R->>S: answerQuestion
        S->>S: 检索 topK 记忆 → 拼 context
        S->>AI: LLM 生成 { answer, citations }
    else POST /api/instructions|learnings|dailies
        R->>S: createXxx → D1 INSERT + Vectorize upsert
    else POST /api/extract (AI 提取)
        R->>S: triggerExtraction → extraction_log
        S->>AI: 批量总结 dailies → 生成 learnings
    end

    R-->>C: JSON { success, data }
```

---

## 6. 定时任务与数据生命周期

```mermaid
flowchart TD
    SCHED["Worker scheduled 事件<br/>(CRON_SCHEDULE)"] --> P1[Promise.all]
    P1 --> CON[consolidateMemories<br/>昨日 short → 合并总结]
    P1 --> CLEAN[cleanupExpiredMemories<br/>过期 short 清理]

    CON --> C1[查昨日 kind=short 且未合并]
    C1 --> C2[AI 总结 + withRetry]
    C2 --> C3[写回 long + 更新 consolidated_at<br/>+ 重建向量索引]

    subgraph 生命周期
        W["write (kind=short, 7天过期)"] -->|promote| P["promoteMemory → long"]
        W -->|cron 清理| E["过期删除"]
        D["daily 日志"] -->|extract API| L["提取为 learnings"]
        L -->|长期保存| K["knowledge/preference"]
    end
```

---

## 7. 目录结构与职责

| 目录                                        | 职责                                                   |
| ------------------------------------------- | ------------------------------------------------------ |
| `apps/plugin/src/index.ts`                  | 插件入口：工具注册、事件监听、系统提示注入             |
| `apps/plugin/src/handlers/`                 | 7 个 action 的入参解析与结果格式化                     |
| `apps/plugin/src/memory/MemoryManager.ts`   | 核心：读写/追加/编辑/删除、路径解析、持久化+索引       |
| `apps/plugin/src/providers/{local,remote}/` | 双模式 Provider：文件/向量/嵌入                        |
| `apps/plugin/src/search/`                   | 本地 chunker / embedding / vector-store                |
| `apps/api/src/index.ts`                     | Worker 入口：中间件 + 全部 REST 路由                   |
| `apps/api/src/services/`                    | 业务服务：memory/instruction/learning/daily/extraction |
| `apps/api/src/search/`                      | 跨表检索 / 混合搜索 / 分词 / 打分                      |
| `apps/api/src/cron/`                        | 定时合并 + 过期清理                                    |
| `apps/web/src/`                             | React 管理台（总览/记忆列表/AI 问答）                  |
| `packages/shared/src/`                      | 共享 schema 与类型                                     |

## 8. 关键路径速查

- 插件 → Worker：`remote provider (http-client) → POST /api/memories | /api/instructions | /api/learnings | /api/dailies`
- 插件 → 本地：`MemoryManager → LocalFileStorageProvider (fs) → embed → vectra index → git commit`
- 上下文注入：`system.transform → buildContext → MEMORY/IDENTITY/USER/PROJECT（引导阶段为 BOOTSTRAP）`
- 认证链：`CORS → 日志 → JWT (HS256) → 限流 (D1 rate_limits) → 路由 → zod → service → D1 + Vectorize`
