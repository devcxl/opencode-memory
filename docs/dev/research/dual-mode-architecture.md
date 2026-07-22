# opencode-memory 双模式架构（本地/远程）技术方案研究

> 研究日期: 2026-07-22 | 状态: 第1轮完成 | 后续建议: 方案选型确认后进入第二轮深挖

---

## 研究结论摘要

opencode-memory 当前是纯本地架构（filesystem + vectra + huggingface embeddings）。要实现"远程模式"（通过 Cloudflare Workers），核心改造涉及 **4 个关键子系统**：向量索引、嵌入推理、文件存储、版本管理。

**推荐方案**：采用 **Provider 抽象层** 将本地和远程统一为可插拔后端，按优先级分阶段实施：

| 阶段 | 改造内容 | 复杂度 | 收益 |
|---|---|---|---|
| P0 | 抽象 `VectorIndexProvider` + `EmbeddingProvider` 接口 | 中 | 解耦核心逻辑，不破坏现有功能 |
| P1 | 实现 Cloudflare 远程 Provider (Workers AI + Vectorize + D1 + R2) | 高 | 实现跨机器共享记忆 |
| P2 | 实现同步/离线降级策略 | 中 | 保证网络不稳定时的可用性 |

**关键风险**：Cloudflare Vectorize 有最终一致性延迟（写入后 <5 分钟不可查询），这对"写入后立即搜索"的场景是个问题。Workers AI 的 embedding 模型选择有限且存在冷启动延迟（首次调用 ~800ms-1.5s）。

---

## 1. 背景与问题定义

### 1.1 当前架构

opencode-memory 是完全本地化的 AI 记忆系统：

```
本地文件系统 (~/.config/opencode/memory/)
├── .git/                     — 自动 git 版本管理
├── MEMORY.md / IDENTITY.md / USER.md   — 记忆文件
├── daily/                    — 每日日志
├── root.index/               — vectra LocalIndex（全局语义索引）
├── daily.index/              — vectra LocalIndex（日志语义索引）
└── projects/{owner}/{repo}/   — 项目隔离记忆 + 独立 vectra 索引
```

**核心依赖**：
- **向量索引**: `vectra` (LocalIndex) — 本地文件系统上的 HNSW 索引
- **嵌入推理**: `@huggingface/transformers` — CPU 上的 ONNX 模型推理
- **文件存储**: Node.js `fs` API — 直接文件读写
- **版本管理**: 本地 `git` — 自动 add + commit

### 1.2 需求定义

用户希望支持两种运行模式：

1. **本地模式**（当前）：所有数据在本地，零网络依赖
2. **远程模式**（新增）：数据存储在 Cloudflare Workers 后端，支持跨机器共享记忆

### 1.3 研究范围

- 远程后端：Cloudflare Workers 全栈方案（优先），替代方案（Turso/Supabase/Pinecone）作为备选
- 嵌入模型：本地 huggingface vs Workers AI vs 外部 API
- 架构模式：如何抽象双后端、同步策略、离线降级
- 不包含：MCP server 改造、Web UI、其他语言客户端

---

## 2. 研究方法

### 2.1 信息收集方式

- **代码分析**: 通过 `codegraph_explore` + `task(explore)` 深度分析了当前 30+ 源文件
- **官方文档**: Cloudflare Workers AI, Vectorize, D1, R2, Wrangler 官方文档
- **技术文章**: 6+ 篇 2026 年边缘 RAG/向量搜索实战文章
- **竞品分析**: codexfi, opencode-mem, CSM, working-memory 4 个同类插件
- **数据库对比**: Turso vs D1 多篇 2026 年横向评测

### 2.2 来源评分标准

| 维度 | 评分 (1-5) |
|---|---|
| 权威性 | 发布者领域可信度 |
| 一手性 | 原始来源 vs 转述 |
| 时效性 | ≤6 月为佳 |
| 独立性 | 是否存在商业偏见 |
| 可验证性 | 能否被其他来源印证 |

### 2.3 已知局限性

- 未对 Cloudflare Workers 方案进行实际原型验证（仅基于文档和社区实践）
- Workers AI embedding 模型的中文支持质量缺少独立评测
- Vectorize 的"最终一致性"在实际生产中的表现缺少一手数据
- opencode 插件系统对网络请求的限制未充分验证

---

## 3. 方案全景对比

### 3.1 四种架构方案

| 方案 | 向量索引 | 嵌入推理 | 文件存储 | 版本管理 | 复杂度 | 适用场景 |
|---|---|---|---|---|---|---|
| **A. 纯本地** (当前) | vectra LocalIndex | huggingface CPU | local fs | local git | 低 | 单机开发 |
| **B. Cloudflare 全栈** | Vectorize | Workers AI | D1 + R2 | D1 Time Travel | 高 | 多机共享 |
| **C. 混合 Hybird** | 本地 vectra + 远程 Vectorize 同步 | huggingface (本地) + Workers AI (远程) | 本地 fs + D1/R2 | git + D1 | 最高 | 离线可用 + 远程共享 |
| **D. 第三方后端** | Turso 向量 / Supabase pgvector | OpenAI / Voyage AI | Turso / Supabase | DB 自身 | 中 | 不想锁定 Cloudflare |

### 3.2 各方案详述

---

#### 方案 A: 纯本地（当前基线）

**现状**：功能完整，已验证。

**优势**：
- 零网络延迟，embedding 推理本地完成（~50ms）
- 零外部依赖，隐私性好
- 简单可靠，无服务宕机风险

**劣势**：
- 无法跨机器共享记忆
- 不同电脑上的 opencode 会话看到不同的记忆状态
- 嵌入模型切换需要重建所有索引（当前已支持自动 stale 检测）

**置信度**: 高（已在生产使用）

---

#### 方案 B: Cloudflare Workers 全栈

**架构概览**：

```
┌──────────────────────────────────────────────────┐
│                 opencode 客户端                    │
│  ┌────────────────────────────────────────────┐  │
│  │         MemoryPlugin (src/index.ts)         │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  │  │
│  │  │  Local   │  │  Remote  │  │  Sync    │  │  │
│  │  │ Provider │  │ Provider │  │ Manager  │  │  │
│  │  └──────────┘  └────┬─────┘  └──────────┘  │  │
│  └─────────────────────┼───────────────────────┘  │
│                        │ HTTP/REST                  │
└────────────────────────┼──────────────────────────┘
                         │
┌────────────────────────┼──────────────────────────┐
│            Cloudflare Workers                      │
│  ┌─────────────────────┴───────────────────────┐  │
│  │           Memory API Worker                  │  │
│  │  POST /read   POST /write  POST /search     │  │
│  └──┬──────────┬──────────┬───────────────────┘  │
│     │          │          │                       │
│  ┌──▼──┐  ┌───▼───┐  ┌──▼──┐  ┌──────────────┐  │
│  │ D1  │  │Vectorize│  │ R2  │  │ Workers AI   │  │
│  │SQLite│  │ Vector │  │Files│  │ Embeddings   │  │
│  │数据 │  │ Index  │  │存储 │  │  推理        │  │
│  └─────┘  └────────┘  └─────┘  └──────────────┘  │
└──────────────────────────────────────────────────┘
```

**组件选型**：

| 组件 | Cloudflare 服务 | 对应现有组件 | 关键参数 |
|---|---|---|---|
| 向量索引 | Vectorize | vectra LocalIndex | HNSW, 768/1024 dims, cosine metric |
| 嵌入推理 | Workers AI | huggingface pipeline | `@cf/baai/bge-base-en-v1.5` (768d) 或 `bge-m3` (1024d, 多语言) |
| 结构化数据 | D1 (SQLite) | MEMORY.md 等文件 | 5GB free, 10GB max/DB, 25B reads/month included |
| 文件存储 | R2 | local filesystem | 10GB free, S3 兼容 API |
| API 层 | Workers | N/A (当前无) | 300+ 全球边缘节点 |

**Embedding 模型选择**（Workers AI 可用模型，截至 2026-07）：

| 模型 | 维度 | 最大输入 tokens | 语言 | 单价 (per M tokens) |
|---|---|---|---|---|
| `@cf/baai/bge-base-en-v1.5` | 768 | 512 | 仅英文 | $0.067 |
| `@cf/baai/bge-large-en-v1.5` | 1024 | 512 | 仅英文 | N/A |
| `@cf/baai/bge-m3` | 1024 | 60,000 | **多语言** (含中文) | N/A |
| `@cf/qwen/qwen3-embedding-0.6b` | 1024 | 8,192 | 多语言 | N/A |
| `@cf/google/embeddinggemma-300m` | 768 | 512 | **100+ 语言** | N/A |

**关键选择**：
- **中文用户推荐 `bge-m3`**（多语言、多粒度、1024 维度，与当前 nomic-embed-text-v1.5 的 768 维不兼容，需重建索引）
- 英文用户推荐 `bge-base-en-v1.5`（768 维，与当前相同维度，迁移成本最低）

**成本估算**（以日均 100 次写入、50 次搜索的中等使用量）：

| 资源 | 用量估算 | 月费 |
|---|---|---|
| Workers 请求 | ~150 次/天 ≈ 4,500/月 | 免费额度内 |
| Workers AI embedding | ~100 次写入 × 512 tokens ≈ 51K tokens/天 | ~$0.10 |
| Vectorize 查询 | 50 次/天 ≈ 1,500/月 | ~$0.02 |
| Vectorize 存储 | 10K 向量 × 768 维 | ~$0.38 |
| D1 读写 | ~4,500 行/天 | 免费额度内 |
| R2 存储 | ~10MB | 免费额度内 |
| **合计** | | **~$0.50/月** |

**来源**: Cloudflare Workers 定价页 (2026-04); Markaicode RAG 成本分析 (2026-05-22); Let's Build Solutions 成本测算 (2026-04-16)
**置信度**: 中（定价可能变动，实际用量需原型验证）

**已知问题与风险**：

1. **Vectorize 最终一致性**（来源：多篇文章一致确认）
   - 写入后新向量可能需要 **<5 分钟** 才能被查询到
   - 对于"写入 memory 后立即 search"的场景，这是个 UX 问题
   - 缓解方案：D1 缓存写入内容，query 时合并 Vectorize 结果 + D1 最近写入

2. **Workers AI 冷启动**（来源：Markaicode 实测数据, 2026-05-22）
   - 首次调用 embedding 模型：**800ms-1.5s** 冷启动
   - 后续调用（模型已加载）：**40-80ms**
   - 缓解方案：Cron Trigger 每 60 秒 ping 一次保持模型 warm（费用 ~$0.50/月）

3. **模型锁定**
   - Vectorize 索引创建后维度和 metric 不可更改
   - 切换 embedding 模型需要删除并重建索引
   - Workers AI 不支持自定义模型

4. **D1 无交互式事务**（来源：Turso vs D1 对比分析, 2026-05）
   - 不支持 `BEGIN/COMMIT/ROLLBACK`
   - 只能用 `batch()` API 做原子批量写入
   - 不能"开始事务 → 检查中间结果 → 条件提交"

**来源评分**:

| 来源 | 权威性 | 一手性 | 时效性 | 独立性 | 可验证性 | 综合 |
|---|---|---|---|---|---|---|
| Cloudflare 官方文档 | 5 | 5 | 5 | 4 | 5 | 24 |
| Markaicode 实测报告 | 3 | 4 | 5 | 4 | 3 | 19 |
| Let's Build Solutions | 3 | 4 | 5 | 4 | 3 | 19 |
| Vadim Alakhverdov 边缘 RAG | 3 | 4 | 5 | 4 | 3 | 19 |
| DEV.to Rahil Pirani 记忆层 | 2 | 4 | 5 | 5 | 2 | 18 |

---

#### 方案 C: 混合 Hybird（本地 + 远程同步）

**架构思路**：本地保留完整功能，远程作为同步目标。类似 Git 的 distributed 模式。

```
写入流程:
  用户写入 → 本地 fs + vectra (立即) → 异步队列 → 远程 API

读取流程:
  本地优先读取 → 后台同步检查 → 合并远程增量

搜索流程:
  同时查询本地 + 远程 → 去重合并 → 返回
```

**优势**：
- 离线可用（网络断开时降级为纯本地）
- 写入零延迟（本地写入即时完成）
- 远程作为备份和共享通道

**劣势**：
- 实现复杂度最高（冲突解决、增量同步、一致性保证）
- 两端都需要维护（本地 vectra + 远程 Vectorize）
- 同步延迟意味着"准实时"而非"实时"

**冲突场景**：
- 机器 A 修改 MEMORY.md，机器 B 同时修改同一文件
- 解决方案：Last-Write-Wins（基于时间戳）+ D1 保留历史版本

**置信度**: 低（方案可行但工程量大，缺少类似系统的参考实现）

---

#### 方案 D: 第三方后端

**不锁定 Cloudflare 的替代方案**：

| 后端 | 向量搜索 | 嵌入推理 | 文件存储 | 优势 | 劣势 |
|---|---|---|---|---|---|
| **Turso** | 原生 `F32_BLOB` + DiskANN | 需外部 API | SQLite | 可移植、本地优先、向量内建 | 向量索引不如 Vectorize 成熟 |
| **Supabase** | pgvector | 需外部 API | PostgreSQL | 生态完整、Postgres 全功能 | 冷启动、成本较高 |
| **Pinecone** | 专用向量 DB | 需外部 API | 无（仅向量） | 性能最好 | 贵、需要 D1/R2 额外存储原始数据 |
| **Voyage AI + SQLite** | 纯 SQL 余弦相似度 | Voyage AI API | SQLite | codexfi 验证过、简单 | 无专用向量索引、大规模性能差 |

**Turso 特别值得关注**：
- 原生向量类型和 DiskANN 索引（2026 年已 GA）
- 支持在任何运行时访问（HTTP API），不锁定 Cloudflare
- 嵌入式副本模式：本地 SQLite 自动同步，读取亚毫秒级
- Free tier: 500M reads/month, 10M writes/month, 5GB storage
- 缺点：写入仍需路由到单一 primary region，跨洲写入延迟 50-150ms

**来源**: Turso 官方文档 (2026); Turso vs D1 多篇评测 (2026-05); codexfi 架构分析 (2026)
**置信度**: 中（Turso 向量搜索较新，缺少大规模生产案例）

---

## 4. 核心架构决策点

### 4.1 Provider 抽象层设计

当前 `MemoryManager` 中紧耦合的部分需要提取为接口：

```typescript
// 当前紧耦合调用链:
// handleWrite → memoryManager.getPathForTarget() → atomicWrite() → embedAndIndex() → gitCommit()

// 改造后的抽象:
interface VectorIndexProvider {
  upsert(chunks: EmbeddedChunk[], namespace: string): Promise<void>;
  search(vector: number[], topK: number, namespace: string): Promise<SearchResult[]>;
  delete(ids: string[], namespace: string): Promise<void>;
  isStale(metadata: EmbeddingMetadata): Promise<boolean>;
  clearNamespace(namespace: string): Promise<void>;
}

interface EmbeddingProvider {
  embedTexts(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly modelId: string;
}

interface FileStorageProvider {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  appendFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  listFiles(pattern: string): Promise<string[]>;
}

interface VersioningProvider {
  commit(message: string, paths: string[]): Promise<void>;
  // remote 模式下可能用 D1 Time Travel 替代 git
}
```

**风险**：过早抽象。当前只有一个本地实现时，过度设计接口可能导致不必要的复杂度。

**建议**：先用条件分支实现两种模式，等第二个 Provider 稳定后再提取接口。

### 4.2 模式切换机制

```typescript
// opencode.json 配置
{
  "plugins": [
    {
      "name": "opencode-memory",
      "mode": "local",             // "local" | "remote" | "hybrid"
      "remote": {
        "endpoint": "https://memory.example.workers.dev",
        "apiKey": "env://MEMORY_API_KEY",
        "syncStrategy": "on-write", // "on-write" | "periodic" | "manual"
      }
    }
  ]
}
```

**模式检测优先级**：
1. 插件配置 `mode` 字段
2. 环境变量 `OPM_MODE`
3. 默认：`local`

### 4.3 搜索语义的一致性

当前搜索使用 `vectra.queryItems()` 返回 `score + metadata`。改为远程后需要保持相同的接口签名。关键差异：

| 维度 | 本地 (vectra) | 远程 (Vectorize) |
|---|---|---|
| 距离度量 | 取决于 LocalIndex 配置 | cosine (推荐) 或 euclidean 或 dot-product |
| `returnMetadata` | 总是返回 | 默认 `"none"`，需显式设置 `"all"` |
| Score 含义 | 取决于 metric | cosine: 越接近 1 越相似 |
| 过滤 | 应用层 | `filter` 参数（需预定义 metadata index） |
| 一致性 | 即时 | 最终一致（<5 分钟） |

**来源**: Cloudflare Vectorize 官方文档 (2026-04-21); vectra 源码分析
**置信度**: 高

---

## 5. 同类插件对比

### 5.1 codexfi（最成熟的记忆插件）

| 维度 | codexfi | opencode-memory (当前) |
|---|---|---|
| **向量存储** | SQLite + 纯 JS 余弦相似度（Float32Array BLOB） | vectra LocalIndex |
| **嵌入模型** | Voyage AI `voyage-code-3` (1024d)，远程 API | huggingface transformers (本地) |
| **提取 LLM** | Anthropic/xAI/Google 多 Provider 自动 fallback | 无（被动记录，依赖 AI 主动调用 memory tool） |
| **记忆类型** | 13 种（profile, architecture, decision, pattern 等） | 4 种（memory, identity, user, daily） |
| **去重** | 余弦相似度 + LLM 语义去重 + 矛盾检测 | 基于 hash 的增量 upsert |
| **老化策略** | progress/active-context 只有 latest；session-summary 上限 3 | 无（手动管理） |
| **系统注入** | `system.transform` hook，每次 LLM 调用都注入 | `system.transform`，一次性注入 |
| **运行环境** | Bun/Node 自适应，零原生依赖 | Bun only（vectra） |
| **开源** | 否 | 是 |

**codexfi 的可借鉴点**：
- LLM 驱动的自动提取（而非依赖 AI 主动调用 memory tool）
- 多类型记忆分类（决策、模式、架构等）
- 去重 + 矛盾检测
- SQLite 纯 JS 向量搜索（避免 vectra 的原生依赖问题）

**来源**: codexfi 官方文档 (2026); GitHub 源码分析 (2026)
**置信度**: 高

### 5.2 opencode-mem

| 维度 | 说明 |
|---|---|
| **向量索引** | USearch（优先）+ ExactScan（fallback），内存索引 + SQLite 数据源 |
| **嵌入模型** | 12+ 本地模型（Xenova/transformers.js）或 OpenAI 兼容 API |
| **特性** | Web UI (4747 端口)、自动捕获、用户画像学习、compaction 处理 |
| **项目检测** | git remote 或 `.opencode-mem` marker 文件 |
| **许可证** | MIT |

**opencode-mem 的可借鉴点**：
- Web UI 管理记忆
- `.opencode-mem` marker 文件检测多 repo 工作空间
- 嵌入模型的灵活切换（本地/远程 API）
- 自动捕获（分析对话自动提取记忆）

**来源**: GitHub tickernelz/opencode-mem (2026-01-10); npm (2026)
**置信度**: 高

### 5.3 CSM (Cross-Session Memory)

最复杂的方案，50 个工具、PostgreSQL 完整模式。参考价值在于其分层架构设计（AgentBook → Memory → Re-entry → Governance → Context Control），但过度复杂，不适合作为 opencode-memory 的演进方向。

**来源**: GitHub NovasPlace/opencode-Cross-Session-Memory (2026-06-25)
**置信度**: 高

---

## 6. 风险与不确定性

### 6.1 元评审

- **剩余未知**：
  - Cloudflare Workers 中 opencode 插件的实际网络调用能力（插件运行在 opencode 进程中，不在 Worker 中）
  - bge-m3 对中文的实际 embedding 质量（无独立评测）
  - Vectorize 最终一致性在生产中的实际延迟分布

- **最弱证据**：
  - Workers AI embedding 冷启动对用户体验的实际影响（需要原型验证）
  - 混合同步方案的冲突解决策略（缺少参考实现）

- **可能错误的假设**：
  - 假设用户只需 Cloudflare 后端（可能也需要自托管选项）
  - 假设 opencode 插件可以自由发起 HTTP 请求（可能需要权限配置）

- **遗漏的角度**：
  - 多用户/团队协作场景下的权限控制
  - 记忆数据的加密需求（远程存储的隐私问题）

- **边际收益**：如果再做一轮研究，最有价值的方向是：
  1. **原型验证**：搭建最小 CF Worker 原型，测试实际的 latency 和一致性表现
  2. **中文 embedding 评测**：对比 bge-m3 vs nomic-embed-text 在中文记忆场景下的检索质量
  3. **Network 权限验证**：确认 opencode 插件发 HTTP 请求的限制

### 6.2 最坏情况分析

| 场景 | 影响 | 可回滚？ | 损失控制 |
|---|---|---|---|
| Cloudflare 服务宕机 | 远程模式完全不可用 | 降级为本地模式 | 本地数据完整，仅丢失远程同步 |
| Vectorize 索引损坏 | 语义搜索失败 | 从 D1 重建索引 | D1 是 source of truth，可全量重建 |
| embedding 模型切换 | 所有向量失效 | 重建索引 | D1 保留原始文本，可重新 embedding |
| 同步冲突导致数据丢失 | 部分记忆丢失 | 从 git 或 D1 Time Travel 恢复 | 版本历史保留 |
| Workers AI 超额计费 | 意外高额账单 | 设置 billing alert | Cloudflare 有 spending limit |

---

## 7. 建议

### 7.1 分阶段实施路线

**Phase 1: Provider 抽象（2-3 天）**

不改功能，只做架构重构：
1. 提取 `VectorIndexProvider` 接口
2. 提取 `EmbeddingProvider` 接口
3. 将当前 vectra + huggingface 实现包装为 `LocalVectorIndexProvider` + `LocalEmbeddingProvider`
4. 提取 `FileStorageProvider` 接口
5. 确保所有现有测试通过

**Phase 2: Cloudflare 远程 Provider（5-7 天）**

1. 创建 CF Worker 项目（API 层）
2. 实现 `RemoteVectorIndexProvider`（封装 Vectorize HTTP API）
3. 实现 `RemoteEmbeddingProvider`（封装 Workers AI 绑定）
4. 实现 `RemoteFileStorageProvider`（D1 存储文件内容 + R2 可选）
5. 实现模式切换逻辑（`MemoryConfig.mode`）
6. 端到端测试

**Phase 3: 安全与稳定性（2-3 天）**

1. API Key 管理（环境变量 / opencode.json）
2. 请求重试 + 指数退避
3. 离线检测 + 降级策略
4. 同步状态 UI 提示

### 7.2 关键设计建议

1. **保持本地模式为默认**：远程模式是 opt-in，不改变现有用户体验
2. **D1 作为 source of truth**：参考 codexfi 和多个社区实践，Vectorize 只做索引，D1 存储原始内容
3. **在内存中维护写入缓存**：规避 Vectorize 最终一致性问题，写入后立即缓存到内存，搜索时合并
4. **选择 bge-m3 (1024d)**：多语言支持（中文），60K token 上下文窗口，未来换模型也只需重建 Vectorize 索引
5. **参考 codexfi 的自动提取**：Phase 3+ 可考虑加入 LLM 驱动的自动记忆提取（而非完全依赖 AI 主动调用 memory tool）

---

## 8. 参考来源

| # | 标题 | URL | 发布者 | 日期 |
|---|---|---|---|---|
| 1 | Cloudflare Vectorize 官方文档 | https://developers.cloudflare.com/vectorize/ | Cloudflare | 2026-04-21 |
| 2 | Workers AI Models 列表 | https://developers.cloudflare.com/workers-ai/models/ | Cloudflare | 2026 |
| 3 | bge-m3 模型详情 | https://developers.cloudflare.com/workers-ai/models/bge-m3/ | Cloudflare | 2026 |
| 4 | Cloudflare Workers RAG Architecture: 15ms Latency | https://markaicode.com/architecture/cloudflare-workers-rag-architecture/ | Markaicode | 2026-05-22 |
| 5 | Vector Search at the Edge with Cloudflare | https://letsbuildsolutions.com/blog/ai-ml/vector-search-at-the-edge-building-low-latency-rag-with-cloudflare-vectorize-workers-ai-and-d1/ | Let's Build Solutions | 2026-04-16 |
| 6 | Edge RAG: Sub-100ms Retrieval with Workers AI + Vectorize | https://vadimall.com/posts/edge-rag-cloudflare-workers-ai-vectorize-typescript | Vadim Alakhverdov | 2026-06-29 |
| 7 | Challenges of Semantic Memory on CF Workers + D1 + Vectorize | https://dev.to/rahil_pirani_c48446facc8c/the-challenges-of-creating-a-semantic-memory-layer-on-cloudflare-workers-d1-and-vectorize-3c7a | DEV.to / Rahil Pirani | 2026-06-06 |
| 8 | Turso vs Cloudflare D1 Comparison 2026 | https://www.devtoolreviews.com/reviews/turso-vs-cloudflare-d1-comparison-2026 | DevToolReviews | 2026-05-10 |
| 9 | Turso Native Vector Search | https://turso.tech/vector | Turso | 2026 |
| 10 | codexfi — Persistent memory for AI coding agents | https://codexfi.com/docs/how-it-works/overview | codexfi | 2026 |
| 11 | opencode-mem (tickernelz) | https://github.com/tickernelz/opencode-mem | GitHub | 2026-01-10 |
| 12 | CSM — Cross-Session Memory | https://github.com/NovasPlace/opencode-Cross-Session-Memory | GitHub | 2026-06-25 |
| 13 | OpenCode Plugin API (Custom Tools) | https://opencode.ai/docs/custom-tools/ | OpenCode | 2026 |
| 14 | OpenCode Plugin Interface Definition | https://www.opencodebook.xyz/en/chapter_13_plugin_system/13.1_plugin_interface_definition | OpenCode Book | 2026 |
| 15 | OpenCode Tool Calling Internals | https://dev.to/antonio_zhu_e726fd856cd86/opencode-tool-calling-internals-5gda | DEV.to | 2026-07-20 |

---

## 附录 A: 现有代码改造清单

当前代码中需要抽象的关键位置：

| 文件 | 需要改动的部分 | 改造方式 |
|---|---|---|
| `src/search/vector-store.ts` | `getRootIndex()`, `getDailyIndex()`, `ProjectStore` 直接创建 vectra `LocalIndex` | 提取 `VectorIndexProvider` 接口 |
| `src/search/embedding.ts` | `embedText()` 直接调用 huggingface pipeline | 提取 `EmbeddingProvider` 接口 |
| `src/memory/MemoryManager.ts` | `readFile()`, `writeFile()`, `atomicWrite()` 直接调用 `fs` API | 提取 `FileStorageProvider` 接口 |
| `src/utils/git.ts` | 直接 spawn git 命令 | 提取 `VersioningProvider` 接口 |
| `src/memory/MemoryManager.ts` | `persistAndIndex()` 三合一耦合 | 改为调用 Provider 方法 |
| `src/memory/StateChecker.ts` | `fs.existsSync()` 判断状态 | 改为 `FileStorageProvider.exists()` |
| `src/config/runtime.ts` | `MemoryConfig` 只有 `memoryDir` | 新增 `mode`, `remote` 配置字段 |
| `src/index.ts` | 插件入口初始化逻辑 | 根据 mode 选择 Provider 实现 |

## 附录 B: Vectorize vs vectra 关键差异对照表

| 特性 | vectra (LocalIndex) | Cloudflare Vectorize |
|---|---|---|
| **部署** | 本地进程内 | 全球边缘节点 |
| **索引算法** | HNSW (可配置 M, efConstruction) | HNSW (M=16, efConstruction=200 默认) |
| **最大向量数** | 受磁盘限制 | 5M / index |
| **维度限制** | 无硬限制 | 创建时固定，不可更改 |
| **距离度量** | 创建时指定 | cosine / euclidean / dot-product |
| **元数据** | 每个 item 可附带任意 metadata | 每个向量 ≤10KB metadata；查询过滤需预定义 metadata index |
| **一致性** | 即时 | 最终一致（<5 分钟） |
| **查询速度** | ~1-5ms (小规模) | ~12ms p50, ~38ms p99 (500K 向量) |
| **成本** | 免费（本地磁盘） | $0.05/M 向量维度/月 + $0.10/M 查询 |
| **命名空间** | 通过不同 LocalIndex 实例实现 | 原生 namespace 支持，200K/namespace |
| **批量操作** | 逐个或小批量 | 支持批量 upsert（建议 ≤5000/批次） |
