import { beforeAll, beforeEach, expect, test, mock } from "bun:test";
import { createV2Harness } from "./support/v2-plugin-harness.js";

// ─── mock 模块 ────────────────────────────────────────────

const mockCreateProviders = mock(async () => ({
  vectorIndex: { kind: "mock" } as any,
  embedding: { kind: "mock" } as any,
  fileStorage: { kind: "mock" } as any,
}));

const mockMemoryManagerInstance = {
  ensureDirectories: mock(async () => {}),
  getInitState: mock(() => "ready"),
  getBootstrapPath: mock(() => "/fake/bootstrap.md"),
  readFile: mock(() => ""),
  getContextFiles: mock(() => []),
} as any;

const mockMemoryManagerConstructor = mock(
  (_config: any, _providers?: any) => mockMemoryManagerInstance,
);

// 测试用状态：控制 loadConfig 的返回值
let testConfigMode: "local" | "remote" = "local";
let testRemoteConfig: { apiUrl: string; apiKey: string } | undefined;

mock.module("@opencode/plugin", () => ({
  Plugin: {
    define: (plugin: unknown) => plugin,
  },
}));

mock.module("../src/config/runtime.js", () => ({
  loadConfig: () => ({
    memoryDir: "/tmp/test-memory",
    mode: testConfigMode,
    remote: testRemoteConfig,
  }),
  getMemoryDir: () => "/tmp/test-memory",
  getOpencodeConfigPath: () => "/fake/config.json",
  getPluginConfigOption: () => undefined,
  isZhLocale: () => false,
  isDebugEnabled: () => false,
}));

mock.module("../src/providers/factory.js", () => ({
  createProviders: mockCreateProviders,
}));

mock.module("../src/memory/MemoryManager.js", () => ({
  MemoryManager: mockMemoryManagerConstructor,
}));

mock.module("../src/memory/BootstrapManager.js", () => ({
  BootstrapManager: class {
    isBootstrapNeeded() {
      return false;
    }
  },
}));

mock.module("../src/utils/projectDetector.js", () => ({
  detectProject: () => null,
}));

mock.module("../src/instructions/memoryInstructions.js", () => ({
  getMemoryAwarenessInstructions: () => "",
  BOOTSTRAP_INSTRUCTIONS: "",
  MEMORY_INIT_PROMPT: "Initialize memory.",
}));

mock.module("../src/utils/validation.js", () => ({
  validateAction: () => {},
}));

mock.module("../src/utils/defaultProject.js", () => ({
  resolveProjectId: () => undefined,
}));

// ─── 测试 ─────────────────────────────────────────────────

// 动态导入以确保 mock 先生效
let MemoryPlugin: any;

beforeAll(async () => {
  const mod = await import("../src/index.js");
  MemoryPlugin = mod.default;
});

beforeEach(() => {
  testConfigMode = "local";
  testRemoteConfig = undefined;
  mockCreateProviders.mockClear();
  mockMemoryManagerConstructor.mockClear();
});

test("default export is a V2 plugin definition", () => {
  expect(MemoryPlugin.id).toBe("devcxl.opencode-memory");
  expect(typeof MemoryPlugin.setup).toBe("function");
  expect(MemoryPlugin.server).toBeUndefined();
});

test("local mode does NOT call createProviders", async () => {
  const harness = await createV2Harness(MemoryPlugin);

  expect(mockCreateProviders).toHaveBeenCalledTimes(0);
  expect(mockMemoryManagerConstructor).toHaveBeenCalledTimes(1);
  expect(mockMemoryManagerConstructor.mock.calls[0][1]).toBeUndefined();

  // V2 注册面：工具、命令、hook 都必须存在
  expect(harness.memoryTool()).toBeDefined();
  expect(harness.commandNames()).toContain("memory-init");

  await harness.cleanup();
});

test("remote mode calls createProviders and injects providers", async () => {
  testConfigMode = "remote";
  testRemoteConfig = { apiUrl: "https://mem.example.com", apiKey: "test-key" };

  const mockProviders = {
    vectorIndex: { vectorIndex: true } as any,
    embedding: { embedding: true } as any,
    fileStorage: { fileStorage: true } as any,
  };
  mockCreateProviders.mockReturnValueOnce(Promise.resolve(mockProviders));

  const harness = await createV2Harness(MemoryPlugin);

  expect(mockCreateProviders).toHaveBeenCalledTimes(1);
  const calls = mockCreateProviders.mock.calls as any[];
  expect(calls[0][0]).toBe("remote");
  expect(calls[0][1].mode).toBe("remote");
  expect(calls[0][1].remote).toEqual({
    apiUrl: "https://mem.example.com",
    apiKey: "test-key",
  });

  expect(mockMemoryManagerConstructor).toHaveBeenCalledTimes(1);
  expect(mockMemoryManagerConstructor.mock.calls[0][1]).toBe(mockProviders);

  await harness.cleanup();
});

test("context hook injects memory context as a text system part", async () => {
  mockMemoryManagerInstance.getContextFiles.mockReturnValueOnce([
    { name: "MEMORY.md", content: "remember this" },
  ]);

  const harness = await createV2Harness(MemoryPlugin);
  const system = await harness.buildSystem();

  expect(system).toContain("# Memory Context");
  expect(system).toContain("remember this");

  await harness.cleanup();
});

test("execute.after records memory calls and triggers daily reminder", async () => {
  const harness = await createV2Harness(MemoryPlugin);

  await harness.triggerToolAfter("memory", {
    action: "write",
    target: "memory",
  });

  const system = await harness.buildSystem();
  expect(system).toContain("Memory Reminder");

  await harness.cleanup();
});
