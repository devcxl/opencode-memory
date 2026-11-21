import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── 1.1 配置测试 ──────────────────────────────────────────────

import {
  getMemoryDir,
  loadConfig,
  getOpencodeConfigPath,
  getPluginConfigOption,
  isZhLocale,
  isDebugEnabled,
  getPluginConfigObject,
} from "../src/config/runtime.js";

function withHome<T>(homeDir: string, run: () => T): T {
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    return run();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
}

/** 在临时 HOME 下运行，结束后清理 */
function withTempHome(run: (homeDir: string) => void): void {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "opm-config-"));
  try {
    withHome(homeDir, () => run(homeDir));
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

/** 写入 opencode.json（自动创建父目录） */
function writeOpencodeConfig(homeDir: string, config: unknown): void {
  const configPath = path.join(homeDir, ".config", "opencode", "opencode.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");
}

/** 写入原始 opencode.json（用于 JSONC 场景） */
function writeRawOpencodeConfig(homeDir: string, raw: string): void {
  const configPath = path.join(homeDir, ".config", "opencode", "opencode.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, raw, "utf-8");
}

test("getMemoryDir returns .config/opencode/memory on non-Windows", () => {
  const dir = getMemoryDir();
  const home = process.env.HOME || os.homedir();
  // 在非 Windows 上总是 ~/.config/opencode/memory
  if (os.platform() !== "win32") {
    expect(dir).toBe(path.join(home, ".config", "opencode", "memory"));
  }
});

test("loadConfig returns only the local memory directory", () => {
  const cfg = loadConfig();
  // 远程字段（mode / remote）已移除，配置只剩本地目录
  expect(cfg).toEqual({ memoryDir: getMemoryDir() });
});

// ─── 1.1b 远程模式迁移守卫 ─────────────────────────────────────

test("loadConfig rejects legacy V1 remote options", () => {
  withTempHome((homeDir) => {
    writeOpencodeConfig(homeDir, {
      plugin: [
        [
          "@devcxl/opencode-memory",
          {
            mode: "remote",
            remote: {
              apiUrl: "https://mem.example.com",
              apiKey: "test-key",
            },
          },
        ],
      ],
    });

    expect(() => loadConfig()).toThrow(/@devcxl\/cabbage-memory/);
  });
});

test("loadConfig rejects V2 plugins remote options", () => {
  withTempHome((homeDir) => {
    writeOpencodeConfig(homeDir, {
      plugins: [
        "@example/other",
        {
          package: "@devcxl/opencode-memory",
          options: {
            mode: "remote",
            remote: { apiUrl: "https://v2.example.com", apiKey: "v2-key" },
          },
        },
      ],
    });

    expect(() => loadConfig()).toThrow(/Remote mode is no longer supported/);
  });
});

test("loadConfig rejects leftover remote options without mode", () => {
  withTempHome((homeDir) => {
    writeOpencodeConfig(homeDir, {
      plugin: [
        [
          "@devcxl/opencode-memory",
          { remote: { apiUrl: "https://mem.example.com" } },
        ],
      ],
    });

    expect(() => loadConfig()).toThrow(/@devcxl\/cabbage-memory/);
  });
});

test("loadConfig rejects OPM_MODE=remote even when config is local", () => {
  const previousMode = process.env.OPM_MODE;

  try {
    process.env.OPM_MODE = "remote";
    withTempHome((homeDir) => {
      writeOpencodeConfig(homeDir, {
        plugin: [["@devcxl/opencode-memory", { mode: "local" }]],
      });

      expect(() => loadConfig()).toThrow(/@devcxl\/cabbage-memory/);
    });
  } finally {
    if (previousMode === undefined) delete process.env.OPM_MODE;
    else process.env.OPM_MODE = previousMode;
  }
});

test("loadConfig rejects remote options passed at runtime", () => {
  withTempHome((homeDir) => {
    writeOpencodeConfig(homeDir, {
      plugins: [
        {
          package: "@devcxl/opencode-memory",
          options: { mode: "local" },
        },
      ],
    });

    expect(() =>
      loadConfig({
        mode: "remote",
        remote: { apiUrl: "https://options.example.com", apiKey: "option-key" },
      }),
    ).toThrow(/@devcxl\/cabbage-memory/);
  });
});

test("loadConfig accepts local options", () => {
  withTempHome((homeDir) => {
    writeOpencodeConfig(homeDir, {
      plugin: [["@devcxl/opencode-memory", { mode: "local" }]],
    });

    expect(loadConfig({ dtype: "q8" })).toEqual({
      memoryDir: path.join(homeDir, ".config", "opencode", "memory"),
    });
  });
});

// ─── 1.1c 插件配置读取 ─────────────────────────────────────────

test("getPluginConfigObject returns the full plugin options object", () => {
  withTempHome((homeDir) => {
    writeOpencodeConfig(homeDir, {
      plugin: [
        [
          "@devcxl/opencode-memory",
          { dtype: "q8", embeddingModel: "jina-embeddings-v2-base-zh" },
        ],
      ],
    });

    const opts = getPluginConfigObject();
    expect(opts).toBeDefined();
    expect(opts!.dtype).toBe("q8");
    expect(opts!.embeddingModel).toBe("jina-embeddings-v2-base-zh");
  });
});

test("getPluginConfigObject supports V2 plugins object entries", () => {
  withTempHome((homeDir) => {
    writeOpencodeConfig(homeDir, {
      plugins: [
        "@example/other",
        {
          package: "@devcxl/opencode-memory",
          options: { dtype: "fp16" },
        },
      ],
    });

    const opts = getPluginConfigObject();
    expect(opts).toBeDefined();
    expect(opts!.dtype).toBe("fp16");
  });
});

test("getPluginConfigObject returns undefined when no opencode-memory plugin entry", () => {
  withTempHome((homeDir) => {
    writeOpencodeConfig(homeDir, {
      plugin: [["@example/other", { dtype: "q4" }]],
    });

    expect(getPluginConfigObject()).toBeUndefined();
  });
});

test("getPluginConfigObject handles JSONC trailing comma (real-world opencode.json structure)", () => {
  withTempHome((homeDir) => {
    // 模拟真实 opencode.json：包含 trailing comma 的数组和其他 JSONC 特性
    const jsoncConfig = `{
  "provider": {
    "openai": {
      "whitelist": [
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
      ]
    }
  },
  "plugin": [
    ["/path/to/opencode-memory/dist/index.js", {
      "dtype": "q8",
      "embeddingModel": "nomic-embed-text-v1.5",
    }]
  ]
}`;
    writeRawOpencodeConfig(homeDir, jsoncConfig);

    const opts = getPluginConfigObject();
    expect(opts).toBeDefined();
    expect(opts!.dtype).toBe("q8");
    expect(opts!.embeddingModel).toBe("nomic-embed-text-v1.5");
  });
});

test("isZhLocale true when LANG starts with zh", () => {
  const prev = process.env.LANG;
  try {
    process.env.LANG = "zh_CN.UTF-8";
    expect(isZhLocale()).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.LANG;
    else process.env.LANG = prev;
  }
});

test("isZhLocale false when LANG is en_US", () => {
  const prev = process.env.LANG;
  try {
    process.env.LANG = "en_US.UTF-8";
    expect(isZhLocale()).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.LANG;
    else process.env.LANG = prev;
  }
});

test("isDebugEnabled true when OPM_DEBUG=1", () => {
  const prev = process.env.OPM_DEBUG;
  try {
    process.env.OPM_DEBUG = "1";
    expect(isDebugEnabled()).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.OPM_DEBUG;
    else process.env.OPM_DEBUG = prev;
  }
});

test("isDebugEnabled false when OPM_DEBUG is not set", () => {
  const prev = process.env.OPM_DEBUG;
  try {
    delete process.env.OPM_DEBUG;
    expect(isDebugEnabled()).toBe(false);
  } finally {
    if (prev !== undefined) process.env.OPM_DEBUG = prev;
  }
});

test("getPluginConfigOption reads opencode-memory plugin option", () => {
  withTempHome((homeDir) => {
    writeOpencodeConfig(homeDir, {
      plugin: [
        ["@example/other", { dtype: "q4" }],
        ["@devcxl/opencode-memory", { dtype: "q8" }],
      ],
    });

    expect(getPluginConfigOption("dtype")).toBe("q8");
  });
});

test("getPluginConfigOption falls back on invalid opencode config and logs warning", () => {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) =>
    warnings.push(args.map(String).join(" "));

  try {
    withTempHome((homeDir) => {
      writeRawOpencodeConfig(homeDir, "{ invalid json");

      expect(getPluginConfigOption("dtype")).toBeUndefined();
      expect(warnings.some((w) => w.includes("Failed to parse"))).toBe(true);
    });
  } finally {
    console.warn = origWarn;
  }
});

test("getPluginConfigObject parses JSONC with line/block comments and preserves URLs inside strings", () => {
  withTempHome((homeDir) => {
    const jsoncConfig = `{
  // 顶部行注释
  "$schema": "https://opencode.ai/config.json",
  /* 多行
     块注释 */
  "note": "literal // and /* comment */ and ,} inside string",
  "plugins": [
    {
      "package": "@devcxl/opencode-memory",
      "options": {
        "dtype": "q8", // 行尾注释在逗号后
        "embeddingModel": "jina-embeddings-v2-base-zh",
      },
    },
  ],
}`;
    writeRawOpencodeConfig(homeDir, jsoncConfig);

    const opts = getPluginConfigObject();
    expect(opts).toBeDefined();
    expect(opts!.dtype).toBe("q8");
    expect(opts!.embeddingModel).toBe("jina-embeddings-v2-base-zh");
  });
});

test("getPluginConfigOption handles JSONC trailing comma", () => {
  withTempHome((homeDir) => {
    const jsoncConfig = `{
  "plugin": [
    ["@devcxl/opencode-memory", {
      "dtype": "q8",
    }]
  ]
}`;
    writeRawOpencodeConfig(homeDir, jsoncConfig);

    expect(getPluginConfigOption("dtype")).toBe("q8");
  });
});

test("getOpencodeConfigPath points at ~/.config/opencode/opencode.json", () => {
  withTempHome((homeDir) => {
    expect(getOpencodeConfigPath()).toBe(
      path.join(homeDir, ".config", "opencode", "opencode.json"),
    );
  });
});

// ─── 1.2 embedding 配置测试 ────────────────────────────────────

import {
  MODEL_PRESETS,
  VALID_DTYPES,
  resolveModel,
  resolveDtype,
  EMBEDDING_MODEL,
  EMBEDDING_DTYPE,
} from "../src/config/embedding.js";

test("MODEL_PRESETS has expected entries", () => {
  expect(Object.keys(MODEL_PRESETS)).toContain("nomic-embed-text-v1.5");
  expect(Object.keys(MODEL_PRESETS)).toContain("jina-embeddings-v2-base-zh");
  expect(MODEL_PRESETS).toHaveProperty("jina-embeddings-v2-base-zh");
  expect(MODEL_PRESETS["nomic-embed-text-v1.5"].dimensions).toBe(768);
  expect(MODEL_PRESETS["jina-embeddings-v2-base-zh"].dimensions).toBe(768);
});

test("VALID_DTYPES contains expected values", () => {
  expect(VALID_DTYPES.has("fp32")).toBe(true);
  expect(VALID_DTYPES.has("fp16")).toBe(true);
  expect(VALID_DTYPES.has("q8")).toBe(true);
  expect(VALID_DTYPES.has("invalid")).toBe(false);
});

test("resolveModel returns default when no config and no zh locale", () => {
  const result = resolveModel(() => undefined, false);
  expect(result.modelId).toBe("nomic-ai/nomic-embed-text-v1.5");
});

test("resolveModel returns zh preset when locale is zh", () => {
  const result = resolveModel(() => undefined, true);
  expect(result.modelId).toBe("Xenova/jina-embeddings-v2-base-zh");
});

test("resolveModel returns config model when valid", () => {
  const result = resolveModel(
    (key: string) =>
      key === "embeddingModel" ? "jina-embeddings-v2-base-zh" : undefined,
    false,
  );
  expect(result.modelId).toBe("Xenova/jina-embeddings-v2-base-zh");
});

test("resolveModel falls back on invalid config model", () => {
  const result = resolveModel(
    (key: string) => (key === "embeddingModel" ? "nonexistent" : undefined),
    false,
  );
  expect(result.modelId).toBe("nomic-ai/nomic-embed-text-v1.5");
});

test("resolveDtype returns fp32 by default", () => {
  const result = resolveDtype(() => undefined);
  expect(result).toBe("fp32");
});

test("resolveDtype returns config dtype when valid", () => {
  const result = resolveDtype((key: string) =>
    key === "dtype" ? "q8" : undefined,
  );
  expect(result).toBe("q8");
});

test("resolveDtype falls back on invalid config dtype", () => {
  const result = resolveDtype((key: string) =>
    key === "dtype" ? "invalid" : undefined,
  );
  expect(result).toBe("fp32");
});

test("EMBEDDING_MODEL and EMBEDDING_DTYPE are resolved constants", () => {
  expect(EMBEDDING_MODEL).toBeDefined();
  expect(EMBEDDING_MODEL.modelId).toBeDefined();
  expect(EMBEDDING_DTYPE).toBeDefined();
  expect(VALID_DTYPES.has(EMBEDDING_DTYPE)).toBe(true);
});

// ─── 1.3 MemoryPaths 路径派生测试 ──────────────────────────────

import { MemoryPaths } from "../src/memory/MemoryPaths.js";
import {
  VectorStore,
  filterCurrentSearchResults,
  isCurrentEmbeddingMetadata,
} from "../src/search/vector-store.js";
import { getCurrentDtype, getCurrentModelId } from "../src/search/embedding.js";

test("MemoryPaths derives root memory file path", () => {
  const paths = new MemoryPaths("/home/user/.config/opencode/memory");
  expect(paths.memoryPath).toBe("/home/user/.config/opencode/memory/MEMORY.md");
});

test("MemoryPaths derives identity file path", () => {
  const paths = new MemoryPaths("/tmp/mem");
  expect(paths.identityPath).toBe("/tmp/mem/IDENTITY.md");
});

test("MemoryPaths derives user file path", () => {
  const paths = new MemoryPaths("/tmp/mem");
  expect(paths.userPath).toBe("/tmp/mem/USER.md");
});

test("MemoryPaths derives bootstrap file path", () => {
  const paths = new MemoryPaths("/tmp/mem");
  expect(paths.bootstrapPath).toBe("/tmp/mem/BOOTSTRAP.md");
});

test("MemoryPaths derives daily file path", () => {
  const paths = new MemoryPaths("/tmp/mem");
  expect(paths.dailyPath("2026-06-06")).toBe("/tmp/mem/daily/2026-06-06.md");
});

test("MemoryPaths derives project directory path", () => {
  const paths = new MemoryPaths("/tmp/mem");
  expect(paths.projectDir("owner/repo")).toBe("/tmp/mem/projects/owner/repo");
});

test("MemoryPaths derives project memory file path", () => {
  const paths = new MemoryPaths("/tmp/mem");
  expect(paths.projectMemoryPath("owner/repo")).toBe(
    "/tmp/mem/projects/owner/repo/MEMORY.md",
  );
});

test("MemoryPaths derives root index path", () => {
  const paths = new MemoryPaths("/tmp/mem");
  expect(paths.rootIndexPath).toBe("/tmp/mem/root.index");
});

test("MemoryPaths derives daily index path", () => {
  const paths = new MemoryPaths("/tmp/mem");
  expect(paths.dailyIndexPath).toBe("/tmp/mem/daily.index");
});

test("MemoryPaths dailyDir and projectsDir", () => {
  const paths = new MemoryPaths("/tmp/mem");
  expect(paths.dailyDir).toBe("/tmp/mem/daily");
  expect(paths.projectsDir).toBe("/tmp/mem/projects");
});

test("isCurrentEmbeddingMetadata accepts current embedding metadata", () => {
  expect(
    isCurrentEmbeddingMetadata({
      embeddingModel: getCurrentModelId(),
      embeddingDtype: getCurrentDtype(),
    }),
  ).toBe(true);
});

test("isCurrentEmbeddingMetadata rejects stale embedding metadata", () => {
  expect(
    isCurrentEmbeddingMetadata({
      embeddingModel: "old-model",
      embeddingDtype: getCurrentDtype(),
    }),
  ).toBe(false);
});

test("filterCurrentSearchResults removes stale embedding results", () => {
  const results = filterCurrentSearchResults([
    {
      score: 0.99,
      item: {
        metadata: {
          embeddingModel: "old-model",
          embeddingDtype: getCurrentDtype(),
          filePath: "/tmp/old.md",
          heading: "",
          text: "stale result",
        },
      },
    },
    {
      score: 0.5,
      item: {
        metadata: {
          embeddingModel: getCurrentModelId(),
          embeddingDtype: getCurrentDtype(),
          filePath: "/tmp/current.md",
          heading: "",
          text: "current result",
        },
      },
    },
  ]);

  expect(results.map((result) => result.text)).toEqual(["current result"]);
});

test("VectorStore.resolveIndexPath routes global, daily, and project files under its memoryDir", () => {
  const store = new VectorStore("/custom/mem");
  expect(store.resolveIndexPath("/custom/mem/MEMORY.md")).toBe(
    "/custom/mem/root.index",
  );
  expect(store.resolveIndexPath("/custom/mem/daily/2026-11-21.md")).toBe(
    "/custom/mem/daily.index",
  );
  expect(
    store.resolveIndexPath("/custom/mem/projects/owner/repo/MEMORY.md"),
  ).toBe("/custom/mem/projects/owner/repo/root.index");
  expect(
    store.resolveIndexPath(
      "/custom/mem/projects/owner/repo/daily/2026-11-21.md",
    ),
  ).toBe("/custom/mem/projects/owner/repo/root.index");
});

test("VectorStore.refreshStaleIndices cleans stale project embeddings strictly inside custom memoryDir", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opm-vec-"));
  const customMemDir = path.join(tmpRoot, "custom-memory");
  const projFile = path.join(
    customMemDir,
    "projects",
    "owner",
    "repo",
    "MEMORY.md",
  );

  try {
    fs.mkdirSync(path.dirname(projFile), { recursive: true });
    fs.writeFileSync(projFile, "project knowledge", "utf-8");

    const store = new VectorStore(customMemDir);
    await store.upsertFile(projFile, [
      {
        vector: [1, 0, 0],
        metadata: {
          filePath: projFile,
          heading: "",
          text: "project knowledge",
          hash: "h1",
          embeddingModel: "legacy-model-v0",
          embeddingDtype: getCurrentDtype(),
        },
      },
    ]);

    const stalePaths = await store.refreshStaleIndices();
    expect(stalePaths).toEqual([projFile]);

    // 清理后，同一项目索引查询不再返回 stale 结果
    const remaining = await store.searchProject("owner/repo", [1, 0, 0], 5);
    expect(remaining).toHaveLength(0);
    // 确保项目索引仅生成在 customMemDir 内
    expect(
      fs.existsSync(
        path.join(customMemDir, "projects", "owner", "repo", "root.index"),
      ),
    ).toBe(true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
