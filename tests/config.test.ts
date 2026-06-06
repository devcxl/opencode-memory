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

test("getMemoryDir returns .config/opencode/memory on non-Windows", () => {
  const dir = getMemoryDir();
  const home = process.env.HOME || os.homedir();
  // 在非 Windows 上总是 ~/.config/opencode/memory
  if (os.platform() !== "win32") {
    expect(dir).toBe(path.join(home, ".config", "opencode", "memory"));
  }
});

test("loadConfig returns memoryDir from getMemoryDir", () => {
  const cfg = loadConfig();
  expect(cfg.memoryDir).toBe(getMemoryDir());
  expect(typeof cfg.memoryDir).toBe("string");
  expect(cfg.memoryDir.length).toBeGreaterThan(0);
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
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "opm-config-"));
  try {
    withHome(homeDir, () => {
      const configPath = getOpencodeConfigPath();
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          plugin: [
            ["@example/other", { dtype: "q4" }],
            ["@devcxl/opencode-memory", { dtype: "q8" }],
          ],
        }),
        "utf-8",
      );

      expect(getPluginConfigOption("dtype")).toBe("q8");
    });
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("getPluginConfigOption falls back on invalid opencode config", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "opm-config-"));
  try {
    withHome(homeDir, () => {
      const configPath = getOpencodeConfigPath();
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, "{ invalid json", "utf-8");

      expect(getPluginConfigOption("dtype")).toBeUndefined();
    });
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
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
  const result = resolveDtype(
    (key: string) => (key === "dtype" ? "q8" : undefined),
  );
  expect(result).toBe("q8");
});

test("resolveDtype falls back on invalid config dtype", () => {
  const result = resolveDtype(
    (key: string) => (key === "dtype" ? "invalid" : undefined),
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
