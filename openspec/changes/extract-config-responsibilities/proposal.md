---
slug: "extract-config-responsibilities"
createdAt: "2026-06-06T12:44:17.092Z"
---

# Proposal: extract-config-responsibilities

## Summary

将配置读取、embedding 配置解析、memory 路径派生从业务实现中抽离为独立 Module，使 `embedding.ts`、`MemoryManager`、`projectDetector`、`vector-store` 不再各自承担配置职责。

## Motivation

当前代码没有满足职责单一原则，主要问题是：

- `src/search/embedding.ts` 同时负责读取 `opencode.json`、读取环境变量、选择模型、选择 dtype、管理模型缓存和初始化 pipeline。
- `src/memory/MemoryManager.ts` 同时负责 memory 操作、路径派生、项目目录派生、ProjectStore 创建。
- `src/search/vector-store.ts` 直接调用 `getMemoryDir()`，绕过入口处已加载的 `MemoryConfig`。
- `src/utils/projectDetector.ts` 硬编码 `~/.config/opencode/memory`，没有复用统一配置来源。
- `src/types.ts` 中 `DEFAULT_CONFIG` 与实际默认路径逻辑分离，容易误导维护者。

这会降低 locality：理解或修改“配置来源”和“存储路径规则”需要跨多个 Module 跳转。也会降低 leverage：测试只能靠粗粒度 module mock 和全局变量模拟配置。

## Scope

- 新增独立配置 Module，统一承载运行时配置来源：memory 目录、opencode 配置文件路径、插件配置项、debug 开关。
- 新增 embedding 配置 Module，集中管理模型 preset、dtype 校验、locale/env/opencode 配置优先级。
- 新增 memory 路径 Module，集中派生 root、daily、project、index 相关路径。
- 更新现有调用方，让业务 Module 只消费已经解析好的配置或路径。
- 更新测试 mock 和必要测试用例，覆盖现有配置优先级与路径行为不变。

## Non-Goals

- 不新增新的用户可见配置项。
- 不改变 memory 文件存储位置。
- 不改变 embedding 模型选择优先级。
- 不改变向量索引文件名、文件结构或搜索语义。
- 不重构 git 提交流程、memory 文件读写语义或 OpenCode tool schema。
- 不引入新依赖。

## Risks

- embedding 配置当前在 import 阶段解析，移动代码可能改变 env/opencode 配置读取时机。
- memory 路径派生集中后，路径细节改错会影响读写、搜索、project memory 隔离。
- `vector-store.ts` 的全局单例索引依赖默认 memoryDir，改动不当会污染测试或跨项目索引。
- `projectDetector.ts` 修复硬编码路径时需要保持 Windows/macOS/Linux 行为一致。
