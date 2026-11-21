import { beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createV2Harness } from "./support/v2-plugin-harness.js";
import { withTempHome } from "./support/temp-home.js";

// ─── 测试工具 ─────────────────────────────────────────────

let MemoryPlugin: any;

beforeAll(async () => {
  const mod = await import("../src/index.js");
  MemoryPlugin = mod.default;
});

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

test("context hook splits static instructions, frozen memory context, and dynamic reminder into ordered SystemParts", async () => {
  await withTempHome(async (memoryDir) => {
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, "MEMORY.md"),
      "ordered part content",
      "utf-8",
    );

    const harness = await createV2Harness(MemoryPlugin, { options: {} });
    const partsBefore = await harness.buildSystemParts("s1");
    expect(partsBefore).toHaveLength(2);
    expect(partsBefore[0].text).not.toContain("ordered part content");
    expect(partsBefore[1].text).toContain("# Memory Context");
    expect(partsBefore[1].text).toContain('<memory-context data-only="true">');
    expect(partsBefore[1].text).toContain("ordered part content");
    expect(partsBefore[1].text).toContain("</memory-context>");

    await harness.triggerToolAfter(
      "memory",
      { action: "write", target: "memory" },
      "s1",
    );
    const partsAfter = await harness.buildSystemParts("s1");
    expect(partsAfter).toHaveLength(3);
    expect(partsAfter[0].text).toBe(partsBefore[0].text);
    expect(partsAfter[2].text).toContain("Memory Reminder");

    await harness.cleanup();
  });
});

test("session context snapshot stays frozen across external disk edits until memory write or compaction", async () => {
  await withTempHome(async (memoryDir) => {
    fs.mkdirSync(memoryDir, { recursive: true });
    const memoryFile = path.join(memoryDir, "MEMORY.md");
    fs.writeFileSync(memoryFile, "initial snapshot", "utf-8");

    const harness = await createV2Harness(MemoryPlugin, { options: {} });
    const first = await harness.buildSystemParts("s-freeze");
    expect(first[1].text).toContain("initial snapshot");

    // 外部修改磁盘内容，在未失效前同会话前缀保持冻结不变
    fs.writeFileSync(memoryFile, "updated on disk", "utf-8");
    const second = await harness.buildSystemParts("s-freeze");
    expect(second[1].text).toBe(first[1].text);
    expect(second[1].text).not.toContain("updated on disk");

    // 写 daily 不失效注入快照
    await harness.triggerToolAfter(
      "memory",
      { action: "write", target: "daily" },
      "s-freeze",
    );
    const afterDaily = await harness.buildSystemParts("s-freeze");
    expect(afterDaily[1].text).toBe(first[1].text);

    // 写 memory 使当前会话快照失效，立即读取最新内容
    await harness.triggerToolAfter(
      "memory",
      { action: "write", target: "memory" },
      "s-freeze",
    );
    const afterMemoryWrite = await harness.buildSystemParts("s-freeze");
    expect(afterMemoryWrite[1].text).toContain("updated on disk");

    // 再次外部修改后触发 compaction，快照同样失效并重建
    fs.writeFileSync(memoryFile, "post-compaction content", "utf-8");
    await harness.triggerCompaction("s-freeze");
    const afterCompaction = await harness.buildSystemParts("s-freeze");
    expect(afterCompaction[1].text).toContain("post-compaction content");

    await harness.cleanup();
  });
});

test("session.deleted clears session context cache", async () => {
  await withTempHome(async (memoryDir) => {
    fs.mkdirSync(memoryDir, { recursive: true });
    const memoryFile = path.join(memoryDir, "MEMORY.md");
    fs.writeFileSync(memoryFile, "before delete", "utf-8");

    const harness = await createV2Harness(MemoryPlugin, { options: {} });
    const before = await harness.buildSystem("s-del");
    expect(before).toContain("before delete");

    fs.writeFileSync(memoryFile, "after delete", "utf-8");
    await harness.emitEvent({
      type: "session.deleted",
      data: { sessionID: "s-del" },
    });

    const after = await harness.buildSystem("s-del");
    expect(after).toContain("after delete");

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

test("execute.after does not trigger daily reminder for read-only memory actions", async () => {
  await withTempHome(async () => {
    const harness = await createV2Harness(MemoryPlugin, { options: {} });

    await harness.triggerToolAfter("memory", {
      action: "read",
      target: "memory",
    });
    await harness.triggerToolAfter("memory", {
      action: "search",
    });

    const system = await harness.buildSystem();
    expect(system).not.toContain("Memory Reminder");

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

// ─── M3 (v2.1-T5 & v2.1-T6): Compaction Flush 与 /memory-consolidate ───

test("compaction flush persists extracted decisions to daily log once per cycle", async () => {
  await withTempHome(async (memoryDir) => {
    let generateCalls = 0;
    const harness = await createV2Harness(MemoryPlugin, {
      options: {},
      generateText: async () => {
        generateCalls++;
        return {
          text: "- Decided to use hybrid search (0.7 vector / 0.3 BM25) for code recall",
        };
      },
    });

    const longMessages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Let us decide the search ranking strategy for opencode-memory so symbol queries and semantic queries both rank reliably.",
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "We agreed on 0.7 vector + 0.3 BM25 with 30-day decay applied only to daily logs and minScore checked before decay.",
          },
        ],
      },
    ];

    const first = await harness.triggerCompaction("s-compact", longMessages);
    expect(generateCalls).toBe(1);
    expect(
      first.system.some((p) => p.text.includes("persisted to daily")),
    ).toBe(true);

    const today = new Date().toISOString().slice(0, 10);
    const candidates = [
      path.join(memoryDir, "daily", `${today}.md`),
      ...(() => {
        const found: string[] = [];
        const walk = (dir: string) => {
          if (!fs.existsSync(dir)) return;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name === `${today}.md`) found.push(full);
          }
        };
        walk(path.join(memoryDir, "projects"));
        return found;
      })(),
    ];
    const dailyPath = candidates.find((p) => fs.existsSync(p));
    expect(dailyPath).toBeDefined();
    const content = fs.readFileSync(dailyPath!, "utf-8");
    expect(content).toContain("## Compaction Flush");
    expect(content).toContain("0.7 vector / 0.3 BM25");

    // 同一消息快照重试 compaction 不重复抽取
    await harness.triggerCompaction("s-compact", longMessages);
    expect(generateCalls).toBe(1);

    await harness.cleanup();
  });
});

test("compaction flush errors never block compaction", async () => {
  await withTempHome(async () => {
    const harness = await createV2Harness(MemoryPlugin, {
      options: {},
      generateText: async () => {
        throw new Error("provider overloaded");
      },
    });

    const longMessages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "A sufficiently long engineering conversation discussing architecture decisions and trade-offs in detail.",
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Confirmed architecture trade-offs and documented deployment checklist for production rollout.",
          },
        ],
      },
    ];

    await expect(
      harness.triggerCompaction("s-fail", longMessages),
    ).resolves.toBeDefined();

    await harness.cleanup();
  });
});

test("/memory-consolidate gathers non-external recent daily logs and prompts with budget info", async () => {
  await withTempHome(async (memoryDir) => {
    const today = new Date().toISOString().slice(0, 10);
    const dailyDir = path.join(memoryDir, "daily");
    fs.mkdirSync(dailyDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, "MEMORY.md"),
      "<!-- 2026-11-20 10:00:00 -->\nExisting curated fact",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(dailyDir, `${today}.md`),
      [
        "<!-- 2026-11-21 10:00:00 | origin: agent -->",
        "Adopted KeyedAsyncMutex for file locking",
        "",
        "<!-- 2026-11-21 11:00:00 | origin: external -->",
        "Untrusted third-party snippet that must not be promoted",
      ].join("\n"),
      "utf-8",
    );

    const prompts: Array<{ sessionID: string; text: string }> = [];
    const harness = await createV2Harness(MemoryPlugin, {
      options: {},
      onSessionPrompt: (input) => prompts.push(input),
    });

    expect(harness.commandNames()).toContain("memory-consolidate");
    await harness.runCommand("memory-consolidate", "s-cons", "global 7");

    expect(prompts).toHaveLength(1);
    expect(prompts[0].text).toContain("Current budget usage:");
    expect(prompts[0].text).toContain("Adopted KeyedAsyncMutex");
    expect(prompts[0].text).not.toContain("Untrusted third-party snippet");

    await harness.cleanup();
  });
});
