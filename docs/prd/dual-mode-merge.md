# PRD: opencode-memory 双模式架构（本地/远程）第二阶段

> 状态: 需求确认 | 日期: 2026-07-22 | 版本: v2.0
> 上阶段: [双模式架构技术调研](../dev/research/dual-mode-architecture.md)

---

## 1. 背景与问题

### 1.1 现状

`opencode-memory`（v1.2.0）是纯本地 AI 记忆系统，依赖 vectra 本地向量索引 + huggingface ONNX 嵌入推理 + 本地文件系统。单台机器运行良好，但存在根本性局限：

**换机器后记忆丢失** — 用户在台式机和笔记本之间切换时，opencode 失去所有过往对话上下文（技术栈偏好、架构决策、错误记录、项目约定），需要反复向 AI 说明，严重降低开发效率。

### 1.2 已有资源

- **cloudflare-memory**：已完成的 Cloudflare Workers 全栈记忆后端（D1 + Vectorize + Workers AI + Web UI）
- **opencode-memory**：已完成的本地记忆插件（vectra + huggingface + local fs）
- **技术调研**：已完成四种架构方案的深度对比，确认 "Cloudflare Workers 全栈" 为最优远程方案

### 1.3 目标

将两个项目**合并为一个仓库**，opencode-memory 插件支持 **本地/远程双模式**：

```
用户换机器 → 远程模式自动加载云端记忆 → 无缝继续工作
用户不换机器 → 本地模式零依赖，完全不变
```

---

## 2. 用户故事

### 2.1 主故事

**作为** opencode 的日常用户（全栈工程师），
**我希望** my AI 助手在台式机和笔记本之间共享记忆（MEMORY.md 的架构决策、daily 日志的任务记录、项目约定等），
**以便** 换设备后无需重复向 AI 说明技术栈偏好和过往决策，直接高效工作。

### 2.2 拆解故事

| 编号 | 故事 | 验收条件 | 优先级 |
|---|---|---|---|
| US-1 | 现有本地用户升级到新版本后，原有功能**零感知变化** | 本地模式下所有 memory 操作行为与 v1.2.0 一致，已有测试全绿 | P0 |
| US-2 | 配置远程后端后，AI 可以**写入记忆到云端** | `memory --action write --target memory --content '...'` 在 remote 模式下写入 Cloudflare D1，返回成功 | P0 |
| US-3 | 配置远程后端后，AI 可以**语义搜索云端记忆** | `memory --action search --query 'React 项目架构决策'` 返回 Vectorize 语义搜索结果 | P0 |
| US-4 | 换机器后，AI 在新的 opencode 会话中**自动获得过往记忆上下文** | 新机器 opencode 启动时，`system.transform` 注入云端记忆摘要（MEMORY + IDENTITY + USER + PROJECT），AI 无需用户重复说明即可继续工作 | P0 |
| US-5 | 远程模式下支持**项目级隔离** | `scope=project` 搜索只返回当前项目对应的记忆，不同项目的记忆不会泄漏 | P1 |
| US-6 | 远程模式下支持**按 target 读写** | 支持 target=memory/identity/user/daily，写入到正确的"逻辑文件" | P1 |
| US-7 | Web 管理界面可用 | 浏览器访问 Web UI 可查看/搜索/删除记忆 | P2 |

---

## 3. 功能范围

### 3.1 In Scope

| 功能 | 说明 | 来源 |
|---|---|---|
| 仓库合并 | cloudflare-memory 以子目录迁入 opencode-memory 仓库，形成 pnpm monorepo | 架构决策 |
| 本地模式不动 | 现有 vectra + huggingface + local fs 逻辑完整保留，作为 `LocalProvider` | US-1 |
| 远程模式核心 | write / read / search / delete 通过 HTTP 直调 CF Worker REST API 实现 | US-2, US-3 |
| scope 支持 | remote 模式支持 global/project/all 三级 scope，Worker D1 按 project_id 过滤 | US-5 |
| target 支持 | remote 模式支持 memory/identity/user/daily 四种 target，Worker D1 按 file_type 过滤 | US-6 |
| Context 注入 | `/api/context` 端点扩展 project_id 参数，插件根据当前项目注入对应记忆摘要 | US-4 |
| Worker schema 扩展 | D1 migration 新增 project_id, file_type, date 列；Vectorize filter 扩展 | 后端适配 |
| 插件配置 | opencode.json 新增 mode/remote 配置段，环境变量 OPM_API_KEY 支持 | 前端适配 |
| Web UI 保留 | cloudflare-memory 的 React Web UI 迁入 web/ 目录，保持可用 | US-7 |
| 共享类型 | packages/shared 统一 Memory 等核心类型定义 | 工程基础 |
| 文档 | 更新 README、部署指南、API 文档 | 工程基础 |
| 构建 | pnpm workspace 管理，插件 tsc 编译，Worker wrangler 构建/部署 | 工程基础 |

### 3.2 Out of Scope

| 排除项 | 原因 | 后续可能？ |
|---|---|---|
| 本地 ↔ 远程自动同步 | 实现复杂度极高（冲突解决、增量同步、一致性保证），Hybrid 模式需要数周独立工程 | Phase 3 |
| 离线降级（网络断开自动切本地） | 当前版本远程模式下网络不可用即报错，用户手动切回 local mode | Phase 3 |
| MCP 协议保留 | 用户决策：直调 REST API 更简单直接 | 永久排除 |
| 多用户/团队协作 | 当前 JWT 只做单用户认证，无权限系统 | Phase 4 |
| 记忆数据加密 | 远程存储的隐私保护，需要端到端加密方案 | Phase 4 |
| 本地记忆导入远程 | 第一次使用远程时需要手动迁移本地数据 | Phase 3 |
| 新的 Web UI 功能 | 保留现有 Web UI，不增加新功能 | Phase 4 |
| auto-capture（对话自动提取记忆） | 依赖 LLM 处理，工程量大，当前依赖 AI 主动调 memory tool | Phase 4 |
| Bootstrap 引导阶段扩展 | 当前引导逻辑只针对本地文件模式，远程模式跳过引导 | Phase 3 |
| 向量索引 staleness 检测（远程） | Workers AI 模型切换由后端自行管理，客户端不感知 | 后端自行处理 |

---

## 4. 架构概览

### 4.1 目标目录结构

```
opencode-memory/                    # 主仓库（pnpm workspace root）
├── src/                            # 插件主体（@devcxl/opencode-memory）
│   ├── index.ts                    # 入口：根据 mode=local|remote 注入 provider
│   ├── types.ts                    # 核心类型（吸收 @cfmem/shared）
│   ├── config/
│   │   └── runtime.ts              # MemoryConfig 新增 mode, remote 段
│   ├── providers/                  # 🆕 Provider 抽象层
│   │   ├── types.ts                # IVectorIndexProvider, IEmbeddingProvider, IFileStorageProvider
│   │   ├── local/                  # 本地模式 Provider
│   │   └── remote/                 # 远程模式 Provider（HTTP Client → CF Worker）
│   ├── memory/                     # MemoryManager（注入 Provider 接口）
│   ├── handlers/                   # 工具处理器（不变）
│   ├── instructions/               # Prompt 模板
│   └── utils/
│
├── worker/                         # ← 迁自 cloudflare-memory/apps/api/
│   ├── src/                        # Hono API（扩展 project_id + file_type）
│   ├── migrations/                 # D1 migrations（含新增 0006）
│   ├── wrangler.toml
│   └── package.json                # @cfmem/api
│
├── web/                            # ← 迁自 cloudflare-memory/apps/web/
│   ├── src/                        # React SPA（不变）
│   └── package.json                # @cfmem/web
│
├── packages/
│   └── shared/                     # ← 迁自 cloudflare-memory/packages/shared/
│       ├── src/                    # Memory, ApiResponse 等类型
│       └── package.json            # @cfmem/shared
│
├── tests/                          # 插件测试（bun test）
├── docs/                           # 文档
├── scripts/                        # 工具脚本
├── package.json                    # root workspace
├── pnpm-workspace.yaml
└── tsconfig.json
```

### 4.2 运行时模式

```
┌──────────────────────────────────────────────────────────┐
│                opencode-memory 插件                       │
│                                                          │
│  mode=local (默认)          mode=remote                   │
│  ┌──────────────────┐      ┌─────────────────────────┐   │
│  │ LocalProvider    │      │ RemoteProvider          │   │
│  │ ├─ vectra        │      │ ├─ HTTP Client          │   │
│  │ ├─ huggingface   │      │ └─ CF Worker REST API   │   │
│  │ └─ local fs      │      │     ├─ POST /write      │   │
│  └──────────────────┘      │     ├─ POST /search     │   │
│                            │     └─ GET  /context    │   │
│                            └─────────┬───────────────┘   │
└──────────────────────────────────────┼────────────────────┘
                                       │ HTTPS
┌──────────────────────────────────────┼────────────────────┐
│                       Cloudflare Workers                  │
│  ┌──────────────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ D1 (SQLite)      │  │Vectorize │  │ Workers AI     │  │
│  │ memories 表       │  │ 1024d     │  │ Qwen3-Emb      │  │
│  │ + project_id     │  │ cosine    │  │ Qwen3-30B      │  │
│  │ + file_type      │  │           │  │                │  │
│  │ + date           │  │           │  │                │  │
│  └──────────────────┘  └──────────┘  └────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### 4.3 REST API 端点（Worker 侧）

| 方法 | 路径 | 说明 | 新增参数 |
|---|---|---|---|
| `POST` | `/api/memories` | 写入记忆 | body 新增 `project_id`, `file_type`, `date` |
| `POST` | `/api/memories/search` | 语义搜索 | body 新增 `project_id`, `file_type` |
| `GET` | `/api/memories?kind=&file_type=&project_id=` | 列出记忆 | 新增 `file_type`, `project_id` 查询参数 |
| `DELETE` | `/api/memories/:id` | 删除记忆 | 不变 |
| `GET` | `/api/context?project_id=` | 获取记忆摘要（注入 system prompt） | 新增 `project_id` 查询参数 |
| `GET` | `/api/stats` | 统计 | 新增 `project_id` 过滤 |
| `GET` | `/health` | 健康检查 | 不变 |

---

## 5. 数据模型

### 5.1 D1 memories 表（扩展后）

```sql
-- Migration 0006: 新增 project_id + file_type + date 列
ALTER TABLE memories ADD COLUMN project_id TEXT NOT NULL DEFAULT '';
ALTER TABLE memories ADD COLUMN file_type TEXT NOT NULL DEFAULT 'memory';
ALTER TABLE memories ADD COLUMN date TEXT DEFAULT '';

CREATE INDEX idx_memories_project ON memories(user_id, project_id, file_type);
CREATE INDEX idx_memories_date ON memories(user_id, date);
```

### 5.2 字段映射

| opencode-memory 概念 | D1 字段 | 值示例 |
|---|---|---|
| MEMORY.md（全局） | file_type='memory', project_id='' | |
| MEMORY.md（项目） | file_type='memory', project_id='devcxl/opencode-memory' | |
| IDENTITY.md | file_type='identity', project_id='' | |
| USER.md | file_type='user', project_id='' | |
| daily/YYYY-MM-DD.md（全局） | file_type='daily', project_id='', date='2026-07-22' | |
| daily/YYYY-MM-DD.md（项目） | file_type='daily', project_id='devcxl/opencode-memory', date='2026-07-22' | |

### 5.3 插件配置

```jsonc
// opencode.json 中的 opencode-memory 配置段
{
  "plugins": {
    "@devcxl/opencode-memory": {
      "mode": "local",           // "local" | "remote"
      "remote": {
        "apiUrl": "https://memory.example.workers.dev",
        "apiKey": "env://OPM_API_KEY"
      }
    }
  }
}
```

---

## 6. 命名与人名表

| 名称 | 定义 | 用途 |
|---|---|---|
| **opencode-memory** | 插件 npm 包名（保持 `@devcxl/opencode-memory`） | 用户安装的包 |
| **cloudflare-memory** | 旧项目名，合并后内部保留 | Worker 子包前缀 `@cfmem/*` |
| **Local Mode** | 使用本地 vectra + huggingface + fs | mode=local（默认） |
| **Remote Mode** | 使用远程 CF Worker HTTP API | mode=remote |
| **Provider** | 抽象接口，封装向量索引/嵌入式推理/文件存储的实际实现 | 内部架构概念 |
| **project_id** | git remote 推导的 `${owner}/${repo}` 格式 | scope=project 时的隔离键 |
| **file_type** | memory / identity / user / daily | 对应原始文件类型 |
| **mode** | local / remote 配置项 | 用户选择切换 |

---

## 7. 验收标准

### 7.1 核心验收

| # | 标准 | 验证方法 | 对应故事 |
|---|---|---|---|
| A1 | 本地模式下所有现有功能与 v1.2.0 行为一致 | `bun test` 全部通过，手动验证 write/read/search/list/delete/edit | US-1 |
| A2 | 远程模式下 `memory --action write --target memory` 写入云端成功 | 调用后检查 D1 有新记录，Vectorize 可检索到 | US-2 |
| A3 | 远程模式下 `memory --action search --query 'xxx'` 返回语义搜索结果 | 写入一条记忆后 1 分钟内可搜到（考虑 Vectorize 延迟） | US-3 |
| A4 | 换机器后新 opencode 会话启动时，system prompt 自动包含云端记忆摘要 | 两台设备上分别启动 opencode，检查首条 system prompt 包含相同 long-term memories | US-4 |
| A5 | 远程模式下 `scope=project` 搜索只返回当前项目记忆 | 在项目 A 下搜索不会出现项目 B 的记忆 | US-5 |
| A6 | 远程模式下 `target=identity/user/daily` 能正确读写到对应 file_type | 写 IDENTITY.md 内容检查 D1 file_type='identity' | US-6 |
| A7 | Web UI 可正常访问、搜索、删除记忆 | 浏览器打开后操作 CRUD | US-7 |

### 7.2 工程验收

| # | 标准 | 验证方法 |
|---|---|---|
| B1 | pnpm workspace 正常，`pnpm install` 无报错 | 根目录执行 |
| B2 | `pnpm typecheck` 全仓库类型检查通过 | 递归检查所有子包 |
| B3 | Worker `wrangler dev` 可启动 | 本地开发运行 |
| B4 | 插件 `tsc` 编译产出正确 | `pnpm --filter @devcxl/opencode-memory build` |
| B5 | 共享类型 `@cfmem/shared` 被正确引用 | Worker 和 Plugin 都能 import 到更新后的类型 |

---

## 8. 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|
| 合并后 pnpm workspace 构建冲突 | 中 | 高（阻塞所有开发） | 先最小化合并（只搬文件不改逻辑），验证构建通过后再开始改代码 |
| Vectorize 最终一致性延迟导致搜索"刚写入的"失败 | 高 | 中（用户体验差） | 插件端内存写入缓存，搜索时合并缓存 + Vectorize 结果 |
| Workers AI embedding 冷启动导致首次调用慢 | 高 | 低（首次调用 800ms-1.5s） | Cron trigger 保活（可选 P2），UI 提示 |
| 当前测试对本地文件系统有硬编码路径依赖 | 中 | 中（测试失败） | 抽取 provider 接口后测试改为 mock |
| 用户部署 Worker 门槛过高 | 中 | 中（无人使用远程模式） | 提供详细部署指南 + 一键脚本 |
| 两个项目 tsconfig 差异导致类型错误 | 低 | 低（易修复） | 统一 root tsconfig + 子包 extends |

---

## 9. 与现有功能的关系

| 现有功能 | 合并后行为 | 影响 |
|---|---|---|
| v1.2.0 本地模式全部功能 | 不变，包装为 LocalProvider | 零破坏 |
| cloudflare-memory Worker API | 迁移到 worker/ 子目录，扩展 D1 schema | 向后兼容（DEFAULT 值保证旧数据可用） |
| cloudflare-memory Web UI | 迁移到 web/ 子目录，不变 | 零破坏 |
| cloudflare-memory MCP 协议 | **废弃**，改用直调 REST API | 删除 MCP agent 相关代码 |
| cloudflare-memory OpenCode 插件 | **废弃**，其逻辑合并到 opencode-memory 插件 | 删除 apps/plugin/ |
