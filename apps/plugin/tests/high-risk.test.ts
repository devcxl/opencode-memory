import { beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mock } from "bun:test";

const embeddedTexts: string[] = [];
const upsertCalls: Array<{ filePath: string; chunks: any[] }> = [];
const projectStoreBasePaths: string[] = [];
const semanticSearchCalls: number[] = [];
let semanticResults: any[] = [];
let projectSemanticResults: any[] = [];
let currentModelId = "mock-embedding-model";
let currentDtype = "fp32";

mock.module("../src/search/embedding.js", () => ({
  embedText: async (text: string) => {
    embeddedTexts.push(text);
    return [Math.max(text.length, 1)];
  },
  getEmbedder: async () => ({}),
  getCurrentDtype: () => currentDtype,
  getCurrentModelId: () => currentModelId,
  getEmbeddingDimensions: () => 384,
  initEmbedder: async () => {},
  isInitialized: async () => true,
}));

mock.module("../src/search/vector-store.js", () => ({
  upsertFile: async (filePath: string, chunks: any[]) => {
    upsertCalls.push({ filePath, chunks });
  },
  deleteFileVectors: async () => {},
  refreshStaleIndices: async (): Promise<string[]> => [],
  isCurrentEmbeddingMetadata: (metadata: Record<string, unknown> | undefined) =>
    String(metadata?.embeddingModel) === currentModelId &&
    String(metadata?.embeddingDtype) === currentDtype,
  filterCurrentSearchResults: (items: any[]) =>
    items
      .filter(
        (item) =>
          String(item.item.metadata.embeddingModel) === currentModelId &&
          String(item.item.metadata.embeddingDtype) === currentDtype,
      )
      .map((item) => ({
        score: item.score,
        filePath: String(item.item.metadata.filePath),
        heading: String(item.item.metadata.heading),
        text: String(item.item.metadata.text),
        timestamp: item.item.metadata.timestamp
          ? String(item.item.metadata.timestamp)
          : undefined,
      })),
  semanticSearch: async (_queryVector: number[], topK: number) => {
    semanticSearchCalls.push(topK);
    return Number.isFinite(topK)
      ? semanticResults.slice(0, topK)
      : semanticResults;
  },
  checkIndexExists: async () => false,
  ProjectStore: class {
    constructor(basePath: string) {
      projectStoreBasePaths.push(basePath);
    }

    async upsertFile(filePath: string, chunks: any[]) {
      upsertCalls.push({ filePath, chunks });
    }

    async search() {
      return projectSemanticResults;
    }

    async checkExists() {
      return semanticResults.length > 0;
    }
  },
}));

mock.module("@opencode-ai/plugin", () => ({
  tool: Object.assign((definition: any) => definition, {
    schema: {
      enum: () => ({
        optional: () => ({ describe: () => ({}) }),
        describe: () => ({}),
      }),
      number: () => ({ optional: () => ({ describe: () => ({}) }) }),
      string: () => ({ optional: () => ({ describe: () => ({}) }) }),
    },
  }),
}));

// 在 mock 之前保存真实 detectProject，供 L2 测试直接调用（绕过 CI 中 mock 跨文件污染）
const { detectProject: realDetectProject } =
  await import("../src/utils/projectDetector.js");

mock.module("../src/utils/projectDetector.js", () => ({
  detectProject: () => "owner/repo",
}));

const { MemoryManager } = await import("../src/memory/MemoryManager.js");
const { FileSearcher } = await import("../src/memory/FileSearcher.js");
const { handleWrite } = await import("../src/handlers/handleWrite.js");
const { handleRead } = await import("../src/handlers/handleRead.js");
const { handleEdit } = await import("../src/handlers/handleEdit.js");
const { handleDelete } = await import("../src/handlers/handleDelete.js");
const { handleSearch } = await import("../src/handlers/handleSearch.js");
const { resolveProjectId } = await import("../src/utils/defaultProject.js");
const { MemoryPlugin } = await import("../src/index.js");
const { gitCommit } = await import("../src/utils/git.js");

beforeEach(() => {
  embeddedTexts.length = 0;
  upsertCalls.length = 0;
  projectStoreBasePaths.length = 0;
  semanticSearchCalls.length = 0;
  semanticResults = [];
  projectSemanticResults = [];
  currentModelId = "mock-embedding-model";
  currentDtype = "fp32";
});

function makeTempHome(): { homeDir: string; memoryDir: string } {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-memory-"));
  const memoryDir = path.join(homeDir, ".config", "opencode", "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  return { homeDir, memoryDir };
}

async function withHome<T>(
  homeDir: string,
  run: () => T | Promise<T>,
): Promise<T> {
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    return await run();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
}

async function withTempMemory<T>(
  run: (memoryDir: string) => Promise<T>,
): Promise<T> {
  const { homeDir, memoryDir } = makeTempHome();
  try {
    return await withHome(homeDir, async () => run(memoryDir));
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

test("append write indexes the newly written daily content", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({ memoryDir });
    await manager.ensureDirectories();

    await handleWrite(
      {
        target: "daily",
        date: "2026-06-06",
        content: "## Entry\nunique append searchable content",
      },
      manager,
    );

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].filePath).toBe(
      path.join(memoryDir, "daily", "2026-06-06.md"),
    );
    expect(upsertCalls[0].chunks[0].metadata.text).toContain(
      "unique append searchable content",
    );
  });
});

test("indexed chunks include the current embedding model", async () => {
  await withTempMemory(async (memoryDir) => {
    currentModelId = "test-model";
    currentDtype = "q8";
    const manager = new MemoryManager({ memoryDir });
    await manager.ensureDirectories();

    await handleWrite(
      {
        target: "daily",
        date: "2026-06-06",
        content: "## Entry\nmodel metadata content",
      },
      manager,
    );

    expect(upsertCalls[0].chunks[0].metadata.embeddingModel).toBe("test-model");
    expect(upsertCalls[0].chunks[0].metadata.embeddingDtype).toBe("q8");
  });
});

test("gitCommit stages only the memory file, not unrelated parent repo changes", async () => {
  const { homeDir, memoryDir } = makeTempHome();
  const repoDir = path.dirname(memoryDir);

  try {
    fs.mkdirSync(repoDir, { recursive: true });
    git(["init"], repoDir);
    git(["config", "user.name", "Test"], repoDir);
    git(["config", "user.email", "test@example.com"], repoDir);

    const unrelatedPath = path.join(repoDir, "unrelated.txt");
    fs.writeFileSync(unrelatedPath, "initial\n", "utf-8");
    git(["add", "unrelated.txt"], repoDir);
    git(["commit", "-m", "initial"], repoDir);

    fs.writeFileSync(unrelatedPath, "modified\n", "utf-8");
    const memoryFile = path.join(memoryDir, "MEMORY.md");
    fs.writeFileSync(memoryFile, "memory content\n", "utf-8");

    await withHome(homeDir, async () => {
      await gitCommit("Update MEMORY.md", memoryFile, memoryDir);
    });

    expect(
      git(["status", "--porcelain", "--", "unrelated.txt"], repoDir),
    ).toContain("unrelated.txt");
    expect(
      git(["status", "--porcelain", "--", "memory/MEMORY.md"], repoDir),
    ).toBe("");
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("gitCommit does not include unrelated staged changes in the memory commit", async () => {
  const { homeDir, memoryDir } = makeTempHome();
  const repoDir = path.dirname(memoryDir);

  try {
    fs.mkdirSync(repoDir, { recursive: true });
    git(["init"], repoDir);
    git(["config", "user.name", "Test"], repoDir);
    git(["config", "user.email", "test@example.com"], repoDir);

    const unrelatedPath = path.join(repoDir, "unrelated.txt");
    fs.writeFileSync(unrelatedPath, "initial\n", "utf-8");
    git(["add", "unrelated.txt"], repoDir);
    git(["commit", "-m", "initial"], repoDir);

    fs.writeFileSync(unrelatedPath, "staged modification\n", "utf-8");
    git(["add", "unrelated.txt"], repoDir);

    const memoryFile = path.join(memoryDir, "MEMORY.md");
    fs.writeFileSync(memoryFile, "memory content\n", "utf-8");

    await withHome(homeDir, async () => {
      await gitCommit("Update MEMORY.md", memoryFile, memoryDir);
    });

    expect(
      git(["status", "--porcelain", "--", "unrelated.txt"], repoDir),
    ).toStartWith("M  ");
    expect(
      git(["status", "--porcelain", "--", "memory/MEMORY.md"], repoDir),
    ).toBe("");
    expect(
      git(["show", "--name-only", "--pretty=format:", "HEAD"], repoDir).trim(),
    ).toBe("memory/MEMORY.md");
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("gitCommit with extraPaths stages and commits index files alongside the memory file", async () => {
  const { homeDir, memoryDir } = makeTempHome();
  const repoDir = path.dirname(memoryDir);

  try {
    fs.mkdirSync(repoDir, { recursive: true });
    git(["init"], repoDir);
    git(["config", "user.name", "Test"], repoDir);
    git(["config", "user.email", "test@example.com"], repoDir);

    const memoryFile = path.join(memoryDir, "MEMORY.md");
    fs.writeFileSync(memoryFile, "memory content\n", "utf-8");

    const indexPath = path.join(memoryDir, "root.index");
    fs.mkdirSync(indexPath, { recursive: true });
    fs.writeFileSync(
      path.join(indexPath, "data.json"),
      '{"items":[]}',
      "utf-8",
    );

    await withHome(homeDir, async () => {
      await gitCommit("Update MEMORY.md", memoryFile, memoryDir, [indexPath]);
    });

    const committedFiles = git(
      ["show", "--name-only", "--pretty=format:", "HEAD"],
      repoDir,
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(committedFiles).toContain("memory/MEMORY.md");
    expect(committedFiles).toContain("memory/root.index/data.json");
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("project memory rejects path traversal project ids", () => {
  const { homeDir, memoryDir } = makeTempHome();

  try {
    const manager = new MemoryManager({ memoryDir });

    expect(() => manager.getProjectMemoryPath("../../outside")).toThrow();
    expect(() => manager.getProjectMemoryPath("/tmp/outside")).toThrow();
    expect(manager.getProjectMemoryPath("owner/repo")).toBe(
      path.join(memoryDir, "projects", "owner", "repo", "MEMORY.md"),
    );
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("daily path normalizes timestamp and empty date inputs", () => {
  const { homeDir, memoryDir } = makeTempHome();

  try {
    const manager = new MemoryManager({ memoryDir });

    expect(
      manager.getPathForTarget("daily", "2026-06-07 00:00:00").filePath,
    ).toBe(path.join(memoryDir, "daily", "2026-06-07.md"));
    expect(manager.getPathForTarget("daily", "").filePath).toBe(
      path.join(memoryDir, "daily", `${manager.todayStr()}.md`),
    );
    expect(() => manager.getPathForTarget("daily", "bad-date")).toThrow(
      "Invalid timestamp format",
    );
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("nested project memory indexes into the matching owner/repo project store", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({ memoryDir });
    await manager.ensureDirectories();

    await handleWrite(
      {
        target: "memory",
        project: "owner/repo",
        content: "## Project\nnested project searchable content",
      },
      manager,
    );

    expect(projectStoreBasePaths).toContain(
      path.join(memoryDir, "projects", "owner", "repo"),
    );
    expect(upsertCalls[0].filePath).toBe(
      path.join(memoryDir, "projects", "owner", "repo", "MEMORY.md"),
    );
  });
});

test("memory writes default to the detected project when project is omitted", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({ memoryDir });
    await manager.ensureDirectories();

    // resolveProjectId 未指定 scope 时自动检测项目
    const resolved = resolveProjectId(undefined, "owner/repo");
    expect(resolved).toBe("owner/repo");

    await handleWrite(
      {
        target: "memory",
        project: resolved!,
        content: "## Project\ndefault project searchable content",
      },
      manager,
    );

    expect(upsertCalls[0].filePath).toBe(
      path.join(memoryDir, "projects", "owner", "repo", "MEMORY.md"),
    );
    expect(fs.existsSync(path.join(memoryDir, "MEMORY.md"))).toBe(false);
  });
});

test("memory tool writes default to the detected project when project is omitted", async () => {
  await withTempMemory(async (memoryDir) => {
    const hooks = await MemoryPlugin({} as any);

    await hooks.tool!.memory.execute({
      action: "write",
      target: "memory",
      content: "## Project\nplugin default project content",
    });

    expect(upsertCalls[0].filePath).toBe(
      path.join(memoryDir, "projects", "owner", "repo", "MEMORY.md"),
    );
    expect(fs.existsSync(path.join(memoryDir, "MEMORY.md"))).toBe(false);
  });
});

test("memory tool writes to global memory when scope is global", async () => {
  await withTempMemory(async (memoryDir) => {
    const hooks = await MemoryPlugin({} as any);

    await hooks.tool!.memory.execute({
      action: "write",
      target: "memory",
      scope: "global",
      content: "## Global\nplugin global memory content",
    });

    expect(upsertCalls[0].filePath).toBe(path.join(memoryDir, "MEMORY.md"));
    expect(
      fs.existsSync(
        path.join(memoryDir, "projects", "owner", "repo", "MEMORY.md"),
      ),
    ).toBe(false);
  });
});

test("memory tool reads default to the detected project when project is omitted", async () => {
  await withTempMemory(async (memoryDir) => {
    const projectMemoryPath = path.join(
      memoryDir,
      "projects",
      "owner",
      "repo",
      "MEMORY.md",
    );
    fs.mkdirSync(path.dirname(projectMemoryPath), { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, "MEMORY.md"),
      "global content",
      "utf-8",
    );
    fs.writeFileSync(projectMemoryPath, "project content", "utf-8");

    const hooks = await MemoryPlugin({} as any);
    const result = await hooks.tool!.memory.execute({
      action: "read",
      target: "memory",
    });

    expect(result).toStartWith("[scope: project/owner/repo]");
    expect(result).toContain("project content");
  });
});

test("resolveProjectId handles scope correctly", () => {
  // scope=project → 返回检测到的 projectId
  expect(resolveProjectId("project", "owner/repo")).toBe("owner/repo");
  // scope=project 但检测不到 → null（降级全局）
  expect(resolveProjectId("project", null)).toBeNull();
  // scope=global → 强制 null
  expect(resolveProjectId("global", "owner/repo")).toBeNull();
  // 未指定 scope → 自动检测
  expect(resolveProjectId(undefined, "owner/repo")).toBe("owner/repo");
  expect(resolveProjectId(undefined, null)).toBeNull();
  // scope=all → 自动检测
  expect(resolveProjectId("all", "owner/repo")).toBe("owner/repo");
  // 检测到非法 projectId → 降级全局，不阻断 memory 操作
  expect(resolveProjectId("project", "../repo")).toBeNull();
});

// 创建 mock IFileStorageProvider，适配 FileSearcher 的新接口
function makeMockFileStorage(): { readFile: (filePath: string) => Promise<string | null> } {
  return {
    readFile: async (filePath: string) => {
      try {
        return fs.readFileSync(filePath, "utf-8");
      } catch {
        return null;
      }
    },
  };
}

test("semantic search with project scope only returns project results", async () => {
  const { homeDir, memoryDir } = makeTempHome();
  const dailyDir = path.join(memoryDir, "daily");
  const globalFile = path.join(memoryDir, "MEMORY.md");
  const projectFile = path.join(
    memoryDir,
    "projects",
    "owner",
    "repo",
    "MEMORY.md",
  );

  try {
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(globalFile, "global searchable content", "utf-8");
    fs.writeFileSync(projectFile, "project searchable content", "utf-8");

    semanticResults = [
      {
        score: 0.99,
        filePath: globalFile,
        heading: "",
        text: "global searchable content",
      },
    ];
    projectSemanticResults = [
      {
        score: 0.5,
        filePath: projectFile,
        heading: "",
        text: "project searchable content",
      },
    ];

    const fileStorage = makeMockFileStorage();
    const searcher = new FileSearcher(
      memoryDir,
      dailyDir,
      fileStorage as any,
      () =>
        ({
          search: async () => projectSemanticResults,
        }) as any,
    );

    const results = await searcher.semanticSearch(
      "searchable",
      20,
      undefined,
      "owner/repo",
      "project",
    );

    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe(projectFile);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("semantic search with project scope falls back to global without project id", async () => {
  const { homeDir, memoryDir } = makeTempHome();
  const dailyDir = path.join(memoryDir, "daily");
  const globalFile = path.join(memoryDir, "MEMORY.md");

  try {
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(globalFile, "global searchable content", "utf-8");

    semanticResults = [
      {
        score: 0.99,
        filePath: globalFile,
        heading: "",
        text: "global searchable content",
      },
    ];

    const fileStorage = makeMockFileStorage();
    const searcher = new FileSearcher(
      memoryDir,
      dailyDir,
      fileStorage as any,
      () => {
        throw new Error("project store should not be used");
      },
    );

    const results = await searcher.semanticSearch(
      "searchable",
      20,
      undefined,
      null,
      "project",
    );

    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe(globalFile);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("semantic search filters by the matched chunk timestamp", async () => {
  const { homeDir, memoryDir } = makeTempHome();
  const dailyDir = path.join(memoryDir, "daily");
  const dailyFile = path.join(dailyDir, "2026-06-06.md");

  try {
    fs.mkdirSync(dailyDir, { recursive: true });
    fs.writeFileSync(
      dailyFile,
      [
        "<!-- 2026-05-01 10:00:00 -->",
        "old searchable content",
        "",
        "<!-- 2026-06-01 10:00:00 -->",
        "new searchable content",
      ].join("\n"),
      "utf-8",
    );

    semanticResults = [
      {
        score: 0.95,
        filePath: dailyFile,
        heading: "",
        text: "new searchable content",
        timestamp: "2026-06-01 10:00:00",
      },
    ];

    const fileStorage2 = makeMockFileStorage();
    const searcher = new FileSearcher(
      memoryDir,
      dailyDir,
      fileStorage2 as any,
      () => {
        throw new Error("project store should not be used");
      },
    );

    const results = await searcher.semanticSearch(
      "new searchable content",
      20,
      "2026-06",
      null,
    );

    expect(results).toHaveLength(1);
    expect(results[0].timestamp).toBe("2026-06-01 10:00:00");
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("semantic search filters after enough results are retrieved for period", async () => {
  const { homeDir, memoryDir } = makeTempHome();
  const dailyDir = path.join(memoryDir, "daily");
  const dailyFile = path.join(dailyDir, "2026-06-06.md");

  try {
    fs.mkdirSync(dailyDir, { recursive: true });
    fs.writeFileSync(dailyFile, "daily content\n", "utf-8");

    semanticResults = [
      ...Array.from({ length: 101 }, (_, index) => ({
        score: 1 - index / 100,
        filePath: dailyFile,
        heading: "",
        text: `old content ${index}`,
        timestamp: "2026-05-01 10:00:00",
      })),
      {
        score: 0.5,
        filePath: dailyFile,
        heading: "",
        text: "target month content",
        timestamp: "2026-06-01 10:00:00",
      },
    ];

    const fileStorage3 = makeMockFileStorage();
    const searcher = new FileSearcher(
      memoryDir,
      dailyDir,
      fileStorage3 as any,
      () => {
        throw new Error("project store should not be used");
      },
    );

    const results = await searcher.semanticSearch(
      "target",
      20,
      "2026-06",
      null,
    );

    expect(results).toHaveLength(1);
    expect(results[0].text).toBe("target month content");
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("semantic search does not fallback to the first timestamp when multiple entries do not match", async () => {
  const { homeDir, memoryDir } = makeTempHome();
  const dailyDir = path.join(memoryDir, "daily");
  const dailyFile = path.join(dailyDir, "2026-06-06.md");

  try {
    fs.mkdirSync(dailyDir, { recursive: true });
    fs.writeFileSync(
      dailyFile,
      [
        "<!-- 2026-05-01 10:00:00 -->",
        "old searchable content",
        "",
        "<!-- 2026-06-01 10:00:00 -->",
        "new searchable content",
      ].join("\n"),
      "utf-8",
    );

    semanticResults = [
      {
        score: 0.95,
        filePath: dailyFile,
        heading: "",
        text: "unmatched indexed content",
      },
    ];

    const fileStorage4 = makeMockFileStorage();
    const searcher = new FileSearcher(
      memoryDir,
      dailyDir,
      fileStorage4 as any,
      () => {
        throw new Error("project store should not be used");
      },
    );

    const results = await searcher.semanticSearch(
      "unmatched",
      20,
      "2026-05",
      null,
    );

    expect(results).toHaveLength(0);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("semantic search does not bind a cross-entry legacy chunk to the first timestamp", async () => {
  const { homeDir, memoryDir } = makeTempHome();
  const dailyDir = path.join(memoryDir, "daily");
  const dailyFile = path.join(dailyDir, "2026-06-06.md");

  try {
    fs.mkdirSync(dailyDir, { recursive: true });
    fs.writeFileSync(
      dailyFile,
      [
        "<!-- 2026-05-01 10:00:00 -->",
        "old searchable content",
        "",
        "<!-- 2026-06-01 10:00:00 -->",
        "new searchable content",
      ].join("\n"),
      "utf-8",
    );

    semanticResults = [
      {
        score: 0.95,
        filePath: dailyFile,
        heading: "",
        text: "old searchable content\n\nnew searchable content",
      },
    ];

    const fileStorage5 = makeMockFileStorage();
    const searcher = new FileSearcher(
      memoryDir,
      dailyDir,
      fileStorage5 as any,
      () => {
        throw new Error("project store should not be used");
      },
    );

    const results = await searcher.semanticSearch(
      "searchable",
      20,
      "2026-05",
      null,
    );

    expect(results).toHaveLength(0);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

// =============================================================================
// L1: Scope 标签测试
// =============================================================================

test("handleWrite returns [scope: project/...] when project is set", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({ memoryDir });
    await manager.ensureDirectories();

    const result = await handleWrite(
      {
        target: "memory",
        project: "owner/repo",
        content: "project content",
      },
      manager,
    );

    expect(result).toStartWith("[scope: project/owner/repo] ");
  });
});

test("handleWrite returns [scope: global] when project is not set", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({ memoryDir });
    await manager.ensureDirectories();

    const result = await handleWrite(
      {
        target: "memory",
        content: "global content",
      },
      manager,
    );

    expect(result).toStartWith("[scope: global] ");
  });
});

test("handleWrite returns [scope: global] for daily without project", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({ memoryDir });
    await manager.ensureDirectories();

    const result = await handleWrite(
      {
        target: "daily",
        date: "2026-07-20",
        content: "## Entry\nsome daily content",
      },
      manager,
    );

    expect(result).toStartWith("[scope: global] ");
  });
});

test("handleWrite returns [scope: project/...] for daily with project", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({ memoryDir });
    await manager.ensureDirectories();

    const result = await handleWrite(
      {
        target: "daily",
        date: "2026-07-20",
        project: "owner/repo",
        content: "## Entry\nproject daily content",
      },
      manager,
    );

    expect(result).toStartWith("[scope: project/owner/repo] ");
  });
});

test("handleRead returns [scope: project/...] prefix", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({ memoryDir });
    await manager.ensureDirectories();

    const projectMemoryPath = path.join(
      memoryDir,
      "projects",
      "owner",
      "repo",
      "MEMORY.md",
    );
    fs.mkdirSync(path.dirname(projectMemoryPath), { recursive: true });
    fs.writeFileSync(projectMemoryPath, "project content", "utf-8");

    const result = await handleRead(
      { target: "memory", project: "owner/repo" },
      manager,
    );

    expect(result).toStartWith("[scope: project/owner/repo]");
  });
});

test("handleRead returns [scope: global] prefix without project", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({ memoryDir });
    await manager.ensureDirectories();

    fs.writeFileSync(
      path.join(memoryDir, "MEMORY.md"),
      "global content",
      "utf-8",
    );

    const result = await handleRead({ target: "memory" }, manager);

    expect(result).toStartWith("[scope: global]");
  });
});

test("handleEdit returns [scope: ...] prefix", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({ memoryDir });
    await manager.ensureDirectories();

    const filePath = path.join(memoryDir, "MEMORY.md");
    fs.writeFileSync(filePath, "original content", "utf-8");

    // 测试 global
    const globalResult = await handleEdit(
      {
        target: "memory",
        oldString: "original content",
        newString: "updated global",
      },
      manager,
    );
    expect(globalResult).toStartWith("[scope: global] ");

    // 测试 project
    const projPath = path.join(
      memoryDir,
      "projects",
      "owner",
      "repo",
      "MEMORY.md",
    );
    fs.mkdirSync(path.dirname(projPath), { recursive: true });
    fs.writeFileSync(projPath, "project original", "utf-8");

    const projResult = await handleEdit(
      {
        target: "memory",
        project: "owner/repo",
        oldString: "project original",
        newString: "project updated",
      },
      manager,
    );
    expect(projResult).toStartWith("[scope: project/owner/repo] ");
  });
});

test("handleDelete returns [scope: ...] prefix", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({ memoryDir });
    await manager.ensureDirectories();

    const filePath = path.join(memoryDir, "MEMORY.md");
    fs.writeFileSync(
      filePath,
      "<!-- 2026-07-20 10:00:00 -->\nglobal content",
      "utf-8",
    );

    const result = await handleDelete(
      {
        target: "memory",
        timestamp: "2026-07-20 10:00:00",
      },
      manager,
    );

    expect(result).toStartWith("[scope: global] ");
  });
});

test("handleSearch returns [scope: ...] info", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({ memoryDir });
    await manager.ensureDirectories();

    fs.writeFileSync(
      path.join(memoryDir, "MEMORY.md"),
      "searchable content",
      "utf-8",
    );

    semanticResults = [
      {
        score: 0.99,
        filePath: path.join(memoryDir, "MEMORY.md"),
        heading: "",
        text: "searchable content",
      },
    ];

    const result = await handleSearch(
      { query: "searchable", scope: "global" },
      manager,
      null,
    );

    expect(result).toStartWith("[scope: global] ");
  });
});

// =============================================================================
// L3: 项目级 daily 日志测试
// =============================================================================

test("getPathForTarget daily with project routes to project daily dir", () => {
  const { memoryDir } = makeTempHome();

  try {
    const manager = new MemoryManager({ memoryDir });
    const { filePath, displayName } = manager.getPathForTarget(
      "daily",
      "2026-07-20",
      "owner/repo",
    );

    expect(filePath).toBe(
      path.join(
        memoryDir,
        "projects",
        "owner",
        "repo",
        "daily",
        "2026-07-20.md",
      ),
    );
    expect(displayName).toBe("projects/owner/repo/daily/2026-07-20.md");
  } finally {
    fs.rmSync(path.dirname(memoryDir), { recursive: true, force: true });
  }
});

test("getPathForTarget daily without project keeps global path", () => {
  const { memoryDir } = makeTempHome();

  try {
    const manager = new MemoryManager({ memoryDir });
    const { filePath, displayName } = manager.getPathForTarget(
      "daily",
      "2026-07-20",
    );

    expect(filePath).toBe(path.join(memoryDir, "daily", "2026-07-20.md"));
    expect(displayName).toBe("daily/2026-07-20.md");
  } finally {
    fs.rmSync(path.dirname(memoryDir), { recursive: true, force: true });
  }
});

test("project daily write creates file in project daily directory", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({ memoryDir });
    await manager.ensureDirectories();

    await handleWrite(
      {
        target: "daily",
        date: "2026-07-20",
        project: "owner/repo",
        content: "## Entry\nproject daily content",
      },
      manager,
    );

    const expectedPath = path.join(
      memoryDir,
      "projects",
      "owner",
      "repo",
      "daily",
      "2026-07-20.md",
    );
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(upsertCalls[0].filePath).toBe(expectedPath);
  });
});

test("project daily indexes into project store", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({ memoryDir });
    await manager.ensureDirectories();

    await handleWrite(
      {
        target: "daily",
        date: "2026-07-20",
        project: "owner/repo",
        content: "## Entry\nproject daily content for indexing",
      },
      manager,
    );

    // ProjectStore 的 basePath 应该是项目目录
    expect(projectStoreBasePaths).toContain(
      path.join(memoryDir, "projects", "owner", "repo"),
    );
  });
});

test("global daily is unaffected by project daily changes", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({ memoryDir });
    await manager.ensureDirectories();

    // 写入全局 daily
    await handleWrite(
      {
        target: "daily",
        date: "2026-07-20",
        content: "## Entry\nglobal daily content",
      },
      manager,
    );

    const globalPath = path.join(memoryDir, "daily", "2026-07-20.md");
    expect(fs.existsSync(globalPath)).toBe(true);

    // 重置 upsertCalls 便于检查
    upsertCalls.length = 0;

    // 写入项目 daily
    await handleWrite(
      {
        target: "daily",
        date: "2026-07-20",
        project: "owner/repo",
        content: "## Entry\nproject daily content",
      },
      manager,
    );

    const projectPath = path.join(
      memoryDir,
      "projects",
      "owner",
      "repo",
      "daily",
      "2026-07-20.md",
    );
    expect(fs.existsSync(projectPath)).toBe(true);

    // 两个文件应该独立存在
    const globalContent = fs.readFileSync(globalPath, "utf-8");
    const projectContent = fs.readFileSync(projectPath, "utf-8");
    expect(globalContent).toContain("global daily content");
    expect(projectContent).toContain("project daily content");
  });
});

// =============================================================================
// L2: 项目检测测试（直接调用真实 detectProject，不走 mock）
// =============================================================================

function makeDetectorTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opencode-detector-"));
}

function setupDetectorGitRepo(dir: string, remoteUrl?: string): void {
  git(["init"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["config", "user.email", "test@example.com"], dir);

  if (remoteUrl) {
    git(["remote", "add", "origin", remoteUrl], dir);
  }

  // 创建一个初始提交，确保 git rev-parse 能正常工作
  const testFile = path.join(dir, "README.md");
  fs.writeFileSync(testFile, "# Test", "utf-8");
  git(["add", "README.md"], dir);
  git(["commit", "-m", "initial"], dir);
}

test("detectProject with git remote returns owner/repo", () => {
  const dir = makeDetectorTempDir();
  try {
    setupDetectorGitRepo(dir, "https://github.com/test-user/test-repo.git");
    const result = realDetectProject(dir);
    expect(result).toBe("test-user/test-repo");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectProject with SSH remote returns owner/repo", () => {
  const dir = makeDetectorTempDir();
  try {
    setupDetectorGitRepo(dir, "git@github.com:test-user/ssh-repo.git");
    const result = realDetectProject(dir);
    expect(result).toBe("test-user/ssh-repo");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectProject without remote uses repo root basename via git rev-parse", () => {
  const dir = makeDetectorTempDir();
  try {
    const repoName = `test-repo-no-remote-${Date.now()}`;
    const repoDir = path.join(dir, repoName);
    fs.mkdirSync(repoDir, { recursive: true });
    setupDetectorGitRepo(repoDir); // 无 remote

    // 在子目录中运行检测，应取 repo root basename
    const subDir = path.join(repoDir, "src", "components");
    fs.mkdirSync(subDir, { recursive: true });
    const result = realDetectProject(subDir);

    // 应返回 repo root basename + 路径哈希
    expect(result).not.toBeNull();
    expect(result!).toStartWith(repoName);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectProject in non-git directory returns basename + hash", () => {
  const dir = makeDetectorTempDir();
  try {
    const projDir = path.join(dir, "my-script");
    fs.mkdirSync(projDir, { recursive: true });
    const result = realDetectProject(projDir);

    expect(result).not.toBeNull();
    // 格式: my-script.<8 hex chars>
    expect(result!).toMatch(/^my-script\.[0-9a-f]{8}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectProject in subdirectory returns repo root basename", () => {
  const dir = makeDetectorTempDir();
  try {
    const repoDir = path.join(dir, "deep-nested-repo");
    fs.mkdirSync(repoDir, { recursive: true });
    setupDetectorGitRepo(repoDir);

    const subDir = path.join(repoDir, "a", "very", "deep", "path");
    fs.mkdirSync(subDir, { recursive: true });
    const result = realDetectProject(subDir);

    expect(result).not.toBeNull();
    expect(result!).toStartWith("deep-nested-repo");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectProject returns null for home directory", () => {
  const result = realDetectProject(os.homedir());
  expect(result).toBeNull();
});

test("detectProject returns null for dotfiles directory", () => {
  const dotDir = path.join(os.homedir(), ".test-dotfiles-dir");
  fs.mkdirSync(dotDir, { recursive: true });

  try {
    const result = realDetectProject(dotDir);
    expect(result).toBeNull();
  } finally {
    fs.rmSync(dotDir, { recursive: true, force: true });
  }
});

test("detectProject in Projects/ subdirectory is NOT excluded", () => {
  const tmpBase = makeDetectorTempDir();
  const projectsDir = path.join(tmpBase, "Projects");
  const projDir = path.join(projectsDir, "my-app");
  fs.mkdirSync(projDir, { recursive: true });
  setupDetectorGitRepo(projDir, "https://github.com/user/my-app.git");

  try {
    const result = realDetectProject(projDir);
    expect(result).toBe("user/my-app");

    // 子目录也应正确检测
    const subDir = path.join(projDir, "src");
    fs.mkdirSync(subDir, { recursive: true });
    const subResult = realDetectProject(subDir);
    expect(subResult).toBe("user/my-app");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("detectProject produces different IDs for same-named dirs in different paths", () => {
  const dir1 = makeDetectorTempDir();
  const dir2 = makeDetectorTempDir();

  try {
    const proj1 = path.join(dir1, "my-project");
    const proj2 = path.join(dir2, "my-project");
    fs.mkdirSync(proj1, { recursive: true });
    fs.mkdirSync(proj2, { recursive: true });

    const id1 = realDetectProject(proj1);
    const id2 = realDetectProject(proj2);

    expect(id1).not.toBeNull();
    expect(id2).not.toBeNull();
    // 同名目录不同路径应产生不同 ID
    expect(id1).not.toBe(id2);
    // 但都应以 basename 开头
    expect(id1!).toStartWith("my-project.");
    expect(id2!).toStartWith("my-project.");
  } finally {
    fs.rmSync(dir1, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test("detectProject with git@ SSH format", () => {
  const dir = makeDetectorTempDir();
  try {
    setupDetectorGitRepo(dir, "git@github.com:company/product.git");
    const result = realDetectProject(dir);
    expect(result).toBe("company/product");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectProject with HTTPS without .git suffix", () => {
  const dir = makeDetectorTempDir();
  try {
    setupDetectorGitRepo(dir, "https://github.com/org/nosuffix");
    const result = realDetectProject(dir);
    expect(result).toBe("org/nosuffix");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("remote mode appendFile writes single record, not accumulated content", async () => {
  await withTempMemory(async (memoryDir) => {
    const writes: string[] = [];
    const fileStorage = {
      // 模拟 remote 存储语义：readFile 返回该 path 已存在的全部记录
      readFile: async () => writes.join("\n\n") || null,
      writeFile: async (_path: string, content: string) => {
        writes.push(content);
      },
      appendFile: async (_path: string, content: string) => {
        writes.push(content);
      },
      deleteFile: async () => {},
    };
    const manager = new MemoryManager(
      { memoryDir, mode: "remote" },
      {
        vectorIndex: {
          upsert: async () => {},
          search: async () => [],
          delete: async () => {},
        },
        embedding: {
          embedTexts: async () => [],
          dimensions: 384,
          modelId: "mock",
        },
        fileStorage,
      },
    );
    await manager.ensureDirectories();

    const dailyPath = manager.getDailyPath("2026-08-07");
    await manager.appendFile(dailyPath, "第一次记录");
    await manager.appendFile(dailyPath, "第二次记录");

    expect(writes).toHaveLength(2);
    // 每条都只包含自身内容，绝不累积上一次的内容
    expect(writes[0]).not.toContain("第二次记录");
    expect(writes[0]).toContain("第一次记录");
    expect(writes[1]).not.toContain("第一次记录");
    expect(writes[1]).toContain("第二次记录");
    // remote 记录独立存储且时间由服务端决定，不嵌入本地时间戳
    expect(writes[0]).not.toContain("<!--");
    expect(writes[1]).not.toContain("<!--");
  });
});

test("remote mode handleWrite does not return local Timestamp", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager(
      { memoryDir, mode: "remote" },
      {
        vectorIndex: {
          upsert: async () => {},
          search: async () => [],
          delete: async () => {},
        },
        embedding: {
          embedTexts: async () => [],
          dimensions: 384,
          modelId: "mock",
        },
        fileStorage: {
          readFile: async () => null,
          writeFile: async () => {},
          appendFile: async () => {},
          deleteFile: async () => {},
          exists: async () => false,
          listFiles: async () => [],
        },
      },
    );
    await manager.ensureDirectories();

    const result = await handleWrite(
      {
        target: "daily",
        content: "远程日志",
      },
      manager,
    );

    expect(result).toStartWith("[scope: global] Appended to ");
    // 本地时间戳对 remote 无意义，不应返回，避免误导 AI 用错误时间戳删除
    expect(result).not.toContain("Timestamp:");
    expect(result).toContain("read/list");
  });
});

// =============================================================================
// checkLineLimit：local 文件名与 remote 冒号路径均生效
// =============================================================================

test("checkLineLimit throws for local MEMORY.md over limit", async () => {
  const { checkLineLimit } = await import("../src/utils/validation.js");
  const overLimit = Array.from({ length: 1001 }, () => "x").join("\n");
  expect(() => checkLineLimit("/tmp/memory/MEMORY.md", overLimit)).toThrow(
    /line limit/,
  );
});

test("checkLineLimit throws for remote learning:knowledge path over limit", async () => {
  const { checkLineLimit } = await import("../src/utils/validation.js");
  const overLimit = Array.from({ length: 1001 }, () => "x").join("\n");
  expect(() =>
    checkLineLimit("learning:knowledge:global::", overLimit),
  ).toThrow(/line limit/);
});

test("checkLineLimit does not throw for remote daily path over limit", async () => {
  const { checkLineLimit } = await import("../src/utils/validation.js");
  const overLimit = Array.from({ length: 1001 }, () => "x").join("\n");
  expect(() => checkLineLimit("daily::global::2026-08-07", overLimit)).not.toThrow();
});

test("checkLineLimit does not throw within limit", async () => {
  const { checkLineLimit } = await import("../src/utils/validation.js");
  expect(() => checkLineLimit("MEMORY.md", "a\nb\nc")).not.toThrow();
});

// =============================================================================
// remote semanticSearch：全局 + 项目结果按 id 去重
// =============================================================================

test("remote semanticSearch dedupes global and project results by id", async () => {
  const { RemoteFileStorageProvider } = await import(
    "../src/providers/remote/FileStorageProvider.js"
  );
  const { FileSearcher: FileSearcherCls } = await import(
    "../src/memory/FileSearcher.js"
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const body = JSON.parse((init?.body as string) || "{}");
    const isProjectSearch = Boolean(body.project_id);
    const record = {
      id: "r1",
      text: "项目记忆",
      score: isProjectSearch ? 0.95 : 0.7,
      created_at: 1000,
      snippet: "...",
      matchCount: 1,
    };
    return new Response(
      JSON.stringify({
        success: true,
        data: isProjectSearch ? [record] : [record],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const memoryDir = "/tmp/opencode-memory-remote-test";
    const dailyDir = "/tmp/opencode-memory-remote-test/daily";
    const fileStorage = new RemoteFileStorageProvider({
      apiUrl: "https://memory.example.com",
      apiKey: "test-key",
    });
    const searcher = new FileSearcherCls(
      memoryDir,
      dailyDir,
      fileStorage,
      (() => ({})) as never,
      "remote",
    );

    const results = await searcher.semanticSearch(
      "查询",
      20,
      undefined,
      "owner/repo",
      "all",
    );

    // 同一条记录同时被全局搜索和项目搜索召回，去重后只剩一条（取高分 0.95）
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(0.95);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
