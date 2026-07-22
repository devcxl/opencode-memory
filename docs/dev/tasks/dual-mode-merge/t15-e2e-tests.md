---
name: "端到端集成测试"
phase: 3
depends_on: ["T14"]
labels: ["backend"]
worktree_root: ".worktree/t15-e2e-tests/"
test_commands:
  - "bun test"
  - "bun test tests/remote-providers.test.ts"
  - "bun test tests/high-risk.test.ts"
verify_commands:
  - "bun test"
  - "pnpm exec tsc --noEmit"
  - "pnpm run build"
tdd:
  mode: strict
  min_cycles: 2
acceptance:
  - criteria: "本地模式：所有现有测试（high-risk.test.ts）通过"
    verification_type: test
    test_command: "bun test tests/high-risk.test.ts"
  - criteria: "远程模式 mock 测试：write/read/search/delete 覆盖全部 CRUD"
    verification_type: test
    test_command: "bun test tests/remote-providers.test.ts"
  - criteria: "远程模式 mock 测试：错误场景 401/429/500 覆盖"
    verification_type: test
    test_command: "bun test tests/remote-providers.test.ts"
  - criteria: "Provider 工厂测试：createProviders('local') 返回正确类型"
    verification_type: test
    test_command: "bun test tests/provider-factory.test.ts"
  - criteria: "Provider 工厂测试：createProviders('remote') 返回正确类型"
    verification_type: test
    test_command: "bun test tests/provider-factory.test.ts"
  - criteria: "MemoryManager 注入测试：使用 mock provider 验证方法委托正确"
    verification_type: test
    test_command: "bun test tests/memorymanager-injection.test.ts"
  - criteria: "配置加载测试：opencode.json mode=remote 正确解析"
    verification_type: test
    test_command: "bun test tests/config.test.ts"
  - criteria: "远程模式手动 E2E：wrangler dev + mode=remote 完整流程"
    verification_type: manual
---

# T15: 端到端集成测试

**阶段**：Phase 3 — 插件双模式
**依赖**：T14（插件入口 + 配置）
**标签**：`backend`
**预估**：2h

## 目标

编写集成测试覆盖双模式下的完整流程，确保 local 模式零回归、remote 模式端到端可用。

## 背景

T11/T12 各自有单元测试，T15 侧重跨模块集成：Provider 工厂 → MemoryManager 注入 → handler 调用链 → 配置解析。同时执行远程模式的手动 E2E 验证。

## 实现步骤

### 1. 创建 `tests/provider-factory.test.ts`

```typescript
import { describe, test, expect } from "bun:test";
import { createProviders } from "../src/providers/factory.js";
import type { MemoryConfig } from "../src/config/runtime.js";

describe("Provider Factory", () => {
  test("createProviders('local') 返回正确的 provider 类型", async () => {
    const config: MemoryConfig = { memoryDir: "/tmp/test-memory", mode: "local" };
    const providers = await createProviders("local", config);
    expect(providers.vectorIndex).toBeDefined();
    expect(providers.embedding).toBeDefined();
    expect(providers.fileStorage).toBeDefined();
    expect(providers.embedding.dimensions).toBeGreaterThan(0);
  });

  test("createProviders('remote') 返回正确的 provider 类型", async () => {
    const config: MemoryConfig = {
      memoryDir: "/tmp/test-memory",
      mode: "remote",
      remote: { apiUrl: "http://localhost:8787", apiKey: "test-token" },
    };
    const providers = await createProviders("remote", config);
    expect(providers.vectorIndex).toBeDefined();
    expect(providers.embedding).toBeDefined();
    expect(providers.fileStorage).toBeDefined();
  });
});
```

### 2. 创建 `tests/memorymanager-injection.test.ts`

```typescript
describe("MemoryManager with injected providers", () => {
  test("writeFile → 委托给 fileStorage.writeFile", async () => {
    const mockFileStorage = { writeFile: mock(async () => {}) };
    const mm = new MemoryManager(config, {
      vectorIndex: {} as any,
      embedding: {} as any,
      fileStorage: mockFileStorage,
    });
    await mm.writeFile("/test/path", "content");
    expect(mockFileStorage.writeFile).toHaveBeenCalledWith("/test/path", "content");
  });

  test("未注入 providers → legacy 路径仍然可用", async () => {
    const mm = new MemoryManager({ memoryDir: "/tmp/test", mode: "local" });
    // 验证 legacy 方法如 fileExists 等仍可正常工作
  });
});
```

### 3. 扩展 `tests/remote-providers.test.ts`

在 T12 的基础上，增加更多错误场景：

```typescript
describe("RemoteProvider error handling", () => {
  test("401 → 抛出认证错误", async () => {
    globalThis.fetch = mock(() => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }));
    const provider = new RemoteFileStorageProvider({ apiUrl: "...", apiKey: "invalid" });
    expect(() => provider.readFile("memory::")).toThrow();
  });

  test("429 → 限流错误", async () => {});
  test("500 → 服务器错误", async () => {});
  test("网络超时 → 错误处理", async () => {});
});
```

### 4. 创建 `tests/config.test.ts`

```typescript
describe("Config loading", () => {
  test("mode 默认 'local'", () => {});
  test("OPM_MODE=remote → config.mode = 'remote'", () => {});
  test("apiKey: 'env://OPM_API_KEY' → 解析环境变量", () => {});
  test("apiKey: 直接字符串 → 原样使用", () => {});
});
```

### 5. 手动 E2E 测试（remote 模式）

使用 `wrangler dev` 启动 Worker，配置插件 mode=remote：

```bash
# 1. 启动 Worker
cd worker && wrangler dev

# 2. 生成 JWT token（使用 scripts/ 中的脚本）
node scripts/generate-jwt.js

# 3. 写入 opencode.json（临时测试用）
# mode=remote, apiUrl=http://localhost:8787, apiKey=<JWT>

# 4. 手动测试完整流程
# - write: memory --action write --target memory --content '测试'
# - search: memory --action search --query '测试'
# - read: memory --action read --target memory
# - delete: memory --action delete --target memory --timestamp '...'
```

### 6. 本地模式回归

```bash
bun test tests/high-risk.test.ts
```

确保所有现有测试无回归。

## 文件变更

| 操作 | 文件 |
|------|------|
| 🆕 新增 | `tests/provider-factory.test.ts` |
| 🆕 新增 | `tests/memorymanager-injection.test.ts` |
| 🆕 新增 | `tests/config.test.ts` |
| ✏️ 修改 | `tests/remote-providers.test.ts`（扩展错误场景） |

## 注意事项

- provider factory 测试在 local 模式下会实际加载 vectra + huggingface（因为 `createProviders('local')` 执行了动态 import），确保测试环境安装了这些依赖
- 如果测试环境中没有 huggingface 模型文件，`embedding.dimensions` 验证可以跳过模型加载，只验证接口存在
- 手动 E2E 测试需要 Worker 运行中且 D1 migration 已执行
- Vectorize 的最终一致性延迟在手动 E2E 中可能遇到（写入后立即搜索找不到），属于已知限制
