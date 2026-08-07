import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  MemoryClient,
  type RemoteConfig,
} from "../src/providers/remote/http-client.js";

// ─── 测试辅助 ────────────────────────────────────────────────

const TEST_CONFIG: RemoteConfig = {
  apiUrl: "https://memory.example.com",
  apiKey: "test-jwt-token",
};

/** 创建 mock Response */
function mockResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** mock globalThis.fetch 的类型安全封装 */
function mockFetch(fn: typeof fetch): void {
  globalThis.fetch = fn;
}

// ─── MemoryClient 测试 ────────────────────────────────────────

describe("MemoryClient", () => {
  let client: MemoryClient;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    client = new MemoryClient(TEST_CONFIG);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("认证", () => {
    test("每个请求都附加正确 JWT Bearer token", async () => {
      const h = { auth: "" };

      mockFetch(
        mock((input: RequestInfo | URL, init?: RequestInit): Response => {
          h.auth = new Headers(init?.headers).get("Authorization") || "";
          return mockResponse(200, { success: true, data: [] });
        }) as unknown as typeof fetch,
      );

      await client.list({});

      expect(h.auth).toBe(`Bearer ${TEST_CONFIG.apiKey}`);
    });
  });

  describe("write", () => {
    test("调用 POST /api/memories 并传递正确 body", async () => {
      let capturedBody: Record<string, unknown> = {};

      mockFetch(
        mock((_input: RequestInfo | URL, init?: RequestInit): Response => {
          capturedBody = JSON.parse(init?.body as string);
          return mockResponse(200, {
            success: true,
            data: { id: "mem-123", indexed: true },
          });
        }) as unknown as typeof fetch,
      );

      await client.write({
        text: "测试记忆内容",
        kind: "long",
        file_type: "memory",
        project_id: "owner/repo",
        date: "2026-07-22",
      });

      expect(capturedBody.text).toBe("测试记忆内容");
      expect(capturedBody.kind).toBe("long");
      expect(capturedBody.file_type).toBe("memory");
      expect(capturedBody.project_id).toBe("owner/repo");
      expect(capturedBody.date).toBe("2026-07-22");
    });
  });

  describe("search", () => {
    test("调用 POST /api/memories/search 并返回结果", async () => {
      const mockResults = [
        {
          id: "1",
          user_id: "u1",
          kind: "long",
          text: "结果1",
          tags: "[]",
          created_at: 1000,
          archived: 0,
          score: 0.9,
          snippet: "结果1",
          matchCount: 1,
        },
        {
          id: "2",
          user_id: "u1",
          kind: "long",
          text: "结果2",
          tags: "[]",
          created_at: 2000,
          archived: 0,
          score: 0.8,
          snippet: "结果2",
          matchCount: 1,
        },
      ];

      mockFetch(
        mock((_input: RequestInfo | URL, _init?: RequestInit): Response => {
          return mockResponse(200, { success: true, data: mockResults });
        }) as unknown as typeof fetch,
      );

      const results = await client.search({
        query: "测试查询",
        topK: 5,
        file_type: "memory",
        project_id: "p1",
      });
      expect(results).toHaveLength(2);
      expect(results[0].score).toBe(0.9);
      expect(results[1].score).toBe(0.8);
    });

    test("API 返回失败时返回空数组", async () => {
      mockFetch(
        mock((): Response => {
          return mockResponse(200, { success: false, error: "no results" });
        }) as unknown as typeof fetch,
      );

      const results = await client.search({ query: "无结果" });
      expect(results).toEqual([]);
    });
  });

  describe("list / read", () => {
    test("调用 GET /api/memories 并拼接查询参数", async () => {
      let calledUrl = "";

      mockFetch(
        mock((input: RequestInfo | URL, _init?: RequestInit): Response => {
          calledUrl = input.toString();
          return mockResponse(200, {
            success: true,
            data: [
              {
                id: "1",
                user_id: "u1",
                kind: "long",
                text: "内容",
                tags: "[]",
                created_at: 1000,
                archived: 0,
              },
            ],
          });
        }) as unknown as typeof fetch,
      );

      await client.list({
        kind: "long",
        limit: "10",
        file_type: "memory",
        project_id: "p1",
      });

      const url = new URL(calledUrl);
      expect(url.pathname).toBe("/api/memories");
      expect(url.searchParams.get("kind")).toBe("long");
      expect(url.searchParams.get("limit")).toBe("10");
      expect(url.searchParams.get("file_type")).toBe("memory");
      expect(url.searchParams.get("project_id")).toBe("p1");
    });

    test("返回空数组时 list 不报错", async () => {
      mockFetch(
        mock((): Response => {
          return mockResponse(200, { success: true, data: [] });
        }) as unknown as typeof fetch,
      );

      const result = await client.list({});
      expect(result).toEqual([]);
    });

    test("API 返回 success:false 时返回空数组", async () => {
      mockFetch(
        mock((): Response => {
          return mockResponse(200, { success: false, data: [] });
        }) as unknown as typeof fetch,
      );

      const result = await client.list({});
      expect(result).toEqual([]);
    });
  });

  describe("delete", () => {
    test("调用 DELETE /api/memories/:id", async () => {
      let calledMethod = "";
      let calledUrl = "";

      mockFetch(
        mock((input: RequestInfo | URL, init?: RequestInit): Response => {
          calledMethod = init?.method || "GET";
          calledUrl = input.toString();
          return mockResponse(200, { success: true });
        }) as unknown as typeof fetch,
      );

      await client.delete("mem-abc");

      expect(calledMethod).toBe("DELETE");
      expect(calledUrl).toContain("/api/memories/mem-abc");
    });
  });

  describe("getContext", () => {
    test("调用 GET /api/context 并拼接 project_id", async () => {
      let calledUrl = "";

      mockFetch(
        mock((input: RequestInfo | URL, _init?: RequestInit): Response => {
          calledUrl = input.toString();
          return mockResponse(200, {
            success: true,
            data: "## MEMORY.md\n\n记忆内容",
          });
        }) as unknown as typeof fetch,
      );

      const context = await client.getContext("owner/repo");

      const url = new URL(calledUrl);
      expect(url.pathname).toBe("/api/context");
      expect(url.searchParams.get("project_id")).toBe("owner/repo");
      expect(typeof context).toBe("string");
    });

    test("获取全局 context 时不传 project_id", async () => {
      let calledUrl = "";

      mockFetch(
        mock((input: RequestInfo | URL, _init?: RequestInit): Response => {
          calledUrl = input.toString();
          return mockResponse(200, { success: true, data: "内容" });
        }) as unknown as typeof fetch,
      );

      await client.getContext();

      const url = new URL(calledUrl);
      expect(url.searchParams.get("project_id")).toBeNull();
    });
  });

  describe("错误处理", () => {
    test("401 → 抛出授权错误", async () => {
      mockFetch(
        mock((): Response => {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }) as unknown as typeof fetch,
      );

      await expect(client.list({})).rejects.toThrow(/401/);
    });

    test("429 → 抛出限流错误", async () => {
      mockFetch(
        mock((): Response => {
          return new Response(JSON.stringify({ error: "Too many requests" }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          });
        }) as unknown as typeof fetch,
      );

      await expect(client.list({})).rejects.toThrow(/429/);
    });

    test("500 → 抛出服务端错误", async () => {
      mockFetch(
        mock((): Response => {
          return new Response(JSON.stringify({ error: "Internal error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }) as unknown as typeof fetch,
      );

      await expect(client.list({})).rejects.toThrow(/500/);
    });

    test("非 JSON 错误响应仍能抛出状态码错误", async () => {
      mockFetch(
        mock((): Response => {
          return new Response("Not JSON", {
            status: 502,
            headers: { "Content-Type": "text/plain" },
          });
        }) as unknown as typeof fetch,
      );

      await expect(client.list({})).rejects.toThrow(/502/);
    });
  });
});

// ─── RemoteVectorIndexProvider 测试 ──────────────────────────

import { RemoteVectorIndexProvider } from "../src/providers/remote/VectorIndexProvider.js";

describe("RemoteVectorIndexProvider", () => {
  let provider: RemoteVectorIndexProvider;

  beforeEach(() => {
    provider = new RemoteVectorIndexProvider(TEST_CONFIG);
  });

  test("delete 调用 DELETE /api/memories/:id", async () => {
    const deletedIds: string[] = [];

    globalThis.fetch = mock(
      (input: RequestInfo | URL, init?: RequestInit): Response => {
        if (init?.method === "DELETE") {
          const url = input.toString();
          const id = url.split("/").pop() || "";
          deletedIds.push(id);
        }
        return mockResponse(200, { success: true });
      },
    ) as unknown as typeof fetch;

    await provider.delete(["mem-1", "mem-2"], "global");

    expect(deletedIds).toContain("mem-1");
    expect(deletedIds).toContain("mem-2");
    expect(deletedIds).toHaveLength(2);
  });

  test("upsert 暂不抛错（remote 下由 writeFile 触发）", async () => {
    // remote 模式下 upsert 批量场景预留，目前是空操作
    await expect(provider.upsert([], "global")).resolves.toBeUndefined();
  });

  test("search 直接调 Worker search（绕过向量）", async () => {
    let capturedBody: Record<string, unknown> = {};

    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit): Response => {
        if (init?.body) capturedBody = JSON.parse(init.body as string);
        return mockResponse(200, {
          success: true,
          data: [
            {
              id: "r1",
              user_id: "u1",
              kind: "long",
              text: "匹配结果",
              tags: "[]",
              created_at: 1000,
              archived: 0,
              score: 0.95,
              snippet: "...",
              matchCount: 2,
            },
          ],
        });
      },
    ) as unknown as typeof fetch;

    const results = await provider.search([0.1, 0.2], 5, "project:owner/repo");

    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(0.95);
    expect(capturedBody.query).toBeDefined();
  });
});

// ─── RemoteEmbeddingProvider 测试 ────────────────────────────

import { RemoteEmbeddingProvider } from "../src/providers/remote/EmbeddingProvider.js";

describe("RemoteEmbeddingProvider", () => {
  test("dimensions 和 modelId 返回正确值", () => {
    const provider = new RemoteEmbeddingProvider(TEST_CONFIG);
    expect(provider.dimensions).toBe(1024);
    expect(provider.modelId).toBe("@cf/qwen/qwen3-embedding-0.6b");
  });

  test("embedTexts 抛出错误（remote 下不应被调用）", async () => {
    const provider = new RemoteEmbeddingProvider(TEST_CONFIG);
    await expect(provider.embedTexts(["测试"])).rejects.toThrow(/Remote mode/);
  });
});

// ─── RemoteFileStorageProvider 测试 ──────────────────────────

import { RemoteFileStorageProvider } from "../src/providers/remote/FileStorageProvider.js";

describe("RemoteFileStorageProvider", () => {
  let provider: RemoteFileStorageProvider;

  beforeEach(() => {
    provider = new RemoteFileStorageProvider(TEST_CONFIG);
  });

  describe("writeFile", () => {
    test("overwrite 语义：先删除旧记录再创建新记录", async () => {
      const calls: string[] = [];
      let capturedBody: Record<string, unknown> = {};

      globalThis.fetch = mock(
        (input: RequestInfo | URL, init?: RequestInit): Response => {
          const method = init?.method || "GET";
          const url = input.toString();
          if (method === "DELETE") {
            calls.push(`DELETE:${url.split("/").pop()}`);
            return mockResponse(200, { success: true });
          }
          if (method === "POST") {
            calls.push("POST");
            if (init?.body) capturedBody = JSON.parse(init.body as string);
            return mockResponse(200, {
              success: true,
              data: { id: "m1", indexed: true },
            });
          }
          // GET list：返回已有的旧记录
          calls.push("GET");
          return mockResponse(200, {
            success: true,
            data: [
              { id: "old-1", title: "x", content: "旧内容", created_at: 1 },
              { id: "old-2", title: "x", content: "旧内容", created_at: 1 },
            ],
          });
        },
      ) as unknown as typeof fetch;

      await provider.writeFile(
        "learning:knowledge:project:owner/repo:2026-07-22",
        "新记忆内容",
      );

      // 先 GET 列出旧记录 → 逐条 DELETE → 最后 POST 创建
      expect(calls.filter((c) => c.startsWith("GET")).length).toBeGreaterThan(0);
      expect(calls).toContain("DELETE:old-1");
      expect(calls).toContain("DELETE:old-2");
      expect(calls[calls.length - 1]).toBe("POST");
      expect(capturedBody.type).toBe("knowledge");
      expect(capturedBody.content).toBe("新记忆内容");
      expect(capturedBody.scope).toBe("project");
      expect(capturedBody.project_id).toBe("owner/repo");
    });
  });

  describe("appendFile", () => {
    test("append 语义：只新增，不先删除旧记录", async () => {
      const calls: string[] = [];
      let capturedText = "";

      globalThis.fetch = mock(
        (input: RequestInfo | URL, init?: RequestInit): Response => {
          const method = init?.method || "GET";
          if (method === "POST") {
            calls.push("POST");
            if (init?.body)
              capturedText = JSON.parse(init.body as string).content;
            return mockResponse(200, { success: true, data: { id: "m1" } });
          }
          calls.push(method);
          return mockResponse(200, { success: true, data: [] });
        },
      ) as unknown as typeof fetch;

      await provider.appendFile("daily:::2026-07-22", "今日日志");

      // 只应有创建请求，绝无 list/delete
      expect(calls).toEqual(["POST"]);
      expect(capturedText).toBe("今日日志");
    });

    test("append daily 调用 POST /api/dailies", async () => {
      let capturedText = "";

      globalThis.fetch = mock(
        (_input: RequestInfo | URL, init?: RequestInit): Response => {
          if (init?.body)
            capturedText = JSON.parse(init.body as string).content;
          return mockResponse(200, {
            success: true,
            data: { id: "m1", indexed: true },
          });
        },
      ) as unknown as typeof fetch;

      await provider.appendFile("daily:::2026-07-22", "今日日志");

      expect(capturedText).toBe("今日日志");
    });
  });

  describe("readFile", () => {
    test("调用 GET /api/learnings 并拼接结果", async () => {
      globalThis.fetch = mock(
        (input: RequestInfo | URL, _init?: RequestInit): Response => {
          return mockResponse(200, {
            success: true,
            data: [
              {
                id: "1",
                title: "条目1",
                content: "条目1内容",
                created_at: 1712345678000,
              },
              {
                id: "2",
                title: "条目2",
                content: "条目2内容",
                created_at: 1712345679000,
              },
            ],
          });
        },
      ) as unknown as typeof fetch;

      const result = await provider.readFile(
        "learning:knowledge:project:owner/repo:2026-07-22",
      );

      expect(result).not.toBeNull();
      expect(result).toContain("条目1内容");
      expect(result).toContain("条目2内容");
      expect(result).toContain("<!--");
    });

    test("无结果时返回 null", async () => {
      globalThis.fetch = mock((): Response => {
        return mockResponse(200, { success: true, data: [] });
      }) as unknown as typeof fetch;

      const result = await provider.readFile(
        "learning:knowledge:project:owner/repo:2026-07-22",
      );
      expect(result).toBeNull();
    });

    test("API success:false 时返回 null", async () => {
      globalThis.fetch = mock((): Response => {
        return mockResponse(200, { success: false, data: null });
      }) as unknown as typeof fetch;

      const result = await provider.readFile(
        "learning:knowledge:project:owner/repo:2026-07-22",
      );
      expect(result).toBeNull();
    });
  });

  describe("deleteFile", () => {
    test("先 list 获取 ID 再逐条 delete", async () => {
      const deletedIds: string[] = [];
      const listUrls: string[] = [];

      globalThis.fetch = mock(
        (input: RequestInfo | URL, init?: RequestInit): Response => {
          if (init?.method === "DELETE") {
            const id = input.toString().split("/").pop() || "";
            deletedIds.push(id);
            return mockResponse(200, { success: true });
          }
          // list 请求
          listUrls.push(input.toString());
          return mockResponse(200, {
            success: true,
            data: [
              { id: "a1", title: "x", content: "x", created_at: 1 },
              { id: "a2", title: "x", content: "x", created_at: 1 },
            ],
          });
        },
      ) as unknown as typeof fetch;

      await provider.deleteFile(
        "learning:knowledge:project:owner/repo:2026-07-22",
      );

      expect(deletedIds).toContain("a1");
      expect(deletedIds).toContain("a2");
    });

    test("按 path 的 type/project 过滤，避免误删其他记录", async () => {
      const listUrls: string[] = [];

      globalThis.fetch = mock(
        (input: RequestInfo | URL, init?: RequestInit): Response => {
          if (init?.method === "DELETE") {
            return mockResponse(200, { success: true });
          }
          listUrls.push(input.toString());
          return mockResponse(200, {
            success: true,
            data: [{ id: "a1", title: "x", content: "x", created_at: 1 }],
          });
        },
      ) as unknown as typeof fetch;

      await provider.deleteFile(
        "learning:preference:project:devcxl/LaseAI:2026-07-22",
      );

      expect(listUrls.length).toBe(1);
      const url = new URL(listUrls[0]);
      expect(url.searchParams.get("type")).toBe("preference");
      expect(url.searchParams.get("project_id")).toBe("devcxl/LaseAI");
    });
  });

  describe("deleteByTimestamp", () => {
    test("按时间戳匹配具体记录并删除，而非重写新增", async () => {
      const createdAt = 1712345678000;
      const ts = new Date(createdAt)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19);
      const deletedIds: string[] = [];

      globalThis.fetch = mock(
        (input: RequestInfo | URL, init?: RequestInit): Response => {
          if (init?.method === "DELETE") {
            const id = input.toString().split("/").pop() || "";
            deletedIds.push(id);
            return mockResponse(200, { success: true });
          }
          // list 请求
          return mockResponse(200, {
            success: true,
            data: [
              {
                id: "match-1",
                title: "x",
                content: "x",
                created_at: createdAt,
              },
              {
                id: "keep-2",
                title: "x",
                content: "x",
                created_at: createdAt + 1000,
              },
            ],
          });
        },
      ) as unknown as typeof fetch;

      const result = await provider.deleteByTimestamp(
        "learning:knowledge:project:owner/repo:2026-07-22",
        ts,
      );

      expect(deletedIds).toEqual(["match-1"]);
      expect(result).toContain("Deleted learning");
    });

    test("无匹配时间戳时抛错且不删除", async () => {
      const deletedIds: string[] = [];

      globalThis.fetch = mock(
        (input: RequestInfo | URL, init?: RequestInit): Response => {
          if (init?.method === "DELETE") {
            deletedIds.push(input.toString());
            return mockResponse(200, { success: true });
          }
          return mockResponse(200, {
            success: true,
            data: [
              { id: "a1", title: "x", content: "x", created_at: 1712345678000 },
            ],
          });
        },
      ) as unknown as typeof fetch;

      await expect(
        provider.deleteByTimestamp(
          "learning:knowledge:project:owner/repo:2026-07-22",
          "1999-01-01 00:00:00",
        ),
      ).rejects.toThrow();

      expect(deletedIds).toEqual([]);
    });
  });

  describe("exists", () => {
    test("有内容返回 true", async () => {
      globalThis.fetch = mock((): Response => {
        return mockResponse(200, {
          success: true,
          data: [
            { id: "x", title: "有内容", content: "有内容", created_at: 1 },
          ],
        });
      }) as unknown as typeof fetch;

      expect(
        await provider.exists("learning:knowledge:project:p1:2026-07-22"),
      ).toBe(true);
    });

    test("无内容返回 false", async () => {
      globalThis.fetch = mock((): Response => {
        return mockResponse(200, { success: true, data: [] });
      }) as unknown as typeof fetch;

      expect(
        await provider.exists("learning:knowledge:project:p1:2026-07-22"),
      ).toBe(false);
    });
  });

  describe("listFiles", () => {
    test("返回空数组（remote 下列文件功能由 Worker API 提供）", async () => {
      const files = await provider.listFiles("*.md");
      expect(files).toEqual([]);
    });
  });

  describe("listAll", () => {
    test("枚举根文件与按日聚合的 daily 文件", async () => {
      globalThis.fetch = mock(
        (input: RequestInfo | URL): Response => {
          const url = input.toString();
          if (url.includes("/api/instructions")) {
            return mockResponse(200, {
              success: true,
              data: [{ id: "i1", content: "身份", created_at: 1710000000000 }],
            });
          }
          if (url.includes("/api/learnings")) {
            const type = new URL(url).searchParams.get("type");
            const all = [
              { id: "p1", content: "偏好", created_at: 1710000001000 },
              { id: "k1", content: "知识", created_at: 1710000002000 },
              { id: "k2", content: "知识2", created_at: 1710000003000 },
            ];
            return mockResponse(200, {
              success: true,
              data: all.filter((r) => r.id.startsWith((type || "k").charAt(0))),
            });
          }
          if (url.includes("/api/dailies")) {
            return mockResponse(200, {
              success: true,
              data: [
                { id: "d1", content: "1", date: "2026-07-01", created_at: 1710000004000 },
                { id: "d2", content: "2", date: "2026-08-05", created_at: 1710000005000 },
              ],
            });
          }
          return mockResponse(200, { success: true, data: [] });
        },
      ) as unknown as typeof fetch;

      const result = await provider.listAll();

      expect(result.root.map((f) => f.name)).toEqual([
        "IDENTITY.md",
        "USER.md",
        "MEMORY.md",
      ]);
      expect(result.daily.map((f) => f.name)).toEqual([
        "daily/2026-08-05.md",
        "daily/2026-07-01.md",
      ]);
      expect(result.root.find((f) => f.name === "MEMORY.md")!.timestamps).toHaveLength(2);
    });
  });

  describe("search (remote 专用)", () => {
    test("调用 POST /api/memories/search", async () => {
      let capturedBody: Record<string, unknown> = {};

      globalThis.fetch = mock(
        (_input: RequestInfo | URL, init?: RequestInit): Response => {
          if (init?.body) capturedBody = JSON.parse(init.body as string);
          return mockResponse(200, {
            success: true,
            data: [
              {
                id: "s1",
                user_id: "u1",
                kind: "long",
                text: "搜索结果",
                tags: "[]",
                created_at: 1,
                archived: 0,
                score: 0.9,
                snippet: "...",
                matchCount: 1,
              },
            ],
          });
        },
      ) as unknown as typeof fetch;

      const results = await provider.search("测试查询", 5, "memory", "p1");

      expect(results).toHaveLength(1);
      expect(capturedBody.query).toBe("测试查询");
      expect(capturedBody.topK).toBe(5);
      expect(capturedBody.file_type).toBe("memory");
      expect(capturedBody.project_id).toBe("p1");
    });
  });

  describe("错误传播", () => {
    test("401 错误抛出（不给调用方吞掉）", async () => {
      globalThis.fetch = mock((): Response => {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      await expect(provider.readFile("learning:knowledge:::")).rejects.toThrow(
        /401/,
      );
    });
  });
});
