import type { IFileStorageProvider } from "../types.js";
import { MemoryClient, type RemoteConfig } from "./http-client.js";

/**
 * Remote 模式 FileStorageProvider。
 * 按 category 路由到不同 Worker API 端点：
 *
 * path 格式："category:sub_type:scope:project_id:date"
 *   - category: instruction | learning | daily
 *   - sub_type: identity | rule | workflow | preference | episodic | knowledge
 *   - scope: global | project | user | local
 *   - project_id: owner/repo
 *   - date: YYYY-MM-DD
 */
export class RemoteFileStorageProvider implements IFileStorageProvider {
  private client: MemoryClient;

  constructor(config: RemoteConfig) {
    this.client = new MemoryClient(config);
  }

  private parsePath(path: string): {
    category: string;
    sub_type: string;
    scope: string;
    project_id: string;
    date: string;
  } {
    const parts = path.split(":");
    return {
      category: parts[0] || "",
      sub_type: parts[1] || "",
      scope: parts[2] || "",
      project_id: parts[3] || "",
      date: parts[4] || "",
    };
  }

  async readFile(path: string): Promise<string | null> {
    const { category, sub_type, project_id, date } = this.parsePath(path);

    switch (category) {
      case "instruction": {
        const records = await this.client.listInstructions({
          type: sub_type || undefined,
          project_id: project_id || undefined,
        });
        if (!records || records.length === 0) return null;
        return records
          .map((r) => {
            const ts = new Date(r.created_at)
              .toISOString()
              .replace("T", " ")
              .slice(0, 19);
            return `<!-- ${ts} -->\n${r.content}`;
          })
          .join("\n\n");
      }

      case "learning": {
        const records = await this.client.listLearnings({
          type: sub_type || undefined,
          project_id: project_id || undefined,
        });
        if (!records || records.length === 0) return null;
        return records
          .map((r) => {
            const ts = new Date(r.created_at)
              .toISOString()
              .replace("T", " ")
              .slice(0, 19);
            return `<!-- ${ts} -->\n## ${r.title}\n${r.content}`;
          })
          .join("\n\n");
      }

      case "daily": {
        const records = await this.client.listDailies({
          project_id: project_id || undefined,
          date: date || undefined,
        });
        if (!records || records.length === 0) return null;
        return records
          .map((r) => {
            const ts = new Date(r.created_at)
              .toISOString()
              .replace("T", " ")
              .slice(0, 19);
            return `<!-- ${ts} -->\n${r.content}`;
          })
          .join("\n\n");
      }

      default:
        return null;
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    const { category, sub_type, scope, project_id, date } =
      this.parsePath(path);

    switch (category) {
      case "instruction":
        await this.client.createInstruction({
          type: sub_type || "rule",
          title: sub_type || "指令",
          content,
          scope: scope || "global",
          project_id: project_id || undefined,
        });
        break;

      case "learning":
        await this.client.createLearning({
          type: (sub_type || "knowledge") as
            "preference" | "episodic" | "knowledge",
          title: sub_type || "",
          content,
          scope: (scope || "global") as "global" | "project" | "user",
          project_id: project_id || undefined,
        });
        break;

      case "daily":
        await this.client.createDaily({
          content,
          project_id: project_id || undefined,
          date: date || undefined,
        });
        break;

      default:
        throw new Error(`Unknown category: ${category}`);
    }
  }

  async appendFile(path: string, content: string): Promise<void> {
    return this.writeFile(path, content);
  }

  async deleteFile(path: string): Promise<void> {
    const { category, sub_type, project_id, date } = this.parsePath(path);

    // Read back and delete only records matching this path's filters
    switch (category) {
      case "instruction": {
        const instructions = await this.client.listInstructions({
          type: sub_type || undefined,
          project_id: project_id || undefined,
        });
        for (const r of instructions) {
          await this.client.deleteInstruction(r.id);
        }
        break;
      }
      case "learning": {
        const learnings = await this.client.listLearnings({
          type: sub_type || undefined,
          project_id: project_id || undefined,
        });
        for (const r of learnings) {
          await this.client.deleteLearning(r.id);
        }
        break;
      }
      case "daily": {
        const dailies = await this.client.listDailies({
          project_id: project_id || undefined,
          date: date || undefined,
        });
        for (const r of dailies) {
          await this.client.deleteDaily(r.id);
        }
        break;
      }
    }
  }

  /**
   * 按时间戳删除单条记录。
   * 远程模式下每条记录独立存储，不能像本地那样整体重写文件。
   * 通过 list 该路径下的记录，匹配 created_at 对应的时间戳，再删除具体那条。
   */
  async deleteByTimestamp(path: string, timestamp: string): Promise<string> {
    const { category, sub_type, project_id, date } = this.parsePath(path);

    switch (category) {
      case "instruction": {
        const instructions = await this.client.listInstructions({
          type: sub_type || undefined,
          project_id: project_id || undefined,
        });
        const target = instructions.find(
          (r) => this.formatTs(r.created_at) === timestamp,
        );
        if (!target)
          throw new Error(`No entries found matching timestamp: ${timestamp}`);
        await this.client.deleteInstruction(target.id);
        return `Deleted instruction from ${path}`;
      }
      case "learning": {
        const learnings = await this.client.listLearnings({
          type: sub_type || undefined,
          project_id: project_id || undefined,
        });
        const target = learnings.find(
          (r) => this.formatTs(r.created_at) === timestamp,
        );
        if (!target)
          throw new Error(`No entries found matching timestamp: ${timestamp}`);
        await this.client.deleteLearning(target.id);
        return `Deleted learning from ${path}`;
      }
      case "daily": {
        const dailies = await this.client.listDailies({
          project_id: project_id || undefined,
          date: date || undefined,
        });
        const target = dailies.find(
          (r) => this.formatTs(r.created_at) === timestamp,
        );
        if (!target)
          throw new Error(`No entries found matching timestamp: ${timestamp}`);
        await this.client.deleteDaily(target.id);
        return `Deleted daily from ${path}`;
      }
      default:
        throw new Error(`Unknown category: ${category}`);
    }
  }

  /** 将记录创建时间格式化为与 readFile 时间戳一致的字符串 */
  private formatTs(createdAt: number): string {
    return new Date(createdAt).toISOString().replace("T", " ").slice(0, 19);
  }

  async exists(path: string): Promise<boolean> {
    const content = await this.readFile(path);
    return content !== null;
  }

  async listFiles(_pattern: string): Promise<string[]> {
    return [];
  }

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
