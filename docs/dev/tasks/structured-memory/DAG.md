# 结构化记忆 — DAG 任务拆解

```mermaid
graph TD
  T1[migration-0007: 建表] --> T2[cross-table-search: 跨表搜索]
  T1 --> T3[api-instructions: CRUD]
  T1 --> T4[api-learnings: CRUD]
  T1 --> T5[api-dailies-extract: dailies + extract 端点]
  
  T2 --> T6[api-context: 按需加载改造]
  T3 --> T7[api-stats: 多表聚合]
  T4 --> T7
  
  T3 --> T8[provider-router: category 路由]
  T4 --> T8
  T5 --> T8
  
  T8 --> T9[memory-manager: category/sub_type 改造]
  T9 --> T10[memory-tool: 新参数]
  T9 --> T11[context-injection: 按需加载]
  T10 --> T11
  
  T5 --> T12[extraction-pipeline: LLM 提取]
  T12 --> T13[extraction-tests]
  
  T8 --> T14[migration-script: 旧数据迁移]
  T9 --> T14
  
  T14 --> T15[e2e-cleanup: E2E 测试 + 清理]
  T11 --> T15
  T12 --> T15
```

## 并行批次

| Batch | Tasks | 并行度 | 内容 |
|-------|-------|--------|------|
| 1 | T1 | 1 (串行) | D1 migration 建表 |
| 2 | T2, T3, T4, T5 | 4 | 跨表搜索 + 三组 CRUD 端点 |
| 3 | T6, T7, T8 | 3 | context/stats 改造 + provider 路由 |
| 4 | T9, T12 | 2 | MemoryManager + 提取 pipeline |
| 5 | T10, T13 | 2 | memory tool 参数 + 提取测试 |
| 6 | T11 | 1 | 上下文按需加载 |
| 7 | T14 | 1 | 数据迁移 |
| 8 | T15 | 1 | E2E + 清理 |

预估总工时：13-19h（8 个批次）
