---
name: "插件入口 + 配置"
phase: 3
depends_on: ["T11", "T12", "T13"]
labels: ["backend", "config"]
worktree_root: ".worktree/t14-plugin-entry-config/"
test_commands:
  - "bun test"
  - "pnpm exec tsc --noEmit"
verify_commands:
  - "bun test"
  - "pnpm exec tsc --noEmit"
  - "pnpm run build"
tdd:
  mode: strict
  min_cycles: 2
acceptance:
  - criteria: "MemoryConfig 扩展 mode, remote 字段"
    verification_type: test
    test_command: "pnpm exec tsc --noEmit"
  - criteria: "loadConfig() 读取 opencode.json 的 mode/remote 配置"
    verification_type: test
    test_command: "bun test"
  - criteria: "配置优先级：opencode.json > OPM_MODE 环境变量 > 默认 'local'"
    verification_type: test
    test_command: "bun test"
  - criteria: "opencode.json 中 apiKey: 'env://OPM_API_KEY' 格式正确解析为环境变量"
    verification_type: test
    test_command: "bun test"
  - criteria: "src/index.ts 初始化时调用 createProviders(config.mode, config) 注入 MemoryManager"
    verification_type: test
    test_command: "bun test"
  - criteria: "mode=local 时 MemoryManager 行为无回归"
    verification_type: test
    test_command: "bun test tests/high-risk.test.ts"
  - criteria: "vectra 和 @huggingface/transformers 标记为 optionalDependencies"
    verification_type: manual
  - criteria: "pnpm install 不因缺少 optionalDependencies 失败"
    verification_type: manual
---

# T14: 插件入口 + 配置

**阶段**：Phase 3 — 插件双模式
**依赖**：T11（LocalProvider）, T12（RemoteProvider）, T13（MemoryManager 改造）
**标签**：`backend`, `config`
**预估**：1.5h

## 目标

扩展插件配置系统和入口初始化逻辑，使插件支持 mode=local|remote 的运行时切换。

## 背景

所有 Provider 和 MemoryManager 改造完成后，需要在入口层（`src/index.ts` 和 `src/config/runtime.ts`）串联起来，根据配置动态创建 Provider 并注入 MemoryManager。

## 实现步骤

### 1. 扩展 `MemoryConfig` 类型（`src/config/runtime.ts`）

```typescript
export interface RemoteConfig {
  apiUrl: string;
  apiKey: string;
}

export type MemoryMode = "local" | "remote";

export interface MemoryConfig {
  memoryDir: string;
  mode: MemoryMode;          // 🆕 默认 "local"
  remote?: RemoteConfig;     // 🆕 mode=remote 时必填
}
```

### 2. 扩展 `loadConfig()`

```typescript
export function loadConfig(): MemoryConfig {
  const memoryDir = getMemoryDir();

  // 从 opencode.json 读取插件配置
  const mode = getPluginConfigOption("mode") as MemoryMode | undefined;
  const remoteApiUrl = getPluginConfigOption("remote")?.["apiUrl"];
  const remoteApiKeyRaw = getPluginConfigOption("remote")?.["apiKey"];

  // 解析 apiKey（支持 env:// 前缀引用环境变量）
  let remoteApiKey: string | undefined;
  if (remoteApiKeyRaw?.startsWith("env://")) {
    remoteApiKey = process.env[remoteApiKeyRaw.slice(6)];
  } else {
    remoteApiKey = remoteApiKeyRaw;
  }

  // 环境变量覆盖
  const effectiveMode = (process.env.OPM_MODE as MemoryMode) || mode || "local";

  const config: MemoryConfig = {
    memoryDir,
    mode: effectiveMode,
  };

  if (effectiveMode === "remote") {
    const apiKey = process.env.OPM_API_KEY || remoteApiKey;
    if (!apiKey) {
      throw new Error("Remote mode requires apiKey. Set OPM_API_KEY or configure remote.apiKey in opencode.json.");
    }
    config.remote = {
      apiUrl: remoteApiUrl || process.env.OPM_API_URL || "",
      apiKey,
    };
  }

  return config;
}
```

### 3. 更新 `src/index.ts`

在 `MemoryPlugin` 中注入 Provider：

```typescript
import { createProviders } from "./providers/factory.js";

export const MemoryPlugin: Plugin = async (ctx: PluginInput) => {
  const config = loadConfig();

  // 🆕 根据 mode 创建 Provider 实例
  let providers: Providers | undefined;
  if (config.mode === "remote" && config.remote) {
    providers = await createProviders("remote", config);
  }
  // local 模式：不注入 providers，MemoryManager 走 legacy 路径（向后兼容）
  // 或者注入 LocalProvider（取决于 T11 的完成度）

  const memoryManager = new MemoryManager(config, providers);
  // ... 其余不变
```

**关于 local 模式的处理**：
- 方案 A（推荐）：local 模式也注入 LocalProvider，验证 Provider 包装的正确性
- 方案 B：local 模式不注入，走 MemoryManager 的 legacy 路径（确保零风险）
- 选择取决于 T11 的稳定性。如果 LocalProvider 测试完全通过，选方案 A。

### 4. 标记可选依赖 `package.json`

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "^1.2.6"
  },
  "optionalDependencies": {
    "@huggingface/transformers": "4.0.0-next.4",
    "vectra": "^0.12.3"
  }
}
```

### 5. 新增配置工具函数（可选）

```typescript
// src/providers/remote/config.ts
export function resolveConfig(config: MemoryConfig): RemoteConfig {
  if (!config.remote) {
    throw new Error("Remote config is required for remote mode");
  }
  if (!config.remote.apiUrl) {
    throw new Error("remote.apiUrl is required");
  }
  if (!config.remote.apiKey) {
    throw new Error("remote.apiKey is required. Use 'env://VAR_NAME' format to reference env vars.");
  }
  return config.remote;
}
```

### 6. 验证

```bash
bun test                          # 全量回归
bun test tests/high-risk.test.ts  # 高风险回归
pnpm exec tsc --noEmit            # 类型检查
pnpm run build                    # 构建验证
```

## 文件变更

| 操作 | 文件 |
|------|------|
| ✏️ 修改 | `src/config/runtime.ts`（扩展 MemoryConfig + loadConfig） |
| ✏️ 修改 | `src/index.ts`（Provider 注入逻辑） |
| ✏️ 修改 | `src/types.ts`（新增 MemoryMode 等类型） |
| ✏️ 修改 | `package.json`（vectra/huggingface → optionalDependencies） |

## 注意事项

- **env:// 前缀解析**：`"apiKey": "env://OPM_API_KEY"` 表示从环境变量 `OPM_API_KEY` 读取值，避免在配置文件中硬编码 JWT
- **local 模式默认值**：当 opencode.json 未配置 mode 且未设 OPM_MODE 环境变量时，默认 `local`
- **向前兼容**：mode 字段不存在时 （旧版 opencode.json），默认 `local`
- **可选依赖**：`vectra` 和 `@huggingface/transformers` 的 `optionalDependencies` 标记不影响本地模式用户（pnpm 默认安装 optional deps），但允许 remote 模式用户跳过安装
- `onnnxruntime-node` 的 `overrides` 配置可能有冲突，需检查
