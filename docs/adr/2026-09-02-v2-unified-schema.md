# ADR-007：v2 统一记忆 Schema 与远程-only 架构

**日期**：2026-09-02
**状态**：Accepted（取代 ADR-006 的多表方案与双模式架构）

## 背景

v1 存在的核心问题：

1. **两代数据模型并存**：旧 `memories`（short/long）表与新结构化表（instructions/learnings/dailies）同时活跃，旧表的 short→long 晋升 cron 已是死链路（无任何代码写入 kind='short'）。
2. **文件隐喻强加在关系库上**：远程 Provider 用字符串路径模拟 Markdown 文件，overwrite = 全删再建，delete 靠时间戳字符串匹配（时区脆弱）。
3. **跨表搜索成本高**：4 张表分组向量召回 + 3 套 FTS + 按表 4 路回查 hydration；0007 忘建 FTS 导致关键词搜索静默失效（0009 补救）。
4. **死字段**：recall_count（从未更新）、confidence（从不参与排序）、path_pattern（从未实现 glob 加载）。
5. **写入同步等 embedding**：每次创建记录阻塞数百毫秒。
6. **纯向量检索无法区分高相似实体**："华东销售额"与"华北销售额"向量距离极近。

## 决策

### 1. 统一单表 + 两张卫星表

`memories`（type: daily|fact|instruction|digest + subtype）替代四张业务表；新增 `memory_entities`（分面实体）与 `memory_links`（supersedes/contradicts 演化链）。ADR-006 多表方案的理由（类型安全、字段纯净）在实践中失效——差异字段多为死字段，而搜索/hydration 的成本被证实。

单表的代价：DB 层无法按 type 约束字段，`meta` JSON 扩展字段由应用层（zod + shared 类型）守护。

### 2. 两桶分层混合搜索

FTS AND 全命中的记录构成桶 A（确定性优先），其余候选（FTS OR 部分命中 + 向量召回）构成桶 B，桶内 RRF 融合。"华北销售额"查询下，含"华北"的记录永远排在只含"销售额"的"华东"记录之前。分面硬过滤通过 `memory_entities` 实现。

### 3. 写入异步索引

同步路径只有 D1 插入；embedding + Vectorize upsert 与 fact 后处理（实体抽取 + 查重 + 新陈代谢，单次 LLM 结构化输出）通过 `waitUntil` 异步执行。

### 4. 每日 digest cron

每天用户时区 04:00（UTC 20:00，wrangler cron 按 UTC 触发）把昨天的 daily 总结成一条事实记忆。幂等策略：digest 占位行 + 部分唯一索引 (user_id, project_id, date)，失败次日自动重试。

### 5. 认证体系

GitHub OAuth2（Web，allowlist 控制）+ API Token（SHA-256 哈希存储，个人中心管理）统一到同一个 userId；废弃离线 JWT 生成。新增 `users` / `api_tokens` 表。

### 6. MCP Streamable HTTP

`/mcp` 无状态 JSON-RPC 端点（initialize/tools/list/tools/call），7 个工具与 REST 共享 service 层。不引入 MCP SDK / Durable Object（无状态工具服务用不上）。

### 7. 插件远程-only

删除 local 模式（vectra/chunker/本地 embedding/git/StateChecker ≈ 2000 行）；`memory` 工具从文件动作（edit-by-oldString、delete-by-timestamp）改为记录动作（add/search/get/update/delete/list）。

## 影响

- Migration 0010/0011/0012：建新表 → 迁移数据 → 删旧表（memories/learnings/dailies/instructions/projects/extraction_log/rate_limits 及三套 FTS）
- `scripts/migrate-v2.ts`：旧 user_id 归属映射 + 全量 reindex
- 上下文注入服务端化（/api/context），调 prompt 不再需要发插件版本
- 向量 metadata 记录 embedding 模型版本，支持模型换版增量重建

## 替代方案

- **保留多表**：搜索/hydration/FTS 成本不变，放弃。
- **删除 FTS 纯向量**：中文精确关键词（错误码、地区名）召回不可靠，放弃；保留单套 FTS 成本可控。
- **查询时 LLM 解析分面过滤**：作为第二阶段方案（写入时实体抽取已就位），当前由调用方显式传 facets。
