import { LocalIndex } from "vectra";
import * as path from "node:path";
import { getMemoryDir } from "./config.js";

let rootIndex: LocalIndex | null = null;
let dailyIndex: LocalIndex | null = null;

function getRootIndexPath(): string {
  return path.join(getMemoryDir(), "root.index");
}

function getDailyIndexPath(): string {
  return path.join(getMemoryDir(), "daily.index");
}

async function getRootIndex(): Promise<LocalIndex> {
  if (!rootIndex) {
    rootIndex = new LocalIndex(getRootIndexPath());
    if (!(await rootIndex.isIndexCreated())) {
      await rootIndex.createIndex();
    }
  }
  return rootIndex;
}

async function getDailyIndex(): Promise<LocalIndex> {
  if (!dailyIndex) {
    dailyIndex = new LocalIndex(getDailyIndexPath());
    if (!(await dailyIndex.isIndexCreated())) {
      await dailyIndex.createIndex();
    }
  }
  return dailyIndex;
}

export interface EmbeddedChunk {
  vector: number[];
  metadata: Record<string, string>;
}

export async function upsertFile(
  filePath: string,
  chunks: EmbeddedChunk[],
): Promise<void> {
  const index = filePath.includes("/daily/")
    ? await getDailyIndex()
    : await getRootIndex();

  const existing = await index.listItems();
  const existingByHash = new Map<string, string>();
  const toDelete: string[] = [];

  for (const item of existing) {
    if (item.metadata && String(item.metadata.filePath) === filePath) {
      const hash = item.metadata.hash ? String(item.metadata.hash) : null;
      if (hash) {
        existingByHash.set(hash, String(item.id));
      } else {
        toDelete.push(String(item.id));
      }
    }
  }

  const newHashes = new Set(chunks.map((c) => c.metadata.hash));

  for (const [hash, id] of existingByHash) {
    if (!newHashes.has(hash)) {
      toDelete.push(id);
    }
  }

  for (const id of toDelete) {
    await index.deleteItem(id);
  }

  for (const { vector, metadata } of chunks) {
    if (!existingByHash.has(metadata.hash)) {
      await index.insertItem({ vector, metadata });
    }
  }
}

export interface SearchResult {
  score: number;
  filePath: string;
  heading: string;
  text: string;
}

export async function semanticSearch(
  queryVector: number[],
  topK: number = 20,
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];

  const rootIdx = await getRootIndex();
  const dailyIdx = await getDailyIndex();

  const [rootResults, dailyResults] = await Promise.all([
    rootIdx.queryItems(queryVector, "", topK),
    dailyIdx.queryItems(queryVector, "", topK),
  ]);

  for (const item of rootResults) {
    results.push({
      score: item.score,
      filePath: String(item.item.metadata.filePath),
      heading: String(item.item.metadata.heading),
      text: String(item.item.metadata.text),
    });
  }

  for (const item of dailyResults) {
    results.push({
      score: item.score,
      filePath: String(item.item.metadata.filePath),
      heading: String(item.item.metadata.heading),
      text: String(item.item.metadata.text),
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

export async function deleteFileVectors(filePath: string): Promise<void> {
  const index = filePath.includes("/daily/")
    ? await getDailyIndex()
    : await getRootIndex();
  const existing = await index.listItems();

  for (const item of existing) {
    if (item.metadata && String(item.metadata.filePath) === filePath) {
      await index.deleteItem(String(item.id));
    }
  }
}

export async function checkIndexExists(
  type: "root" | "daily",
): Promise<boolean> {
  const index = type === "root" ? await getRootIndex() : await getDailyIndex();
  const items = await index.listItems();
  return items.length > 0;
}

export class ProjectStore {
  private basePath: string;
  private rootIndex: LocalIndex | null = null;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  async getIndex(): Promise<LocalIndex> {
    if (!this.rootIndex) {
      const indexPath = path.join(this.basePath, "root.index");
      this.rootIndex = new LocalIndex(indexPath);
      if (!(await this.rootIndex.isIndexCreated())) {
        await this.rootIndex.createIndex();
      }
    }
    return this.rootIndex;
  }

  async upsertFile(filePath: string, chunks: EmbeddedChunk[]): Promise<void> {
    const index = await this.getIndex();

    const existing = await index.listItems();
    const existingByHash = new Map<string, string>();
    const toDelete: string[] = [];

    for (const item of existing) {
      if (item.metadata && String(item.metadata.filePath) === filePath) {
        const hash = item.metadata.hash ? String(item.metadata.hash) : null;
        if (hash) {
          existingByHash.set(hash, String(item.id));
        } else {
          toDelete.push(String(item.id));
        }
      }
    }

    const newHashes = new Set(chunks.map((c) => c.metadata.hash));

    for (const [hash, id] of existingByHash) {
      if (!newHashes.has(hash)) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      await index.deleteItem(id);
    }

    for (const { vector, metadata } of chunks) {
      if (!existingByHash.has(metadata.hash)) {
        await index.insertItem({ vector, metadata });
      }
    }
  }

  async search(queryVector: number[], topK: number): Promise<SearchResult[]> {
    const index = await this.getIndex();
    const items = await index.queryItems(queryVector, "", topK);
    return items.map((item) => ({
      score: item.score,
      filePath: String(item.item.metadata.filePath),
      heading: String(item.item.metadata.heading),
      text: String(item.item.metadata.text),
    }));
  }

  async checkExists(): Promise<boolean> {
    try {
      const index = await this.getIndex();
      const items = await index.listItems();
      return items.length > 0;
    } catch {
      return false;
    }
  }
}
