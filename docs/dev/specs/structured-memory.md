# 结构化记忆系统 — 技术方案

## 1. 背景

当前 opencode-memory 的记忆体系是扁平的 4 个 `file_type`（memory / identity / user / daily），无法区分指令型记忆与学习型记忆，也无法表达情景记忆、程序记忆等更精细的语义。本次重构参考 Coding Agent 记忆机制最佳实践（智谱文档），建立分层、可检索、可追溯的结构化记忆系统。

## 2. 核心概念

```
指令型记忆（Instruction Memory）  — 人类编写，告诉 Agent "应该怎么做"
学习型记忆（Learning Memory）    — Agent 积累，从经验中提取

  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
  │ instructions │    │  learnings   │    │   dailies    │
  ├──────────────┤    ├──────────────┤    ├──────────────┤
  │ identity     │    │ preference   │    │ 流水账条目    │
  │ rule         │    │ episodic     │    │              │
  │ workflow     │    │ knowledge    │    │              │
  └──────────────┘    └──────────────┘    └──────────────┘
         ↑                    ↑                   │
         │                    │                   │
    人类编写              Agent 积累        extraction 提取 ──┘
    不改变                 持续增长
```

## 3. 数据模型（方案 B：多表）

### 3.1 instructions 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| user_id | TEXT | JWT sub |
| type | TEXT | identity / rule / workflow |
| title | TEXT | 简短标题 |
| content | TEXT | 完整 Markdown |
| scope | TEXT | global / project / user / local |
| project_id | TEXT | scope=project 时必填 |
| path_pattern | TEXT | glob 模式，按需加载 |
| priority | INTEGER | 加载优先级 |
| tags | TEXT | JSON 数组 |
| created_at / updated_at / archived | INTEGER | 标准时间戳 |

### 3.2 learnings 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| user_id | TEXT | JWT sub |
| type | TEXT | preference / episodic / knowledge |
| title | TEXT | 简短标题 |
| content | TEXT | 完整 Markdown |
| content_fts | TEXT | 全文检索分词 |
| scope | TEXT | global / project / user |
| project_id | TEXT | |
| source | TEXT | manual / extracted / imported |
| source_ids | TEXT | 提取来源 daily IDs (JSON) |
| confidence | REAL | 提取置信度 |
| recall_count | INTEGER | 搜索召回次数 |
| last_recalled_at | INTEGER | |
| created_at / updated_at / archived | INTEGER | |

### 3.3 dailies 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| user_id | TEXT | |
| content | TEXT | 单条日志（含时间戳标记） |
| content_fts | TEXT | |
| project_id | TEXT | |
| date | TEXT | YYYY-MM-DD |
| extracted | INTEGER | 0=未提取, 1=已提取 |
| extracted_at | INTEGER | |
| created_at | INTEGER | |

### 3.4 projects 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | owner/repo |
| user_id | TEXT | |
| name | TEXT | 显示名 |
| *_count | INTEGER | 各类记忆计数 |
| last_active_at | INTEGER | |

### 3.5 extraction_log 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | |
| user_id | TEXT | |
| status | TEXT | running / completed / failed |
| daily_count / extracted_count | INTEGER | 统计 |

## 4. 跨表搜索方案

三张表独立存储，但 Vectorize 用**单个 namespace + metadata.source_table** 统一索引。

```
写入时：
  instructions/learnings/dailies → embedding → VEC.upsert({
    metadata: { source_table: 'learnings', type: 'episodic', ... }
  })

搜索时：
  VEC.query(vector, { topK: 20, filter: { user_id } })
  → 结果含 source_table + source_id
  → 批量查对应表获取完整 record
  → 与 FTS 结果 RRF 融合
```

Worker 搜索端点保持单入口 `/api/memories/search`，内部实现跨表检索。

## 5. API 设计

### 5.1 新增端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/instructions` | 创建/更新指令 |
| GET | `/api/instructions` | 列出指令（支持 type/scope/project_id 过滤） |
| GET | `/api/instructions/:id` | 获取单条 |
| DELETE | `/api/instructions/:id` | 删除 |
| --- | --- | --- |
| POST | `/api/learnings` | 创建/更新学习记忆 |
| GET | `/api/learnings` | 列出（支持 type/source/project_id 过滤） |
| GET | `/api/learnings/:id` | 获取单条 |
| DELETE | `/api/learnings/:id` | 删除 |
| --- | --- | --- |
| POST | `/api/dailies` | 写入流水账 |
| GET | `/api/dailies` | 按 date + project_id 查询 |
| DELETE | `/api/dailies/:id` | 删除 |
| --- | --- | --- |
| POST | `/api/extract` | 触发 daily → learning 提取 |
| GET | `/api/extract/status` | 查询提取任务状态 |

### 5.2 保留端点

| 路径 | 状态 |
|------|------|
| `GET /api/context` | 改造为按需加载（instruction identity + user preference + 项目规则） |
| `POST /api/memories/search` | 保留，内部改为跨表搜索 |
| `GET /api/stats` | 保留，统计改为按表聚合 |
| `GET /health` | 保留 |

### 5.3 废弃端点

| 路径 | 原因 |
|------|------|
| `POST /api/memories` | 拆分为 /api/instructions、/api/learnings、/api/dailies |
| `GET /api/memories` | 同上 |
| `DELETE /api/memories/:id` | 同上 |
| `POST /api/memories/search/keyword` | 合并到 /api/memories/search |

## 6. 插件端改造

### 6.1 Provider 层

`RemoteFileStorageProvider` 改为按 `category` 路由到不同端点：

```
write  → instruction → POST /api/instructions
       → learning    → POST /api/learnings
       → daily       → POST /api/dailies

read   → instruction → GET /api/instructions/:id (或 list)
       → learning    → GET /api/learnings/:id
       → daily       → GET /api/dailies?date=...
```

### 6.2 MemoryManager

- `getPathForTarget()` 扩展为 `getCategoryAndType(target)`，返回 `{ category, subType }` 元组
- `readFile / writeFile / appendFile` 改为接受 `category + subType` 参数
- 新增 `extractFromDaily()` 方法

### 6.3 memory 工具

新增参数：

```typescript
{
  category: 'instruction' | 'learning' | 'daily',
  sub_type:  'identity' | 'rule' | 'workflow' | 'preference' | 'episodic' | 'knowledge',
  scope:     'global' | 'project' | 'user' | 'local',
  path_pattern: string,     // 按需加载 glob
}
```

### 6.4 上下文注入

改造 `buildContext()`：

```
启动时全量注入（低量数据）：
  instruction/type=identity   → IDENTITY.md 等效
  learning/type=preference    → USER.md 等效
  instruction/type=rule + scope=project  → 项目总览

按需注入（操作时触发）：
  instruction/path_pattern 匹配当前文件 → 动态追加到 context

搜索注入（语义检索）：
  learning/type=episodic     → 通过 search 按需检索
  learning/type=knowledge    → 通过 search 按需检索
```

## 7. 流水账 → 结构化提取

### 7.1 提取时机

- 每天首次会话启动时，自动扫描前一天的 dailies
- 用户手动触发：`memory --action extract --date YYYY-MM-DD`
- 定期后台任务（后续 Worker Cron Trigger）

### 7.2 提取策略

```
daily entry
  │
  ├─ 包含 "Bug/修复/fix/bug"      → learning/episodic
  ├─ 包含 "偏好/习惯/喜欢/使用"    → learning/preference
  ├─ 包含 "决策/架构/约定/ADR"      → learning/knowledge
  ├─ 包含 "工作流/流程/步骤"       → instruction/workflow
  └─ 其他                           → 不提取，保留在 daily
```

### 7.3 提取流程

1. 查询 `dailies WHERE extracted = 0 AND date < today`
2. LLM 调用：分析每条 daily，决定是否提取以及提取类型
3. 写入 learnings 或 instructions（source=extracted, source_ids=[daily_id]）
4. 标记 daily.extracted = 1
5. 记录 extraction_log

## 8. 兼容性

### 8.1 旧数据迁移

- 现有 `memories` 表中 `file_type=memory` 的记录 → 迁移到 learnings/type=knowledge
- `file_type=identity` → instructions/type=identity
- `file_type=user` → learnings/type=preference
- `file_type=daily` → dailies

### 8.2 插件向后兼容

- 旧的 `target` 参数自动映射到新的 `category + sub_type`
- `target: "memory"` → `category: "learning", sub_type: "knowledge"`
- `target: "identity"` → `category: "instruction", sub_type: "identity"`
- `target: "user"` → `category: "learning", sub_type: "preference"`
- `target: "daily"` → `category: "daily"`

## 9. 实施阶段

| Phase | 内容 | 预估 |
|-------|------|------|
| P0 | Worker D1 migration 0007 + 跨表搜索 | 2-3h |
| P1 | Worker API (instructions/learnings/dailies/extract) | 3-4h |
| P2 | 插件 Provider 路由 + MemoryManager 改造 | 2-3h |
| P3 | memory 工具新参数 + 上下文按需加载 | 2-3h |
| P4 | LLM 提取 pipeline + 测试 | 3-4h |
| P5 | 旧数据迁移脚本 + 清理 | 1-2h |

总计约 13-19h。

## 10. 风险

| 风险 | 缓解 |
|------|------|
| 跨表搜索性能 | Vectorize metadata filter + 批量 SQL，3 次 DB 查询 |
| LLM 提取质量 | confidence 字段标记 < 1.0，人工确认后才提升 |
| 旧数据迁移不完整 | 保留旧 memories 表只读 1 个月，验证后 DROP |
| 兼容性破坏 | target 参数自动映射，旧客户端零改动 |
