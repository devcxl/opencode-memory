# ADR-006：结构化记忆多表 Schema

**日期**：2026-07-22
**状态**：Accepted

## 上下文

opencode-memory 当前使用扁平的 `file_type`（memory/identity/user/daily）分类记忆，所有内容存在单张 `memories` 表。随着记忆系统演进，需要支持：

- 指令型记忆（instruction）与学习型记忆（learning）的严格区分
- 情景记忆（episodic）、程序记忆（procedural/workflow）、用户偏好（preference）等更精细的分类
- 按路径作用域（path_pattern）按需加载规则
- 从流水账（daily）中自动提取结构化学习记忆

参考 Coding Agent 记忆机制最佳实践（智谱文档），记忆应分为 Session / Project / Semantic / Episodic / Procedural 五种类型，且指令型与学习型应严格分离。

## 决策

**采用多表方案（instructions / learnings / dailies 三表）**，而非单表扩展方案。

### 理由

| 考量 | 多表 | 单表 + 扩展字段 |
|------|------|-----------------|
| 类型安全 | 数据库级约束（type CHECK） | 应用层校验 |
| 字段纯净度 | 每表只含本类型需要的列 | 大量 NULL 字段 |
| 统计/聚合 | 直接 SELECT COUNT(*) | GROUP BY + NULL 处理 |
| 语义搜索 | 跨表需 metadata 标记来源 | 单表过滤 |
| 迁移成本 | 建新表 + 数据迁移脚本 | ALTER TABLE ADD COLUMN |

选择多表的核心原因：**语义不同、字段不同、生命周期不同**。合在一张表里只是"省了 JOIN"，但让查询、统计、类型约束都变复杂。

### 跨表搜索方案

Vectorize 索引用单个 namespace，metadata.source_table 区分来源：
- 搜索时从 Vectorize 返回 source_table + source_id
- 批量回查对应表获取完整 record
- 与 FTS 结果 RRF 融合

这是"存储按类型分表，搜索统一入口"的折中方案。

## 影响

- Worker 新增 3 个 D1 表 + 废弃旧 `memories` 表（保留只读 1 个月）
- Worker API 新增 4 组端点（instructions/learnings/dailies/extract）
- 插件 Provider 层需按 category 路由到不同端点
- 记忆工具新增 `category` / `sub_type` 参数
- 上下文注入改为按需加载（path_pattern glob 匹配）

## 替代方案

### A. 单表扩展（方案 A）

已被排除。短期实现更简单（`ALTER TABLE ADD COLUMN`），但长期维护成本高（大量 NULL 字段、类型查询需应用层校验）。

### C. 每种类型一个 Vectorize Index

已被排除。Cloudflare 免费计划只有 1 个 Vectorize Index（付费最多 100 个），且语义搜索需要跨类型检索。

## 引用

- [结构化记忆系统技术方案](../dev/specs/structured-memory.md)
- [智谱 Coding Agent 记忆机制文档](https://docs.bigmodel.cn/llms.txt)
- ADR-004：D1 schema 扩展（已被本 ADR 取代）
