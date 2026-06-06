# Tasks: extract-config-responsibilities

## Baseline

- [x] 0.1 运行 `bun test` 记录当前测试基线。
- [x] 0.2 运行 `bun run typecheck` 记录当前类型检查基线。

## Implementation

- [x] 1.1 新增或更新配置测试，覆盖 `getMemoryDir()`、`loadConfig()`、`getPluginConfigOption()`、debug 开关和 locale 读取行为。
- [x] 1.2 新增 embedding 配置测试，覆盖 opencode 配置、locale、env、默认值、无效值 fallback 的现有优先级。
- [x] 1.3 新增 `MemoryPaths` 路径派生测试，断言 root、daily、project、root index、daily index 路径与现有行为一致。
- [x] 1.4 新增 `src/config/runtime.ts`，迁移 `MemoryConfig`、`getMemoryDir()`、`loadConfig()`、opencode 配置文件路径、插件配置读取、debug/locale 相关逻辑。
- [x] 1.5 新增 `src/utils/fs.ts`，把 `ensureDir()` 从配置实现中移出，并更新调用方 import。
- [x] 1.6 新增 `src/config/embedding.ts`，迁移 model preset、dtype 校验、model/dtype 解析逻辑，并保持 import-time 解析行为不变。
- [x] 1.7 更新 `src/search/embedding.ts`，删除本地配置解析逻辑，仅保留 transformers pipeline、缓存检查、`embedText()`、状态查询函数。
- [x] 1.8 新增 `src/memory/MemoryPaths.ts`，集中实现 memory root、daily、project、index 路径派生。
- [x] 1.9 更新 `src/memory/MemoryManager.ts` 使用 `MemoryPaths`，删除重复路径拼接和未使用配置 import。
- [x] 1.10 更新 `src/search/vector-store.ts` 使用 `MemoryPaths` 获取 root/daily index 路径，保持模块级索引单例行为不变。
- [x] 1.11 更新 `src/utils/projectDetector.ts` 使用统一配置来源判断 memory 目录，移除硬编码 `~/.config/opencode/memory`。
- [x] 1.12 更新内部 imports 和测试 mock，不保留无必要的 `src/utils/config.ts` 兼容层；若保留，必须只作为临时 re-export 并在任务中说明原因。
- [x] 1.13 删除或修正 `DEFAULT_CONFIG`，避免保留 `memoryDir: ""` 的误导性默认配置。

## Verification

- [x] 2.1 运行 `bun test tests/high-risk.test.ts`，验证高风险回归。
- [x] 2.2 运行 `bun test`，验证全部测试。
- [x] 2.3 运行 `bun run typecheck`，验证 TypeScript 类型。
- [x] 2.4 运行 `bun run build`，验证发布构建。
- [x] 2.5 搜索确认 `embedding.ts` 不再包含 `getPluginConfigOption()`、`resolveModel()`、`resolveDtype()` 或 model preset 定义。
- [x] 2.6 搜索确认 `projectDetector.ts` 不再硬编码 `~/.config/opencode/memory`。
- [x] 2.7 搜索确认 `src/utils/config.ts` 不再承载配置实现；若文件仍存在，只能是明确说明过的临时 re-export。

## Risk Mapping

- [x] 3.1 embedding 配置读取时机风险：用 opencode 配置、env、locale 测试覆盖优先级和 fallback。
- [x] 3.2 路径变更风险：用 `MemoryPaths` 测试逐项覆盖现有文件和索引位置。
- [x] 3.3 vector-store 单例路径风险：运行 high-risk 测试，并确认不引入多 memoryDir 并发语义。
- [x] 3.4 projectDetector 平台路径风险：用 `getMemoryDir()` 测试或 mock 覆盖 memory 目录排除行为。

## Verification Notes
- bun test: 14 pass, 0 fail; bun run typecheck: 通过
- bun test: 40 pass, 0 fail; bun run typecheck: OK; bun run build: OK; embedding.ts: 无配置解析代码; projectDetector: 无硬编码路径; config.ts: 已删除; DEFAULT_CONFIG: 已移除
- code-review 后补充修复：vector-store 初始化时删除 stale embedding metadata，并在查询结果中过滤非当前 model/dtype；补充 getPluginConfigOption 测试和 metadata 测试；bun test: 44 pass, 0 fail; bun run typecheck: OK; bun run build: OK; bun run format:check: OK
- 复审建议后补充 filterCurrentSearchResults 行为测试，直接覆盖 stale + current 混合结果只返回 current；bun test: 45 pass, 0 fail; bun run typecheck: OK; bun run build: OK; bun run format:check: OK
