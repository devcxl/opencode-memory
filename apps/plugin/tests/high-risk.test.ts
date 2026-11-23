import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MemoryPaths } from "../src/memory/MemoryPaths.js";

const embeddedTexts: string[] = [];
const upsertCalls: Array<{ filePath: string; chunks: any[] }> = [];
const projectStoreBasePaths: string[] = [];
const semanticSearchCalls: number[] = [];
let semanticResults: any[] = [];
let projectSemanticResults: any[] = [];
let currentModelId = "mock-embedding-model";
let currentDtype = "fp32";
/** 控制 mock 的 embedding 引擎就绪状态（默认就绪，便于既有用例按原语义执行索引） */
let mockEmbedderReady = true;

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
  // 测试夹具中的 embedder 默认视为就绪，使写入路径按预期执行索引
  isEmbedderReady: () => mockEmbedderReady,
}));

const { VectorStore } = await import("../src/search/vector-store.js");
let vectorStoreSpies: Array<{
  mockRestore(): void;
  mockImplementation(fn: any): any;
}> = [];

const defaultUpsertImpl = async function (
  this: InstanceType<typeof VectorStore>,
  filePath: string,
  chunks: any[],
) {
  const indexPath = this.resolveIndexPath(filePath);
  const dirName = path.dirname(indexPath);
  const projectsDir = (this as any).paths.projectsDir;
  if (filePath.startsWith(projectsDir + path.sep)) {
    projectStoreBasePaths.push(dirName);
  }
  upsertCalls.push({ filePath, chunks });
};

beforeAll(() => {
  vectorStoreSpies = [
    spyOn(VectorStore.prototype, "upsertFile").mockImplementation(
      defaultUpsertImpl,
    ),
    spyOn(VectorStore.prototype, "searchGlobal").mockImplementation(
      async (_queryVector, topK = 20) => {
        semanticSearchCalls.push(topK);
        return Number.isFinite(topK)
          ? semanticResults.slice(0, topK)
          : semanticResults;
      },
    ),
    spyOn(VectorStore.prototype, "searchProject").mockImplementation(
      async function (this: InstanceType<typeof VectorStore>, projectId) {
        projectStoreBasePaths.push((this as any).paths.projectDir(projectId));
        return projectSemanticResults;
      },
    ),
    spyOn(VectorStore.prototype, "refreshStaleIndices").mockImplementation(
      async () => [],
    ),
  ];
});

afterAll(() => {
  for (const spy of vectorStoreSpies) {
    spy.mockRestore();
  }
});

mock.module("@opencode/plugin", () => ({
  Plugin: {
    define: (plugin: unknown) => plugin,
  },
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
const { default: MemoryPlugin } = await import("../src/index.js");
const { createV2Harness } = await import("./support/v2-plugin-harness.js");
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
    await manager.flush();

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
    await manager.flush();

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
    await manager.flush();

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
    await manager.flush();

    expect(upsertCalls[0].filePath).toBe(
      path.join(memoryDir, "projects", "owner", "repo", "MEMORY.md"),
    );
    expect(fs.existsSync(path.join(memoryDir, "MEMORY.md"))).toBe(false);
  });
});

test("memory tool writes default to the detected project when project is omitted", async () => {
  await withTempMemory(async (memoryDir) => {
    const harness = await createV2Harness(MemoryPlugin);

    await harness.executeMemory({
      action: "write",
      target: "memory",
      content: "## Project\nplugin default project content",
    });

    await harness.cleanup();
    expect(upsertCalls[0].filePath).toBe(
      path.join(memoryDir, "projects", "owner", "repo", "MEMORY.md"),
    );
    expect(fs.existsSync(path.join(memoryDir, "MEMORY.md"))).toBe(false);
  });
});

test("memory tool writes to global memory when scope is global", async () => {
  await withTempMemory(async (memoryDir) => {
    const harness = await createV2Harness(MemoryPlugin);

    await harness.executeMemory({
      action: "write",
      target: "memory",
      scope: "global",
      content: "## Global\nplugin global memory content",
    });

    await harness.cleanup();
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

    const harness = await createV2Harness(MemoryPlugin);
    const result = await harness.executeMemory({
      action: "read",
      target: "memory",
    });

    expect(result).toStartWith("[scope: project/owner/repo]");
    expect(result).toContain("project content");

    await harness.cleanup();
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

function makeMockVectorBackend(onProjectSearch?: () => Promise<any[]>) {
  return {
    searchGlobal: async (_queryVector: number[], topK: number) => {
      semanticSearchCalls.push(topK);
      return Number.isFinite(topK)
        ? semanticResults.slice(0, topK)
        : semanticResults;
    },
    searchProject: async () => {
      if (onProjectSearch) return onProjectSearch();
      throw new Error("project store should not be used");
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

    const searcher = new FileSearcher(
      memoryDir,
      dailyDir,
      makeMockVectorBackend(async () => projectSemanticResults),
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

    const searcher = new FileSearcher(
      memoryDir,
      dailyDir,
      makeMockVectorBackend(),
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

    const searcher = new FileSearcher(
      memoryDir,
      dailyDir,
      makeMockVectorBackend(),
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

    const searcher = new FileSearcher(
      memoryDir,
      dailyDir,
      makeMockVectorBackend(),
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

    const searcher = new FileSearcher(
      memoryDir,
      dailyDir,
      makeMockVectorBackend(),
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

    const searcher = new FileSearcher(
      memoryDir,
      dailyDir,
      makeMockVectorBackend(),
    );

    const results = await searcher.semanticSearch(
      "searchable",
      20,
      "2026-05",
      null,
    );

    // 跨条目 legacy 向量切片（含 new searchable content）不得被错误绑定到 2026-05
    expect(results.some((r) => r.text.includes("new searchable content"))).toBe(
      false,
    );
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
    await manager.flush();
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
    await manager.flush();
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
    await manager.flush();
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
    await manager.flush();
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
    await manager.flush();
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
    await manager.flush();
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
    await manager.flush();
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
    await manager.flush();

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
    await manager.flush();

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
    await manager.flush();

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

// =============================================================================
// M0 (#34): 并发写入一致性与原子落盘测试
// =============================================================================

test("concurrent appendFile calls on the same file do not lose updates", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({ memoryDir });
    await manager.ensureDirectories();
    const targetFile = path.join(memoryDir, "MEMORY.md");

    const count = 10;
    await Promise.all(
      Array.from({ length: count }, (_, idx) =>
        manager.appendFile(targetFile, `concurrent-entry-${idx}`),
      ),
    );

    const content = fs.readFileSync(targetFile, "utf-8");
    for (let idx = 0; idx < count; idx++) {
      expect(content).toContain(`concurrent-entry-${idx}`);
    }
    const leftovers = fs
      .readdirSync(memoryDir)
      .filter((name) => name.includes(".tmp."));
    expect(leftovers).toHaveLength(0);
    await manager.flush();
  });
});

// =============================================================================
// M1 (v2.1-T2): 字符预算、占用率反馈与原子腾挪测试
// =============================================================================

test("handleWrite reports Budget usage for budgeted files and omits it for daily", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({
      memoryDir,
      limits: { memory: 100, projectMemory: 100, user: 80, identity: 80 },
    });
    await manager.ensureDirectories();

    const memRes = await handleWrite(
      { target: "memory", content: "concise rule" },
      manager,
    );
    expect(memRes).toContain("Budget:");
    expect(memRes).toContain("/100 chars");

    const dailyRes = await handleWrite(
      { target: "daily", date: "2026-11-21", content: "daily log" },
      manager,
    );
    expect(dailyRes).not.toContain("Budget:");
    await manager.flush();
  });
});

test("handleWrite warns when >= 85% budget and rejects over-budget with entry timestamps", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({
      memoryDir,
      limits: { memory: 120, projectMemory: 120, user: 100, identity: 100 },
    });
    await manager.ensureDirectories();

    const memoryFile = path.join(memoryDir, "MEMORY.md");
    fs.writeFileSync(
      memoryFile,
      "<!-- 2026-11-01 10:00:00 -->\n" + "a".repeat(45),
      "utf-8",
    );

    const overRes = await handleWrite(
      { target: "memory", content: "b".repeat(50) },
      manager,
    );
    expect(overRes).toContain("exceeds character budget");
    expect(overRes).toContain("2026-11-01 10:00:00");

    // 写入后接近 85%（约 109/120 ≈ 91%）应触发预警但允许落盘
    const nearRes = await handleWrite(
      { target: "memory", content: "c".repeat(4), mode: "append" },
      manager,
    );
    expect(nearRes).toContain("near limit");
    await manager.flush();
  });
});

test("handleWrite with replace_timestamps atomically replaces stale entries within budget", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({
      memoryDir,
      limits: { memory: 120, projectMemory: 120, user: 100, identity: 100 },
    });
    await manager.ensureDirectories();

    const memoryFile = path.join(memoryDir, "MEMORY.md");
    fs.writeFileSync(
      memoryFile,
      [
        "<!-- 2026-11-01 09:00:00 -->",
        "stale entry " + "x".repeat(60),
        "",
        "<!-- 2026-11-02 09:00:00 -->",
        "keep entry",
      ].join("\n"),
      "utf-8",
    );

    // 直接追加会被预算拒绝
    const directRes = await handleWrite(
      { target: "memory", content: "new entry " + "y".repeat(30) },
      manager,
    );
    expect(directRes).toContain("exceeds character budget");

    // 使用 replace_timestamps 在同一次调用内删旧写新成功
    const replaceRes = await handleWrite(
      {
        target: "memory",
        content: "new entry " + "y".repeat(30),
        replace_timestamps: ["2026-11-01 09:00:00"],
      },
      manager,
    );
    expect(replaceRes).toContain("[scope: global] Appended to MEMORY.md.");
    expect(replaceRes).toContain("Budget:");

    const updated = fs.readFileSync(memoryFile, "utf-8");
    expect(updated).not.toContain("stale entry");
    expect(updated).toContain("keep entry");
    expect(updated).toContain("new entry");
  });
});

// =============================================================================
// M2 (v2.1-T3 & v2.1-T4): 混合检索、时间衰减、MMR、项目 list 与 Provenance 测试
// =============================================================================

import { chunkMarkdown } from "../src/search/chunker.js";
import {
  applyMmrDeduplication,
  computeTemporalDecayMultiplier,
} from "../src/search/bm25.js";
import { handleList } from "../src/handlers/handleList.js";

test("chunkMarkdown injects file/heading context into embeddingText and splits oversized text", () => {
  const longParagraph = Array.from(
    { length: 40 },
    (_, i) => `Line ${i}: ${"x".repeat(40)}`,
  ).join("\n");
  const content = `<!-- 2026-11-21 10:00:00 | origin: owner -->\n## Architecture\n${longParagraph}`;
  const chunks = chunkMarkdown(content, "/tmp/mem/MEMORY.md");

  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks[0].heading).toBe("Architecture");
  expect(chunks[0].origin).toBe("owner");
  expect(chunks[0].embeddingText).toStartWith("[MEMORY.md > Architecture]\n");
  expect(chunks[0].text).not.toContain("[MEMORY.md > Architecture]");
});

test("hybrid search finds exact symbol identifiers missed by vector backend", async () => {
  const { homeDir, memoryDir } = makeTempHome();
  const dailyDir = path.join(memoryDir, "daily");
  const projFile = path.join(
    memoryDir,
    "projects",
    "owner",
    "repo",
    "MEMORY.md",
  );

  try {
    fs.mkdirSync(path.dirname(projFile), { recursive: true });
    fs.writeFileSync(
      projFile,
      [
        "<!-- 2026-11-21 10:00:00 -->",
        "Set OPM_EMBEDDING_DTYPE=q8 when running low-RAM CI jobs. Error code: P2002.",
      ].join("\n"),
      "utf-8",
    );

    // 向量后端返回空，验证纯词法精确符号仍可被召回
    semanticResults = [];
    projectSemanticResults = [];

    const searcher = new FileSearcher(
      memoryDir,
      dailyDir,
      makeMockVectorBackend(async () => []),
    );

    const results = await searcher.semanticSearch(
      "OPM_EMBEDDING_DTYPE",
      5,
      undefined,
      "owner/repo",
      "project",
    );
    expect(results).toHaveLength(1);
    expect(results[0].text).toContain("P2002");

    // global scope 不应搜到 project 文件
    const globalOnly = await searcher.semanticSearch(
      "OPM_EMBEDDING_DTYPE",
      5,
      undefined,
      "owner/repo",
      "global",
    );
    expect(globalOnly).toHaveLength(0);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("temporal decay penalizes old daily logs, spares MEMORY.md, and runs after minScore", async () => {
  const now = Date.parse("2026-11-21T00:00:00Z");
  expect(
    computeTemporalDecayMultiplier("/tmp/mem/MEMORY.md", undefined, now),
  ).toBe(1.0);
  expect(
    computeTemporalDecayMultiplier(
      "/tmp/mem/daily/2026-10-22.md",
      undefined,
      now,
    ),
  ).toBeCloseTo(0.5, 2);

  // 验证 minScore 在时间衰减前判定：180 天前高相关 daily（baseScore > 0.15）不被误杀
  const { homeDir, memoryDir } = makeTempHome();
  const dailyDir = path.join(memoryDir, "daily");
  const veryOldDaily = path.join(dailyDir, "2026-01-01.md");
  try {
    fs.mkdirSync(dailyDir, { recursive: true });
    fs.writeFileSync(
      veryOldDaily,
      "<!-- 2026-01-01 10:00:00 -->\nhistorical architecture milestone",
      "utf-8",
    );
    semanticResults = [
      {
        score: 0.9,
        filePath: veryOldDaily,
        heading: "",
        text: "historical architecture milestone",
        timestamp: "2026-01-01 10:00:00",
      },
    ];
    const searcher = new FileSearcher(
      memoryDir,
      dailyDir,
      makeMockVectorBackend(),
    );
    const results = await searcher.semanticSearch(
      "historical architecture milestone",
      5,
      undefined,
      null,
      "global",
    );
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeLessThan(0.15);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("MMR deduplication suppresses near-duplicate chunks in favor of diverse match", () => {
  const ranked = applyMmrDeduplication(
    [
      { text: "deploy worker build step alpha beta", score: 0.95 },
      { text: "deploy worker build step alpha beta gamma", score: 0.94 },
      { text: "sqlite vector index schema migration", score: 0.85 },
    ],
    2,
    0.7,
  );
  expect(ranked).toHaveLength(2);
  expect(ranked[1].text).toContain("sqlite vector index");
});

test("handleList perceives project scope and supports global/project filtering", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({ memoryDir });
    await manager.ensureDirectories();

    await handleWrite({ target: "memory", content: "global entry" }, manager);
    await handleWrite(
      { target: "memory", project: "owner/repo", content: "project entry" },
      manager,
    );
    await handleWrite(
      {
        target: "daily",
        date: "2026-11-21",
        project: "owner/repo",
        content: "project daily",
      },
      manager,
    );

    const allOut = await handleList({ project: "owner/repo" }, manager);
    expect(allOut).toContain("[scope: project/owner/repo]");
    expect(allOut).toContain("projects/owner/repo/MEMORY.md");
    expect(allOut).toContain("[scope: global]");
    expect(allOut).toContain("MEMORY.md");

    const projOnly = await handleList(
      { project: "owner/repo", scope: "project" },
      manager,
    );
    expect(projOnly).toContain("[scope: project/owner/repo]");
    expect(projOnly).not.toContain("[scope: global]");

    const periodOut = await handleList(
      { project: "owner/repo", period: "2026-11" },
      manager,
    );
    expect(periodOut).toContain("projects/owner/repo/daily/2026-11-21.md");
    await manager.flush();
  });
});

test("provenance blocks origin=external from curated memory and strips external entries on context build", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({ memoryDir });
    await manager.ensureDirectories();

    // external 禁止写入 curated MEMORY.md
    const blocked = await handleWrite(
      {
        target: "memory",
        origin: "external",
        content: "untrusted web snippet",
      },
      manager,
    );
    expect(blocked).toContain("cannot be written directly");

    // external 允许写入 daily
    const allowed = await handleWrite(
      {
        target: "daily",
        date: "2026-11-21",
        origin: "external",
        content: "web summary",
      },
      manager,
    );
    expect(allowed).toContain("Appended to daily/2026-11-21.md");

    // 即使磁盘上的 MEMORY.md 存在手工写入的 external 条目，getContextFiles 也会剥离
    const memoryFile = path.join(memoryDir, "MEMORY.md");
    fs.writeFileSync(
      memoryFile,
      [
        "<!-- 2026-11-21 10:00:00 | origin: owner -->",
        "trusted owner preference",
        "",
        "<!-- 2026-11-21 11:00:00 | origin: external -->",
        "injected prompt attack",
      ].join("\n"),
      "utf-8",
    );

    const ctxFiles = await manager.getContextFiles();
    expect(ctxFiles).toHaveLength(1);
    expect(ctxFiles[0].content).toContain("trusted owner preference");
    expect(ctxFiles[0].content).not.toContain("injected prompt attack");

    // 删除外部条目时保留 owner 标记
    await handleDelete(
      { target: "memory", timestamp: "2026-11-21 11:00:00" },
      manager,
    );
    expect(fs.readFileSync(memoryFile, "utf-8")).toContain(
      "| origin: owner -->",
    );
    await manager.flush();
  });
});

// =============================================================================
// checkLineLimit：本地 MEMORY.md 行数上限
// =============================================================================

test("checkLineLimit throws for local MEMORY.md over limit", async () => {
  const { checkLineLimit } = await import("../src/utils/validation.js");
  const overLimit = Array.from({ length: 1001 }, () => "x").join("\n");
  expect(() => checkLineLimit("/tmp/memory/MEMORY.md", overLimit)).toThrow(
    /line limit/,
  );
});

test("checkLineLimit does not throw within limit", async () => {
  const { checkLineLimit } = await import("../src/utils/validation.js");
  expect(() => checkLineLimit("MEMORY.md", "a\nb\nc")).not.toThrow();
});

// =============================================================================
// #37: 带栅栏的后台异步索引与 Git 队列测试
// =============================================================================

import { BackgroundSyncQueue } from "../src/utils/backgroundQueue.js";

test("BackgroundSyncQueue coalesces rapid consecutive updates on the same file", async () => {
  const executed: Array<{ filePath: string; operation: string }> = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const queue = new BackgroundSyncQueue(async (filePath, operation) => {
    executed.push({ filePath, operation });
    if (executed.length === 1) {
      await firstBlocked;
    }
  });

  // 连续两次入队（首条尚未启动前即合并为 op-2）
  queue.enqueue("/tmp/mem/MEMORY.md", "op-1");
  queue.enqueue("/tmp/mem/MEMORY.md", "op-2");

  // 等待 worker 进入 op-2 执行并阻塞在 firstBlocked
  await new Promise((r) => setTimeout(r, 15));
  expect(executed).toHaveLength(1);
  expect(executed[0].operation).toBe("op-2");

  // 执行期间再连推 op-3 与 op-4，应合并成最后一次 op-4
  queue.enqueue("/tmp/mem/MEMORY.md", "op-3");
  queue.enqueue("/tmp/mem/MEMORY.md", "op-4");
  releaseFirst();

  await queue.flush();
  expect(executed).toHaveLength(2);
  expect(executed[1].operation).toBe("op-4");
  expect(queue.pendingCount()).toBe(0);
});

test("handleWrite returns without waiting for slow indexing and semanticSearch flushes before querying", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({ memoryDir });
    await manager.ensureDirectories();

    vectorStoreSpies[0].mockImplementation(async function (
      this: InstanceType<typeof VectorStore>,
      filePath: string,
      chunks: any[],
    ) {
      await new Promise((r) => setTimeout(r, 120));
      await defaultUpsertImpl.call(this, filePath, chunks);
    });

    try {
      const startedAt = Date.now();
      const writeRes = await handleWrite(
        {
          target: "memory",
          content: "background queued token barrier-check-xyz",
        },
        manager,
      );
      const elapsedMs = Date.now() - startedAt;

      // 落盘已立即完成，且写入响应未被 120ms 索引阻塞
      expect(writeRes).toContain("Appended to MEMORY.md.");
      expect(
        fs.readFileSync(path.join(memoryDir, "MEMORY.md"), "utf-8"),
      ).toContain("barrier-check-xyz");
      expect(elapsedMs).toBeLessThan(100);
      expect(upsertCalls).toHaveLength(0);

      // 立即检索会等待 flush 栅栏，保证索引先完成再查
      const searchRes = await manager.semanticSearch("barrier-check-xyz", 5);
      expect(upsertCalls).toHaveLength(1);
      expect(searchRes.length).toBeGreaterThanOrEqual(1);
      expect(searchRes[0].text).toContain("barrier-check-xyz");
    } finally {
      vectorStoreSpies[0].mockImplementation(defaultUpsertImpl);
      await manager.flush();
    }
  });
});

test("background indexing failure is logged and does not break flush or written Markdown", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({ memoryDir });
    await manager.ensureDirectories();

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) =>
      errors.push(args.map(String).join(" "));

    vectorStoreSpies[0].mockImplementation(async () => {
      throw new Error("simulated index disk failure");
    });

    try {
      await handleWrite(
        { target: "memory", content: "durable markdown survives index error" },
        manager,
      );
      await expect(manager.flush()).resolves.toBeUndefined();

      expect(
        fs.readFileSync(path.join(memoryDir, "MEMORY.md"), "utf-8"),
      ).toContain("durable markdown survives index error");
      expect(
        errors.some((msg) => msg.includes("Background vector indexing failed")),
      ).toBe(true);
    } finally {
      console.error = origError;
      vectorStoreSpies[0].mockImplementation(defaultUpsertImpl);
    }
  });
});

test("writes skip indexing when the embedding engine is not ready, and search backfills it", async () => {
  await withTempMemory(async (memoryDir) => {
    const manager = new MemoryManager({ memoryDir });
    await manager.ensureDirectories();

    // 模拟冷启动：embedding 引擎尚未就绪（真实场景下避免触发 33MB 模型下载）
    mockEmbedderReady = false;

    try {
      await handleWrite(
        { target: "memory", content: "cold start note without model download" },
        manager,
      );
      await manager.flush();

      // Markdown 作为 SSOT 已落盘
      expect(
        fs.readFileSync(path.join(memoryDir, "MEMORY.md"), "utf-8"),
      ).toContain("cold start note without model download");
      // 引擎未就绪时不产生任何向量化调用，也不写入向量索引
      expect(embeddedTexts).toHaveLength(0);
      expect(upsertCalls).toHaveLength(0);

      // 引擎就绪后，检索会先补建被跳过的索引，保证写入内容仍可被搜到
      mockEmbedderReady = true;
      const results = await manager.semanticSearch("cold start note", 5);
      expect(upsertCalls.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.text.includes("cold start note"))).toBe(
        true,
      );
    } finally {
      mockEmbedderReady = true;
    }
  });
});
