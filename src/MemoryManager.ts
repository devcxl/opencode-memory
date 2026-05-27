import * as path from "node:path";
import * as fs from "node:fs";
import type {
  MemoryConfig,
  SearchResult,
  ListResult,
  ContextFile,
  TimestampEntry,
  SemanticSearchResult,
  MonthGroup,
} from "./types.js";
import { ensureDir, getMemoryDir } from "./config.js";
import { atomicWrite } from "./atomicWrite.js";
import { checkLineLimit } from "./validation.js";
import { gitCommit } from "./git.js";
import { embedText } from "./embedding.js";
import { chunkMarkdown } from "./chunker.js";
import {
  upsertFile,
  deleteFileVectors,
  type SearchResult as VectorSearchResult,
  ProjectStore,
} from "./vector-store.js";
import {
  parseContentByTimestamp,
  extractTimestamps,
} from "./timestampParser.js";

export class MemoryManager {
  private config: MemoryConfig;
  private dailyDir: string;
  private projectStores: Map<string, ProjectStore> = new Map();

  constructor(config: MemoryConfig) {
    this.config = config;
    this.dailyDir = path.join(config.memoryDir, "daily");
  }

  ensureDirectories(): void {
    ensureDir(this.config.memoryDir);
    ensureDir(this.dailyDir);
  }

  getMemoryPath(): string {
    return path.join(this.config.memoryDir, "MEMORY.md");
  }

  getIdentityPath(): string {
    return path.join(this.config.memoryDir, "IDENTITY.md");
  }

  getUserPath(): string {
    return path.join(this.config.memoryDir, "USER.md");
  }

  getBootstrapPath(): string {
    return path.join(this.config.memoryDir, "BOOTSTRAP.md");
  }

  getDailyPath(date: string): string {
    return path.join(this.dailyDir, `${date}.md`);
  }

  getProjectStore(projectId: string): ProjectStore {
    if (!this.projectStores.has(projectId)) {
      this.projectStores.set(
        projectId,
        new ProjectStore(
          path.join(this.config.memoryDir, "projects", projectId),
        ),
      );
    }
    return this.projectStores.get(projectId)!;
  }

  getProjectDir(projectId: string): string {
    return path.join(this.config.memoryDir, "projects", projectId);
  }

  getProjectMemoryPath(projectId: string): string {
    return path.join(this.getProjectDir(projectId), "MEMORY.md");
  }

  ensureProjectDirs(projectId: string): void {
    const projectDir = this.getProjectDir(projectId);
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }
  }

  getPathForTarget(
    target: string,
    date?: string,
    project?: string | null,
  ): { filePath: string; displayName: string } {
    switch (target) {
      case "memory": {
        if (project) {
          const filePath = this.getProjectMemoryPath(project);
          return { filePath, displayName: `projects/${project}/MEMORY.md` };
        }
        return { filePath: this.getMemoryPath(), displayName: "MEMORY.md" };
      }
      case "identity":
        return { filePath: this.getIdentityPath(), displayName: "IDENTITY.md" };
      case "user":
        return { filePath: this.getUserPath(), displayName: "USER.md" };
      case "daily": {
        const targetDate = date ?? this.todayStr();
        return {
          filePath: this.getDailyPath(targetDate),
          displayName: `daily/${targetDate}.md`,
        };
      }
      default:
        throw new Error(`Unknown target: ${target}`);
    }
  }

  todayStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  readFile(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    checkLineLimit(filePath, content);
    atomicWrite(filePath, content);
    await this.embedAndIndex(filePath, content);
    await gitCommit(`Update ${path.basename(filePath)}`);
  }

  async editFile(
    filePath: string,
    oldString: string,
    newString: string,
  ): Promise<void> {
    const content = this.readFile(filePath);
    if (!content) {
      throw new Error("File not found or empty");
    }

    if (!content.includes(oldString)) {
      throw new Error("oldString not found in file");
    }

    const matches = content.split(oldString).length - 1;
    if (matches > 1) {
      throw new Error(
        `Found ${matches} occurrences of oldString, expected exactly 1`,
      );
    }

    const updatedContent = content.replace(oldString, newString);
    atomicWrite(filePath, updatedContent);
    await this.embedAndIndex(filePath, updatedContent);
    await gitCommit(`Edit ${path.basename(filePath)}`);
  }

  async deleteByTimestamp(
    target: string,
    timestamp: string,
    date?: string,
    project?: string | null,
  ): Promise<string> {
    const { filePath, displayName } = this.getPathForTarget(
      target,
      date,
      project,
    );
    const content = this.readFile(filePath);

    if (!content) {
      throw new Error(`${displayName} not found or empty`);
    }

    const entries = parseContentByTimestamp(content);
    const filteredEntries = entries.filter(
      (entry) => entry.timestamp !== timestamp,
    );

    if (filteredEntries.length === entries.length) {
      throw new Error(`No entries found matching timestamp: ${timestamp}`);
    }

    const newContent = filteredEntries
      .map((e) => `<!-- ${e.timestamp} -->\n${e.content}`)
      .join("\n\n");

    atomicWrite(filePath, newContent);
    await this.embedAndIndex(filePath, newContent);
    await gitCommit(`Delete entries from ${path.basename(filePath)}`);

    return `Deleted ${entries.length - filteredEntries.length} entries from ${displayName}`;
  }

  appendFile(filePath: string, content: string): void {
    const existing = this.readFile(filePath);
    const separator = existing?.trim() ? "\n\n" : "";
    const timestamp = this.getLocalTimestamp();
    const stamped = `<!-- ${timestamp} -->\n${content}`;
    const newContent = (existing ?? "") + separator + stamped;

    checkLineLimit(filePath, newContent);
    atomicWrite(filePath, newContent);
    gitCommit(`Append to ${path.basename(filePath)}`);
  }

  getLocalTimestamp(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  private async embedAndIndex(
    filePath: string,
    content: string,
  ): Promise<void> {
    try {
      const chunks = chunkMarkdown(content, filePath);
      const embedded = await Promise.all(
        chunks.map(async (chunk) => ({
          vector: await embedText(chunk.text),
          metadata: {
            filePath,
            heading: chunk.heading,
            text: chunk.text,
            hash: chunk.hash,
          },
        })),
      );

      const projectsDir = path.join(this.config.memoryDir, "projects");
      if (filePath.startsWith(projectsDir + path.sep)) {
        const relative = path.relative(projectsDir, filePath);
        const projectId = relative.split(path.sep)[0];
        if (projectId) {
          const store = this.getProjectStore(projectId);
          await store.upsertFile(filePath, embedded);
          return;
        }
      }

      await upsertFile(filePath, embedded);
    } catch (err) {
      const errMsg = (err as Error).message;
      if (!errMsg.includes("not initialized")) {
        throw err;
      }
    }
  }

  deleteFile(filePath: string): void {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
    }
  }

  fileExists(filePath: string): boolean {
    return fs.existsSync(filePath);
  }

  isInitialized(): boolean {
    return this.fileExists(this.getMemoryPath());
  }

  needsBootstrap(): boolean {
    return this.fileExists(this.getBootstrapPath());
  }

  getContextFiles(projectId?: string | null): ContextFile[] {
    const files: ContextFile[] = [];
    const memoryContent = this.readFile(this.getMemoryPath());
    if (memoryContent?.trim()) {
      files.push({ name: "MEMORY.md", content: memoryContent.trim() });
    }
    const identityContent = this.readFile(this.getIdentityPath());
    if (identityContent?.trim()) {
      files.push({ name: "IDENTITY.md", content: identityContent.trim() });
    }
    const userContent = this.readFile(this.getUserPath());
    if (userContent?.trim()) {
      files.push({ name: "USER.md", content: userContent.trim() });
    }
    if (projectId) {
      const projectMemoryPath = this.getProjectMemoryPath(projectId);
      const projectContent = this.readFile(projectMemoryPath);
      if (projectContent?.trim()) {
        files.push({
          name: `Project: ${projectId}`,
          content: projectContent.trim(),
        });
      }
    }
    return files;
  }

  searchFiles(query: string, maxResults: number): SearchResult[] {
    const results: SearchResult[] = [];
    const needle = query.toLowerCase();
    const searchPaths = [
      { dir: this.config.memoryDir, prefix: "" },
      { dir: this.dailyDir, prefix: "daily" },
    ];

    for (const { dir, prefix } of searchPaths) {
      if (results.length >= maxResults) break;
      try {
        const files = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".md") && f !== "BOOTSTRAP.md");
        for (const file of files) {
          if (results.length >= maxResults) break;
          const filePath = path.join(dir, file);
          const content = this.readFile(filePath);
          if (!content) continue;
          const lines = content.split("\n");
          for (
            let i = 0;
            i < lines.length && results.length < maxResults;
            i++
          ) {
            if (lines[i].toLowerCase().includes(needle)) {
              results.push({
                file: prefix ? `${prefix}/${file}` : file,
                line: i + 1,
                text: lines[i].trimEnd(),
              });
            }
          }
        }
      } catch {
        continue;
      }
    }
    return results;
  }

  async semanticSearch(
    query: string,
    maxResults: number = 20,
    period?: string,
    projectId?: string | null,
  ): Promise<SemanticSearchResult[]> {
    const queryVector = await embedText(query);
    const module = await import("./vector-store.js");
    const results = await module.semanticSearch(queryVector, maxResults);

    if (projectId) {
      const store = this.getProjectStore(projectId);
      try {
        const projectResults = await store.search(queryVector, maxResults);
        results.push(...projectResults);
        results.sort((a, b) => b.score - a.score);
      } catch {}
    }

    const resultsWithTimestamp: SemanticSearchResult[] = [];
    for (const result of results.slice(0, maxResults)) {
      const fileContent = this.readFile(result.filePath);
      let timestamp: string | undefined;

      if (fileContent) {
        const timestamps = extractTimestamps(fileContent);
        if (timestamps.length > 0) {
          timestamp = timestamps[0];
        }
      }

      if (period) {
        if (timestamp && !timestamp.startsWith(period.replace("-", "-"))) {
          continue;
        }
      }

      resultsWithTimestamp.push({
        ...result,
        timestamp,
      });
    }

    return resultsWithTimestamp;
  }

  listFiles(): ListResult {
    const root: string[] = [];
    const daily: string[] = [];

    try {
      const rootFiles = fs
        .readdirSync(this.config.memoryDir)
        .filter((f) => f.endsWith(".md"))
        .sort();
      for (const f of rootFiles) {
        if (f !== "BOOTSTRAP.md") root.push(f);
      }
    } catch {}

    try {
      const dailyFiles = fs
        .readdirSync(this.dailyDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse();
      daily.push(...dailyFiles);
    } catch {}

    return { root, daily };
  }

  async embedAllExistingFiles(): Promise<void> {
    const rootIndexExists = await import("./vector-store.js").then((m) =>
      m.checkIndexExists("root"),
    );
    const dailyIndexExists = await import("./vector-store.js").then((m) =>
      m.checkIndexExists("daily"),
    );

    const hasExistingIndex = rootIndexExists || dailyIndexExists;

    if (hasExistingIndex) {
      return;
    }

    const { root, daily } = this.listFiles();

    const filesToEmbed: Array<{ filePath: string; content: string }> = [];

    for (const file of root) {
      const filePath = path.join(this.config.memoryDir, file);
      const content = this.readFile(filePath);
      if (content) {
        filesToEmbed.push({ filePath, content });
      }
    }

    for (const file of daily) {
      const filePath = path.join(this.dailyDir, file);
      const content = this.readFile(filePath);
      if (content) {
        filesToEmbed.push({ filePath, content });
      }
    }

    for (const { filePath, content } of filesToEmbed) {
      try {
        await this.embedAndIndex(filePath, content);
      } catch (err) {
        console.error(
          `[embedding] Failed to embed ${filePath}: ${(err as Error).message}`,
        );
      }
    }
  }

  listFilesWithTimestamps(
    limit: number = 7,
  ): Array<{ name: string; timestamps: string[] }> {
    const result: Array<{ name: string; timestamps: string[] }> = [];
    const { root, daily } = this.listFiles();

    for (const file of root) {
      const filePath = path.join(this.config.memoryDir, file);
      const content = this.readFile(filePath);
      const timestamps = content ? extractTimestamps(content) : [];
      result.push({ name: file, timestamps });
    }

    const recentDaily = daily.slice(0, limit);
    const moreCount = daily.length - limit;

    for (const file of recentDaily) {
      const filePath = path.join(this.dailyDir, file);
      const content = this.readFile(filePath);
      const timestamps = content ? extractTimestamps(content) : [];
      result.push({ name: `daily/${file}`, timestamps });
    }

    if (moreCount > 0) {
      result.push({
        name: `... and ${moreCount} more daily logs`,
        timestamps: [],
      });
    }

    return result;
  }

  listFilesGroupedByMonth(): {
    root: Array<{ name: string; timestamps: string[] }>;
    monthly: MonthGroup[];
  } {
    const { root, daily } = this.listFiles();

    const rootFiles: Array<{ name: string; timestamps: string[] }> = [];
    for (const file of root) {
      const filePath = path.join(this.config.memoryDir, file);
      const content = this.readFile(filePath);
      const timestamps = content ? extractTimestamps(content) : [];
      rootFiles.push({ name: file, timestamps });
    }

    const monthlyMap = new Map<
      string,
      Array<{ name: string; timestamps: string[] }>
    >();

    for (const file of daily) {
      const dateStr = file.replace(".md", "");
      const month = dateStr.slice(0, 7);
      const filePath = path.join(this.dailyDir, file);
      const content = this.readFile(filePath);
      const timestamps = content ? extractTimestamps(content) : [];

      if (!monthlyMap.has(month)) {
        monthlyMap.set(month, []);
      }
      monthlyMap.get(month)!.push({ name: `daily/${file}`, timestamps });
    }

    const monthly: MonthGroup[] = [];
    for (const [month, files] of monthlyMap.entries()) {
      const entryCount = files.reduce((sum, f) => sum + f.timestamps.length, 0);
      monthly.push({
        month,
        fileCount: files.length,
        entryCount,
        files,
      });
    }

    monthly.sort((a, b) => b.month.localeCompare(a.month));

    return { root: rootFiles, monthly };
  }

  listFilesByPeriod(
    period: string,
  ): Array<{ name: string; timestamps: string[] }> {
    const { daily } = this.listFiles();
    const result: Array<{ name: string; timestamps: string[] }> = [];

    const filteredDaily = daily.filter((file) => {
      const dateStr = file.replace(".md", "");
      if (period.length === 7) {
        return dateStr.startsWith(period);
      }
      if (period.length === 4) {
        return dateStr.startsWith(period);
      }
      return false;
    });

    for (const file of filteredDaily) {
      const filePath = path.join(this.dailyDir, file);
      const content = this.readFile(filePath);
      const timestamps = content ? extractTimestamps(content) : [];
      result.push({ name: `daily/${file}`, timestamps });
    }

    return result;
  }
}
