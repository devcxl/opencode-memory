import type { IFileStorageProvider } from "../types.js";
import { MemoryClient, type RemoteConfig } from "./http-client.js";

/**
 * Remote 模式 FileStorageProvider。
 * 所有文件级操作映射为 Worker REST API 调用。
 *
 * path 格式："file_type:date:project_id"
 *   - file_type: memory | identity | user | daily
 *   - date: YYYY-MM-DD
 *   - project_id: owner/repo
 */
export class RemoteFileStorageProvider implements IFileStorageProvider {
  private client: MemoryClient;

  constructor(config: RemoteConfig) {
    this.client = new MemoryClient(config);
  }

  /**
   * 解析路径为 file_type, date, project_id
   * 格式: "file_type:date:project_id"
   */
  private parsePath(path: string): {
    file_type: string;
    date: string;
    project_id: string;
  } {
    const parts = path.split(":");
    return {
      file_type: parts[0] || "",
      date: parts[1] || "",
      project_id: parts[2] || "",
    };
  }

  /** GET /api/memories → 拼接为类文件格式 */
  async readFile(path: string): Promise<string | null> {
    const { file_type, date, project_id } = this.parsePath(path);

    const records = await this.client.list({
      file_type,
      project_id,
      date,
      kind: "long",
      limit: "100",
    });

    if (!records || records.length === 0) return null;

    return records
      .map((m) => {
        const ts = new Date(m.created_at)
          .toISOString()
          .replace("T", " ")
          .slice(0, 19);
        return `<!-- ${ts} -->\n${m.text}`;
      })
      .join("\n\n");
  }

  /** POST /api/memories — 写入记忆（Worker 端自动做 embedding + 索引） */
  async writeFile(path: string, content: string): Promise<void> {
    const { file_type, date, project_id } = this.parsePath(path);

    await this.client.write({
      text: content,
      kind: "long",
      file_type: file_type || undefined,
      project_id: project_id || undefined,
      date: date || undefined,
    });
  }

  /** append 在 remote 下等同于 write（D1 逐条存储，无文件追加语义） */
  async appendFile(path: string, content: string): Promise<void> {
    return this.writeFile(path, content);
  }

  /** 删除指定 file_type+project_id 下的所有记录 */
  async deleteFile(path: string): Promise<void> {
    const { file_type, date, project_id } = this.parsePath(path);

    // 获取该 file_type+project_id+date 的所有记录 ID
    const records = await this.client.list({
      file_type,
      project_id,
      date,
      kind: "long",
      limit: "100",
    });

    for (const record of records) {
      await this.client.delete(record.id);
    }
  }

  async exists(path: string): Promise<boolean> {
    const content = await this.readFile(path);
    return content !== null;
  }

  /** remote 下列文件功能由 Worker API 的 list 端点提供，此处返回空 */
  async listFiles(_pattern: string): Promise<string[]> {
    return [];
  }

  /**
   * 🆕 远程搜索方法（突破 IFileStorageProvider 接口）
   * 供 FileSearcher 在 remote 模式下直接调用，
   * 跳过本地 embedding 步骤，直接将 query 文本发给 Worker。
   */
  async search(
    query: string,
    topK: number,
    file_type?: string,
    project_id?: string,
  ): Promise<
    Array<{
      id: string;
      text: string;
      score: number;
      created_at: number;
      snippet: string;
      matchCount: number;
    }>
  > {
    const records = await this.client.search({
      query,
      topK,
      kind: "long",
      file_type,
      project_id,
    });

    return records.map((r) => ({
      id: r.id,
      text: r.text,
      score: r.score ?? 0,
      created_at: r.created_at,
      snippet: r.snippet ?? "",
      matchCount: r.matchCount ?? 0,
    }));
  }
}
