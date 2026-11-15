import { beforeAll, beforeEach, expect, test, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createV2Harness } from "./support/v2-plugin-harness.js";

// ─── mock 模块 ────────────────────────────────────────────
// 只 mock 远程 Provider 工厂，避免替换 MemoryManager / config 等
// 其它测试文件也依赖的模块（Bun 1.4 的 module mock 会跨文件生效）。

const mockCreateProviders = mock(async () => ({
  vectorIndex: { kind: "mock" } as any,
  embedding: { kind: "mock" } as any,
  fileStorage: { kind: "mock" } as any,
}));

mock.module("../src/providers/factory.js", () => ({
  createProviders: mockCreateProviders,
}));

// ─── 测试工具 ─────────────────────────────────────────────

let MemoryPlugin: any;

beforeAll(async () => {
  const mod = await import("../src/index.js");
  MemoryPlugin = mod.default;
});

beforeEach(() => {
  mockCreateProviders.mockClear();
});

/** 在临时 HOME 下运行，确保读写的是隔离的 memory 目录 */
async function withTempHome(run: (memoryDir: string) => Promise<void>) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "opm-plugin-entry-"));
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;

  try {
    await run(path.join(homeDir, ".config", "opencode", "memory"));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

// ─── 测试 ─────────────────────────────────────────────────

test("default export is a V2 plugin definition", () => {
  expect(MemoryPlugin.id).toBe("devcxl.opencode-memory");
  expect(typeof MemoryPlugin.setup).toBe("function");
  expect(MemoryPlugin.server).toBeUndefined();
});

test("local mode does NOT call createProviders", async () => {
  await withTempHome(async () => {
    const harness = await createV2Harness(MemoryPlugin, {
      options: { mode: "local" },
    });

    expect(mockCreateProviders).toHaveBeenCalledTimes(0);

    // V2 注册面：工具、命令、hook 都必须存在
    expect(harness.memoryTool()).toBeDefined();
    expect(harness.commandNames()).toContain("memory-init");

    await harness.cleanup();
  });
});

test("remote mode calls createProviders with remote config", async () => {
  await withTempHome(async () => {
    const harness = await createV2Harness(MemoryPlugin, {
      options: {
        mode: "remote",
        remote: {
          apiUrl: "https://mem.example.com",
          apiKey: "test-key",
        },
      },
    });

    expect(mockCreateProviders).toHaveBeenCalledTimes(1);
    const calls = mockCreateProviders.mock.calls as any[];
    expect(calls[0][0]).toBe("remote");
    expect(calls[0][1].mode).toBe("remote");
    expect(calls[0][1].remote).toEqual({
      apiUrl: "https://mem.example.com",
      apiKey: "test-key",
    });

    await harness.cleanup();
  });
});

test("context hook injects memory context as a text system part", async () => {
  await withTempHome(async (memoryDir) => {
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, "MEMORY.md"),
      "remember this",
      "utf-8",
    );

    const harness = await createV2Harness(MemoryPlugin, {
      options: { mode: "local" },
    });
    const system = await harness.buildSystem();

    expect(system).toContain("# Memory Context");
    expect(system).toContain("remember this");

    await harness.cleanup();
  });
});

test("execute.after records memory calls and triggers daily reminder", async () => {
  await withTempHome(async () => {
    const harness = await createV2Harness(MemoryPlugin, {
      options: { mode: "local" },
    });

    await harness.triggerToolAfter("memory", {
      action: "write",
      target: "memory",
    });

    const system = await harness.buildSystem();
    expect(system).toContain("Memory Reminder");

    await harness.cleanup();
  });
});
