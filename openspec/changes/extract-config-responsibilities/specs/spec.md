# Spec: extract-config-responsibilities

## Requirements

1. **统一配置来源**：项目必须有独立配置 Module 负责运行时配置来源，包括 memory 目录、opencode 配置文件路径、插件配置项和 debug 开关。
2. **embedding 配置独立**：`src/search/embedding.ts` 不应直接读取 `opencode.json`、`OPM_EMBEDDING_MODEL`、`OPM_EMBEDDING_DTYPE`、locale 或 debug 环境变量来决定模型配置。
3. **路径派生独立**：memory root、daily、project、index 路径必须由独立路径 Module 派生，业务 Module 不应重复拼接同一类路径规则。
4. **保留现有行为**：memory 目录、模型选择优先级、dtype fallback、索引文件位置、project memory 路径必须与现有行为一致。
5. **调用方变薄**：`MemoryManager`、`embedding.ts`、`projectDetector.ts`、`vector-store.ts` 只消费配置或路径结果，不承担配置解析实现。
6. **测试覆盖配置 seam**：配置读取、embedding 配置优先级、路径派生和 projectDetector 排除 memory 目录行为必须有测试或现有 high-risk 测试覆盖。

## Behavior

### 场景一：默认 memory 目录

- macOS/Linux 下，默认 memory 目录保持为 `~/.config/opencode/memory`。
- Windows 下，默认 memory 目录保持为 `%APPDATA%/opencode/memory` 对应路径。
- `loadConfig()` 返回的 `memoryDir` 与当前行为一致。

### 场景二：embedding model 配置

- 若 `opencode.json` 的 `opencode-memory` 插件配置包含有效 `embeddingModel`，优先使用该模型。
- 若插件配置模型无效，记录 debug 信息并按原有 fallback 继续。
- 若未配置插件模型且系统 locale 为中文，使用中文 embedding preset。
- 若未命中 locale 规则且 `OPM_EMBEDDING_MODEL` 有效，使用环境变量模型。
- 否则使用默认 `nomic-embed-text-v1.5`。

### 场景三：embedding dtype 配置

- 若 `opencode.json` 的插件配置包含有效 `dtype`，优先使用该 dtype。
- 若插件配置 dtype 无效，记录 debug 信息并按原有 fallback 继续。
- 若 `OPM_EMBEDDING_DTYPE` 有效，使用环境变量 dtype。
- 否则使用 `fp32`。

### 场景四：memory 路径派生

- root memory 文件仍位于 `{memoryDir}/MEMORY.md`。
- identity 文件仍位于 `{memoryDir}/IDENTITY.md`。
- user 文件仍位于 `{memoryDir}/USER.md`。
- bootstrap 文件仍位于 `{memoryDir}/BOOTSTRAP.md`。
- daily 文件仍位于 `{memoryDir}/daily/{date}.md`。
- project memory 文件仍位于 `{memoryDir}/projects/{projectId}/MEMORY.md`。
- root index 仍位于 `{memoryDir}/root.index`。
- daily index 仍位于 `{memoryDir}/daily.index`。

### 场景五：projectDetector memory 目录排除

- `detectProject()` 必须使用统一配置来源判断当前路径是否位于 memory 目录内。
- 不允许继续硬编码 `~/.config/opencode/memory`。
- Windows/macOS/Linux 路径行为必须与 `getMemoryDir()` 保持一致。

## Acceptance Criteria

- [ ] `embedding.ts` 不再包含 `getPluginConfigOption()`、`resolveModel()`、`resolveDtype()` 或 model preset 定义。
- [ ] `projectDetector.ts` 不再硬编码 `~/.config/opencode/memory`。
- [ ] `MemoryManager` 中重复的 root/daily/project 路径拼接被迁移到路径 Module。
- [ ] `vector-store.ts` 的 root/daily index 路径从路径 Module 获取，索引文件位置不变。
- [ ] `DEFAULT_CONFIG` 被删除或改为真实可用配置，不再保留误导性空默认值。
- [ ] `bun test` 通过。
- [ ] `bun run typecheck` 通过。
- [ ] `bun run build` 通过。
