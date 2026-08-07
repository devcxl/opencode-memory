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
          limit: 1000,
        });
        if (!records || records.length === 0) return null;
        // remote 记录独立存储，时间由服务端 created_at 决定，内容里不展示时间戳
        return records.map((r) => r.content).join("\n\n");
      }

      case "learning": {
        const records = await this.client.listLearnings({
          type: sub_type || undefined,
          project_id: project_id || undefined,
          limit: 1000,
        });
        if (!records || records.length === 0) return null;
        // title 为创建时的类型占位（如 knowledge），内容里已有用户标题，不再重复拼接
        return records.map((r) => r.content).join("\n\n");
      }

      case "daily": {
        const records = await this.client.listDailies({
          project_id: project_id || undefined,
          date: date || undefined,
          limit: 1000,
        });
        if (!records || records.length === 0) return null;
        return records.map((r) => r.content).join("\n\n");
      }

      default:
        return null;
    }
  }

  /** 创建一条记录（append 语义：不删除已有记录） */
  private async createRecord(path: string, content: string): Promise<void> {
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

  /**
   * 覆盖写入（overwrite / edit 语义）。
   * 远程模式下每条记录独立存储，覆盖 = 先删除该路径下所有已有记录，再创建一条。
   */
  async writeFile(path: string, content: string): Promise<void> {
    await this.deleteFile(path);
    await this.createRecord(path, content);
  }

  /** 追加写入：只新增一条记录，不删除已有记录 */
  async appendFile(path: string, content: string): Promise<void> {
    return this.createRecord(path, content);
  }

  async deleteFile(path: string): Promise<void> {
    const { category, sub_type, scope, project_id, date } =
      this.parsePath(path);

    // Read back and delete only records matching this path's filters
    switch (category) {
      case "instruction": {
        const instructions = await this.client.listInstructions({
          type: sub_type || undefined,
          scope: scope || undefined,
          project_id: project_id || undefined,
          limit: 1000,
        });
        for (const r of instructions) {
          await this.client.deleteInstruction(r.id);
        }
        break;
      }
      case "learning": {
        const learnings = await this.client.listLearnings({
          type: sub_type || undefined,
          scope: scope || undefined,
          project_id: project_id || undefined,
          limit: 1000,
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
          limit: 1000,
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
          limit: 1000,
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
          limit: 1000,
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
          limit: 1000,
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

  /**
   * 枚举所有逻辑文件及时间戳（remote 模式 list 用）。
   * 与 readFile 的路径语义保持一致：IDENTITY/USER/MEMORY 分别对应
   * instruction:identity / learning:preference / learning:knowledge，
   * daily 按日期命名的记录聚合。
   */
  async listAll(): Promise<{
    root: Array<{ name: string; timestamps: string[] }>;
    daily: Array<{ name: string; timestamps: string[] }>;
  }> {
    const [identityRows, preferences, knowledge, dailies] = await Promise.all([
      this.client.listInstructions({ type: "identity" }),
      this.client.listLearnings({ type: "preference" }),
      this.client.listLearnings({ type: "knowledge" }),
      this.client.listDailies({ limit: 100 }),
    ]);

    const ts = (n: number) =>
      new Date(n).toISOString().replace("T", " ").slice(0, 19);

    const root: Array<{ name: string; timestamps: string[] }> = [];
    if (identityRows?.length) {
      root.push({
        name: "IDENTITY.md",
        timestamps: identityRows.map((r) => ts(r.created_at)),
      });
    }
    if (preferences?.length) {
      root.push({
        name: "USER.md",
        timestamps: preferences.map((r) => ts(r.created_at)),
      });
    }
    if (knowledge?.length) {
      root.push({
        name: "MEMORY.md",
        timestamps: knowledge.map((r) => ts(r.created_at)),
      });
    }

    const dailyMap = new Map<string, string[]>();
    for (const d of dailies || []) {
      const date = d.date || new Date(d.created_at).toISOString().slice(0, 10);
      if (!dailyMap.has(date)) dailyMap.set(date, []);
      dailyMap.get(date)!.push(ts(d.created_at));
    }

    const daily = Array.from(dailyMap.entries())
      .map(([date, timestamps]) => ({
        name: `daily/${date}.md`,
        timestamps,
      }))
      .sort((a, b) => b.name.localeCompare(a.name));

    return { root, daily };
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
