# Design: extract-config-responsibilities

## Overview

把配置相关职责从业务 Implementation 中抽到明确 seam：运行时配置、embedding 配置、memory 路径派生。目标不是增加抽象数量，而是让调用方 Interface 更小，提升 locality 和测试 leverage。

## Goals

1. 配置来源集中：读取 home、opencode.json、插件配置、环境变量的逻辑有单一入口。
2. embedding 实现变薄：`embedding.ts` 只负责 transformers pipeline 生命周期、缓存检查、文本向量化。
3. memory 路径集中：`MemoryManager` 和 `vector-store` 不重复拼接同一套路径规则。
4. 行为保持：用户文件、索引文件、模型选择和 dtype fallback 不发生可见变化。
5. 测试更稳定：通过配置 Module 或路径 Module 测试行为，减少粗粒度 module mock。

## Constraints

- 最小可行改动，不引入新依赖。
- 不新增用户配置项。
- 不改变 OpenCode plugin 对外 tool schema。
- 不改变模型加载 import 顺序要求；`TRANSFORMERS_VERBOSITY` 和 `ORT_LOGGING_LEVEL` 的设置若依赖 import 前执行，需要保留在安全位置。
- `vector-store.ts` 当前有模块级单例索引，重构必须避免测试和运行时复用错误路径的索引实例。

## Technical Approach

### 1. 运行时配置 Module

新增 `src/config/runtime.ts`，承载运行时配置来源：

- `MemoryConfig`
- `getMemoryDir()`
- `loadConfig()`
- `getOpencodeConfigPath()`
- `getPluginConfigOption(key)`
- `isDebugEnabled()`
- locale 读取辅助函数

现有 `src/utils/config.ts` 不再作为配置实现承载点。实现时可选择删除它并更新 imports，或短期作为 re-export 过渡；若没有外部消费者证据，优先更新内部 imports，避免无意义兼容层。

当前 `ensureDir()` 不属于配置职责，应迁移到 `src/utils/fs.ts` 或等价文件系统工具 Module。

### 2. embedding 配置 Module

新增 `src/config/embedding.ts`，负责：

- `EmbeddingModelConfig`
- `QuantizationDtype`
- `MODEL_PRESETS`
- `VALID_DTYPES`
- `resolveEmbeddingConfig()` 或等价函数，返回 `{ model, dtype }`
- `getCurrentModelId()` / `getCurrentDtype()` 所需的数据来源

`src/search/embedding.ts` 只导入解析后的 model/dtype，不再关心配置来自 opencode.json、locale 还是 env。

### 3. memory 路径 Module

新增 `src/memory/MemoryPaths.ts` 或 `src/config/memoryPaths.ts`。推荐放在 `src/memory/MemoryPaths.ts`，因为路径是 memory 存储拓扑，不是用户配置本身。

该 Module 从 `memoryDir` 派生：

- `dailyDir`
- `memoryPath`
- `identityPath`
- `userPath`
- `bootstrapPath`
- `dailyPath(date)`
- `projectsDir`
- `projectDir(projectId)`
- `projectMemoryPath(projectId)`
- `rootIndexPath`
- `dailyIndexPath`

`MemoryManager` 持有 `MemoryPaths`，把当前路径拼接逻辑迁移过去。`vector-store.ts` 使用同一 Module 计算 root/daily index 路径，保持索引文件位置不变。

### 4. projectDetector 对齐配置来源

`src/utils/projectDetector.ts` 使用 `getMemoryDir()` 或 `loadConfig().memoryDir` 判断 memory 目录，而不是硬编码 `~/.config/opencode/memory`。

### 5. 测试策略

- 保留 `tests/high-risk.test.ts` 作为回归保护。
- 为配置 Module 增加小范围单元测试，覆盖 memory dir、opencode plugin option、embedding model/dtype fallback。
- 为 `MemoryPaths` 增加路径派生测试，覆盖 root、daily、project、index 路径。
- 更新现有 mock 路径，避免继续 mock `src/utils/config.js` 的旧实现。

## Alternatives Considered

| 方案 | 结论 | 原因 |
|------|------|------|
| 只扩展 `src/utils/config.ts` | 不采用 | 仍然把核心 seam 放在 `utils`，命名无法表达配置职责，Depth 不够。 |
| 新增一个大型 `Config` class | 不采用 | 当前配置无生命周期和可变状态，用 class 会增加 Interface 面积，不符合最小改动。 |
| 一次性完整依赖注入 vector-store | 暂缓 | 能进一步提升测试 seam，但会触及模块级索引单例和更多调用方，适合后续变更。 |
| 只抽 embedding 配置 | 不足 | 能解决最大泄漏点，但无法处理 `MemoryManager`/`projectDetector`/`vector-store` 的路径职责泄漏。 |

## Impacted Files / Modules

| 文件 / Module | 影响 |
|---------------|------|
| `src/config/runtime.ts` | 新增运行时配置来源 Module |
| `src/config/embedding.ts` | 新增 embedding 配置解析 Module |
| `src/memory/MemoryPaths.ts` | 新增 memory 路径派生 Module |
| `src/utils/fs.ts` | 承载 `ensureDir()` 等文件系统 helper |
| `src/search/embedding.ts` | 删除配置解析职责，仅保留 pipeline/cache/embed |
| `src/memory/MemoryManager.ts` | 使用 `MemoryPaths`，减少路径拼接职责 |
| `src/search/vector-store.ts` | 复用 `MemoryPaths` 获取 root/daily index 路径 |
| `src/utils/projectDetector.ts` | 复用统一 memoryDir 配置来源 |
| `src/types.ts` | 移除或迁移 `MemoryConfig`/`DEFAULT_CONFIG` |
| `tests/high-risk.test.ts` | 更新 mock 和回归断言 |

## Risks and Mitigations

| 风险 | 缓解 |
|------|------|
| embedding 配置读取时机变化 | 保持 import-time 解析行为，测试 env/opencode 配置优先级。 |
| 路径集中后改错导致数据文件位置变化 | `MemoryPaths` 单元测试逐项断言现有路径。 |
| `vector-store` 单例继续持有旧路径 | 不在本变更中引入多 memoryDir 并发；测试中重置模块或沿用现有 mock 方式。 |
| 删除 `src/utils/config.ts` 影响内部 imports | 全局搜索并一次性更新内部 imports，运行 typecheck。 |
| 抽象过度 | 不新增 class，不新增 Adapter，除非实现时发现两个以上真实 Adapter。 |
