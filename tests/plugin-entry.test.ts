import { beforeAll, beforeEach, expect, test, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
  MemoryPlugin = mod.MemoryPlugin;
});

beforeEach(() => {
  testConfigMode = "local";
  testRemoteConfig = undefined;
  mockCreateProviders.mockClear();
  mockMemoryManagerConstructor.mockClear();
});

test("MemoryPlugin is a function", () => {
  expect(typeof MemoryPlugin).toBe("function");
});

test("local mode does NOT call createProviders (backward compat)", async () => {
  testConfigMode = "local";

  const mockCtx: any = {
    client: { tui: { showToast: mock(async () => {}) } },
  };

  const pluginOutput = await MemoryPlugin(mockCtx);
  expect(pluginOutput).toBeDefined();
  expect(pluginOutput.tool).toBeDefined();
  expect(pluginOutput.config).toBeDefined();

  // local 模式下不调用 createProviders
  expect(mockCreateProviders).toHaveBeenCalledTimes(0);
});

test("remote mode calls createProviders with 'remote' and config", async () => {
  testConfigMode = "remote";
  testRemoteConfig = { apiUrl: "https://mem.example.com", apiKey: "test-key" };

  const mockCtx: any = {
    client: { tui: { showToast: mock(async () => {}) } },
  };

  await MemoryPlugin(mockCtx);

  // remote 模式下调用 createProviders
  expect(mockCreateProviders).toHaveBeenCalledTimes(1);

  // 验证传参：mode="remote"，config 包含 mode 和 remote
  const calls = mockCreateProviders.mock.calls as any[];
  expect(calls[0][0]).toBe("remote");
  expect(calls[0][1].mode).toBe("remote");
  expect(calls[0][1].remote).toEqual({ apiUrl: "https://mem.example.com", apiKey: "test-key" });
});

test("remote mode passes providers to MemoryManager constructor", async () => {
  const mockProviders = {
    vectorIndex: { vectorIndex: true } as any,
    embedding: { embedding: true } as any,
    fileStorage: { fileStorage: true } as any,
  };
  mockCreateProviders.mockReturnValueOnce(Promise.resolve(mockProviders));

  testConfigMode = "remote";
  testRemoteConfig = { apiUrl: "https://mem.example.com", apiKey: "test-key" };

  const mockCtx: any = {
    client: { tui: { showToast: mock(async () => {}) } },
  };

  await MemoryPlugin(mockCtx);

  // MemoryManager 构造函数被调用
  expect(mockMemoryManagerConstructor).toHaveBeenCalledTimes(1);

  // 第二个参数是 providers
  const calls = mockMemoryManagerConstructor.mock.calls as any[];
  expect(calls[0][1]).toBe(mockProviders);
});

test("local mode passes undefined providers to MemoryManager", async () => {
  testConfigMode = "local";

  const mockCtx: any = {
    client: { tui: { showToast: mock(async () => {}) } },
  };

  await MemoryPlugin(mockCtx);

  // MemoryManager 构造函数被调用
  expect(mockMemoryManagerConstructor).toHaveBeenCalledTimes(1);

  // 第二个参数是 undefined（local 模式不注入 providers）
  const calls = mockMemoryManagerConstructor.mock.calls as any[];
  expect(calls[0][1]).toBeUndefined();
});
