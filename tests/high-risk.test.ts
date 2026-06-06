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

mock.module("../src/search/embedding.js", () => ({
  embedText: async (text: string) => {
    embeddedTexts.push(text);
    return [Math.max(text.length, 1)];
  },
  getEmbedder: async () => ({}),
  initEmbedder: async () => {},
  isInitialized: async () => true,
}));

mock.module("../src/search/vector-store.js", () => ({
  upsertFile: async (filePath: string, chunks: any[]) => {
    upsertCalls.push({ filePath, chunks });
  },
  deleteFileVectors: async () => {},
  semanticSearch: async (_queryVector: number[], topK: number) => {
    semanticSearchCalls.push(topK);
    return Number.isFinite(topK) ? semanticResults.slice(0, topK) : semanticResults;
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
      return semanticResults;
    }

    async checkExists() {
      return semanticResults.length > 0;
    }
  },
}));

const { MemoryManager } = await import("../src/memory/MemoryManager.js");
const { FileSearcher } = await import("../src/memory/FileSearcher.js");
const { handleWrite } = await import("../src/handlers/handleWrite.js");
const { gitCommit } = await import("../src/utils/git.js");

beforeEach(() => {
  embeddedTexts.length = 0;
  upsertCalls.length = 0;
  projectStoreBasePaths.length = 0;
  semanticSearchCalls.length = 0;
  semanticResults = [];
});

function makeTempHome(): { homeDir: string; memoryDir: string } {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-memory-"));
  const memoryDir = path.join(homeDir, ".config", "opencode", "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  return { homeDir, memoryDir };
}

async function withHome<T>(homeDir: string, run: () => T | Promise<T>): Promise<T> {
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

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

test("append write indexes the newly written daily content", async () => {
  const { homeDir, memoryDir } = makeTempHome();

  try {
    await withHome(homeDir, async () => {
      const manager = new MemoryManager({ memoryDir });
      manager.ensureDirectories();

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
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
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

    expect(git(["status", "--porcelain", "--", "unrelated.txt"], repoDir)).toContain(
      "unrelated.txt",
    );
    expect(git(["status", "--porcelain", "--", "memory/MEMORY.md"], repoDir)).toBe(
      "",
    );
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

    expect(git(["status", "--porcelain", "--", "unrelated.txt"], repoDir)).toStartWith(
      "M  ",
    );
    expect(git(["status", "--porcelain", "--", "memory/MEMORY.md"], repoDir)).toBe(
      "",
    );
    expect(git(["show", "--name-only", "--pretty=format:", "HEAD"], repoDir).trim()).toBe(
      "memory/MEMORY.md",
    );
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

test("nested project memory indexes into the matching owner/repo project store", async () => {
  const { homeDir, memoryDir } = makeTempHome();

  try {
    await withHome(homeDir, async () => {
      const manager = new MemoryManager({ memoryDir });
      manager.ensureDirectories();

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
      (filePath) => fs.readFileSync(filePath, "utf-8"),
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

    const searcher = new FileSearcher(
      memoryDir,
      dailyDir,
      (filePath) => fs.readFileSync(filePath, "utf-8"),
      () => {
        throw new Error("project store should not be used");
      },
    );

    const results = await searcher.semanticSearch("target", 20, "2026-06", null);

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
      (filePath) => fs.readFileSync(filePath, "utf-8"),
      () => {
        throw new Error("project store should not be used");
      },
    );

    const results = await searcher.semanticSearch("unmatched", 20, "2026-05", null);

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
      (filePath) => fs.readFileSync(filePath, "utf-8"),
      () => {
        throw new Error("project store should not be used");
      },
    );

    const results = await searcher.semanticSearch("searchable", 20, "2026-05", null);

    expect(results).toHaveLength(0);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
