/** 远程 Worker API 配置 */
export interface RemoteConfig {
  apiUrl: string;
  apiKey: string;
}

/** Worker API 统一响应格式 */
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/** Worker API 返回的记忆条目 */
interface WorkerMemory {
  id: string;
  user_id: string;
  kind: "short" | "long";
  text: string;
  tags: string;
  created_at: number;
  archived: number;
  score?: number;
  snippet?: string;
  matchCount?: number;
}

/** write 参数 */
export interface WriteParams {
  text: string;
  tags?: string[];
  kind?: "short" | "long";
  file_type?: string;
  project_id?: string;
  date?: string;
}

/** search 参数 */
export interface SearchParams {
  query: string;
  topK?: number;
  kind?: "short" | "long";
  file_type?: string;
  project_id?: string;
}

/** list 参数 */
export interface ListParams {
  kind?: "short" | "long";
  limit?: string;
  offset?: string;
  file_type?: string;
  project_id?: string;
  date?: string;
}

/** HTTP 客户端，封装对 Worker REST API 的调用 */
export class MemoryClient {
  constructor(private config: RemoteConfig) {}

  /** Authorization header */
  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  /** 统一错误处理 */
  private async handleResponse<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error(
        `Worker API error ${res.status}: ${body.error || res.statusText}`,
      );
    }
    const json = (await res.json()) as ApiResponse<T>;
    if (!json.success) {
      throw new Error(
        `Worker API error: ${json.error || "unknown error"}`,
      );
    }
    return json.data as T;
  }

  /**
   * 列表/搜索用响应处理 — HTTP 错误抛出，业务 success:false 返回空数组
   * 这样调用方可以区分网络/认证错误（抛异常）与"无结果"（返回 []）
   */
  private async handleListResponse<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error(
        `Worker API error ${res.status}: ${body.error || res.statusText}`,
      );
    }
    const json = (await res.json()) as ApiResponse<T>;
    if (!json.success) {
      return [] as unknown as T;
    }
    return (json.data ?? []) as unknown as T;
  }

  /** POST /api/memories — 写入记忆 */
  async write(params: WriteParams): Promise<{ id: string; indexed: boolean }> {
    const res = await fetch(`${this.config.apiUrl}/api/memories`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(params),
    });
    return this.handleResponse<{ id: string; indexed: boolean }>(res);
  }

  /** POST /api/memories/search — 语义搜索 */
  async search(params: SearchParams): Promise<WorkerMemory[]> {
    const res = await fetch(`${this.config.apiUrl}/api/memories/search`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(params),
    });
    return this.handleListResponse<WorkerMemory[]>(res);
  }

  /** GET /api/memories — 列出/读取记忆 */
  async list(params: ListParams): Promise<WorkerMemory[]> {
    const url = new URL(`${this.config.apiUrl}/api/memories`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, value);
      }
    }
    const res = await fetch(url.toString(), {
      headers: { Authorization: this.headers.Authorization },
    });
    return this.handleListResponse<WorkerMemory[]>(res);
  }

  /** DELETE /api/memories/:id — 删除记忆 */
  async delete(id: string): Promise<void> {
    const res = await fetch(`${this.config.apiUrl}/api/memories/${id}`, {
      method: "DELETE",
      headers: this.headers,
    });
    await this.handleResponse<unknown>(res);
  }

  /** GET /api/context — 获取记忆摘要 */
  async getContext(projectId?: string): Promise<string> {
    const url = new URL(`${this.config.apiUrl}/api/context`);
    if (projectId) {
      url.searchParams.set("project_id", projectId);
    }
    const res = await fetch(url.toString(), {
      headers: { Authorization: this.headers.Authorization },
    });
    const data = await this.handleResponse<string>(res);
    return data || "";
  }
}
