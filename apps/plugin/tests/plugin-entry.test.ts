import { beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createV2Harness } from "./support/v2-plugin-harness.js";

// ─── 测试工具 ─────────────────────────────────────────────

let MemoryPlugin: any;

beforeAll(async () => {
  const mod = await import("../src/index.js");
  MemoryPlugin = mod.default;
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

test("local setup registers the memory tool and /memory-init", async () => {
  await withTempHome(async () => {
    const harness = await createV2Harness(MemoryPlugin, { options: {} });

    // V2 注册面：工具、命令、hook 都必须存在
    expect(harness.memoryTool()).toBeDefined();
    expect(harness.commandNames()).toContain("memory-init");

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

    const harness = await createV2Harness(MemoryPlugin, { options: {} });
    const system = await harness.buildSystem();

    expect(system).toContain("# Memory Context");
    expect(system).toContain("remember this");

    await harness.cleanup();
  });
});

test("execute.after records memory calls and triggers daily reminder", async () => {
  await withTempHome(async () => {
    const harness = await createV2Harness(MemoryPlugin, { options: {} });

    await harness.triggerToolAfter("memory", {
      action: "write",
      target: "memory",
    });

    const system = await harness.buildSystem();
    expect(system).toContain("Memory Reminder");

    await harness.cleanup();
  });
});

test("/memory-init creates templates when memory is uninitialized", async () => {
  await withTempHome(async (memoryDir) => {
    const harness = await createV2Harness(MemoryPlugin, { options: {} });

    await harness.runMemoryInit();

    expect(fs.existsSync(path.join(memoryDir, "MEMORY.md"))).toBe(true);
    expect(fs.existsSync(path.join(memoryDir, "BOOTSTRAP.md"))).toBe(true);

    await harness.cleanup();
  });
});

test("/memory-init is a no-op when memory is ready", async () => {
  await withTempHome(async (memoryDir) => {
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, "MEMORY.md"),
      "ready memory",
      "utf-8",
    );
    fs.writeFileSync(path.join(memoryDir, "IDENTITY.md"), "identity", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "USER.md"), "user", "utf-8");

    const harness = await createV2Harness(MemoryPlugin, { options: {} });

    await harness.runMemoryInit();

    // 已就绪时命令保持注册但不创建引导模板、不改写已有文件
    expect(fs.existsSync(path.join(memoryDir, "BOOTSTRAP.md"))).toBe(false);
    expect(fs.readFileSync(path.join(memoryDir, "IDENTITY.md"), "utf-8")).toBe(
      "identity",
    );

    await harness.cleanup();
  });
});

// ─── 远程模式迁移守卫 ──────────────────────────────────────

test("setup rejects mode=remote with a migration error", async () => {
  await withTempHome(async () => {
    await expect(
      createV2Harness(MemoryPlugin, { options: { mode: "remote" } }),
    ).rejects.toThrow(/@devcxl\/cabbage-memory/);
  });
});

test("setup rejects leftover remote options without mode", async () => {
  await withTempHome(async () => {
    await expect(
      createV2Harness(MemoryPlugin, {
        options: {
          remote: { apiUrl: "https://mem.example.com", apiKey: "test-key" },
        },
      }),
    ).rejects.toThrow(/Remote mode is no longer supported/);
  });
});

test("setup rejects OPM_MODE=remote", async () => {
  const previousMode = process.env.OPM_MODE;

  try {
    process.env.OPM_MODE = "remote";
    await withTempHome(async () => {
      await expect(
        createV2Harness(MemoryPlugin, { options: {} }),
      ).rejects.toThrow(/@devcxl\/cabbage-memory/);
    });
  } finally {
    if (previousMode === undefined) delete process.env.OPM_MODE;
    else process.env.OPM_MODE = previousMode;
  }
});
