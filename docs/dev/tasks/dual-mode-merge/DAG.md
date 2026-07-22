# 双模式架构合并 — DAG 任务图

> 基于技术方案 `docs/dev/specs/dual-mode-merge.md` §10 拆解
> 关联 PRD: `docs/prd/dual-mode-merge.md`
> 关联 ADR: `docs/adr/2026-07-22-dual-mode-merge.md`

---

## 整体依赖关系

```mermaid
graph TD
  subgraph "Phase 1 — 仓库合并"
    T1["T1: pnpm workspace 设置"]
    T2["T2: 迁移 worker/"]
    T3["T3: 迁移 web/"]
    T4["T4: 迁移 shared/"]
    T5["T5: 迁移 scripts/docs"]
    T6["T6: tsconfig 统一"]
    T1 --> T2
    T1 --> T3
    T1 --> T4
    T1 --> T5
    T1 --> T6
  end

  subgraph "Phase 2 — Worker 扩展"
    T7["T7: D1 Migration 0006"]
    T8["T8: Worker API 扩展 + 测试"]
    T9["T9: context 端点扩展"]
    T7 --> T8
    T7 --> T9
  end

  subgraph "Phase 3 — 插件双模式"
    T10["T10: Provider 接口定义"]
    T11["T11: LocalProvider 实现"]
    T12["T12: RemoteProvider 实现"]
    T13["T13: MemoryManager 改造"]
    T14["T14: 插件入口 + 配置"]
    T15["T15: 端到端集成测试"]
    T10 --> T11
    T10 --> T12
    T11 --> T13
    T12 --> T14
    T10 --> T13
    T13 --> T14
    T14 --> T15
  end

  subgraph "Phase 4 — 清理"
    T16["T16: 删除 MCP 代码"]
    T17["T17: 文档更新"]
    T18["T18: 最终验证"]
  end

  %% 跨 Phase 依赖
  T2 --> T7
  T4 --> T10
  T8 --> T12
  T15 --> T16
  T15 --> T17
  T15 --> T18
```

---

## 执行顺序

| 阶段 | 顺序 | 说明 |
|------|------|------|
| Phase 1 | T1 → {T2, T3, T4, T5, T6} | T1 创建 workspace 后，5 个子任务可并行迁移 |
| Phase 2 | T7 → {T8, T9} | T7 创建 migration 后，T8/T9 可并行（T8 改 API，T9 改 context） |
| Phase 3 | T10 → {T11, T12} → T13 → T14 → T15 | 严格串行：接口 → 实现 → 改造核心 → 入口 → 测试 |
| Phase 4 | {T16, T17, T18} | 三个清理任务可并行执行 |

---

## 任务并行度

```
Phase 1:  T1 ████
          T2   ████
          T3   ████
          T4   ████
          T5   ████
          T6   ████

Phase 2:  T7     ████
          T8       ████
          T9       ████

Phase 3:  T10          ██
          T11            ██
          T12            ██
          T13              ██
          T14                ██
          T15                  ████

Phase 4:  T16                      ██
          T17                      ██
          T18                      ██
```

---

## 总估算

| 维度 | 数值 |
|------|------|
| 任务总数 | 18 |
| 可并行任务 | 10 (T2-T6, T8-T9, T11-T12, T16-T18) |
| 串行关键路径 | T1 → T2 → T7 → T8 → T12 → T14 → T15 → T18 |
| 预估总工时 | ~24-30 小时 |
| Phase 1 工时 | ~6-8 小时 |
| Phase 2 工时 | ~3-4 小时 |
| Phase 3 工时 | ~12-14 小时 |
| Phase 4 工时 | ~3-4 小时 |
