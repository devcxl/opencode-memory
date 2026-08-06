/**
 * E2E 测试：远程模式 → Worker API 端到端验证
 *
 * 使用 Hono app.request() 直接测试，无需启动 wrangler dev。
 * 模拟 D1, Vectorize, Workers AI 绑定，验证完整请求/响应流程。
 */
import { describe, test, expect, beforeAll, mock } from "bun:test";
import type { Memory, KeywordSearchResult } from "@devcxl/opencode-memory-shared";

// ─── Mock D1 Database ──────────────────────────────
const mockDb = {
  prepare() {
    return {
      bind(..._args: unknown[]) {
        return {
          run() { return Promise.resolve({ success: true }); },
          first<T>() { return Promise.resolve(null as unknown as T); },
          all<T>(): Promise<{ results: T[] }> {
            const rows = this["_rows"] as T[] || [] as T[];
            delete this["_rows"];
            return Promise.resolve({ results: rows });
          },
          _rows: [] as unknown[],
        };
      },
    };
  },
};

// ─── Mock Vectorize ───────────────────────────────
const mockVec = {
  upsert() { return Promise.resolve({}); },
  query() { return Promise.resolve({ matches: [] }); },
  deleteByIds() { return Promise.resolve({}); },
};

// ─── Mock Workers AI ──────────────────────────────
let mockEmbedding: number[][] = [[0.1, 0.2]];
const mockAi = {
  run(model: string, input: { text: unknown }) {
    if (model.includes("embedding")) {
      return Promise.resolve({ data: mockEmbedding });
    }
    return Promise.resolve({ response: "mock response" });
  },
};

function buildWorkerEnv() {
  return {
    DB: mockDb as unknown as D1Database,
    VEC: mockVec as unknown as VectorizeIndex,
    AI: mockAi as any,
    JWT_SECRET: "test-secret",
    ALLOWED_ORIGINS: "*",
    RATE_LIMIT: "1000",
  };
}

// ─── JWT 生成 ─────────────────────────────────────
async function generateJWT(userId = "test-user"): Promise<string> {
  const { SignJWT } = await import("jose");
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .sign(new TextEncoder().encode("test-secret"));
}

// ─── Test suite ────────────────────────────────────

describe("E2E: Worker API (app.request test)", () => {
  let app: { fetch: (request: Request, env: Record<string, unknown>) => Promise<Response> };
  let token: string;

  beforeAll(async () => {
    // 动态导入 Worker（需要 workerd polyfills 已加载）
    const mod = await import("../../api/src/index");
    app = mod.default as any;
    token = await generateJWT();
  });

  const authHeader = () => ({ Authorization: `Bearer ${token}` });

  test("POST /api/memories → write memory", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({
          text: "E2E: React + TypeScript + Vite 项目架构",
          kind: "long",
          file_type: "memory",
          project_id: "test/e2e-project",
          tags: ["react", "typescript"],
        }),
      }),
      buildWorkerEnv()
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { id: string; indexed: boolean } };
    expect(body.success).toBe(true);
    expect(body.data.id).toBeString();
  });

  test("POST /api/memories → write identity", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({
          text: "AI identity: 严格、直接、高效",
          kind: "long",
          file_type: "identity",
        }),
      }),
      buildWorkerEnv()
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
  });

  test("POST /api/memories → write daily log", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({
          text: "完成 E2E 测试配置",
          kind: "short",
          file_type: "daily",
          date: "2026-07-22",
          project_id: "test/e2e-project",
        }),
      }),
      buildWorkerEnv()
    );
    expect(res.status).toBe(200);
  });

  test("GET /api/memories → list with file_type filter", async () => {
    const res = await app.fetch(
      new Request(
        "http://localhost/api/memories?file_type=identity&kind=long",
        { headers: authHeader() }
      ),
      buildWorkerEnv()
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: Memory[] };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("GET /api/context → get memory summary", async () => {
    const res = await app.fetch(
      new Request(
        "http://localhost/api/context?project_id=test/e2e-project",
        { headers: authHeader() }
      ),
      buildWorkerEnv()
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: string };
    expect(body.success).toBe(true);
    expect(typeof body.data).toBe("string");
  });

  test("GET /api/stats → get memory counts", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/stats?project_id=test/e2e-project", {
        headers: authHeader(),
      }),
      buildWorkerEnv()
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { shortCount: number; longCount: number } };
    expect(body.success).toBe(true);
  });

  test("POST /api/memories/search → keyword search", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/memories/search/keyword", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({
          query: "React TypeScript",
          kind: "long",
          project_id: "test/e2e-project",
        }),
      }),
      buildWorkerEnv()
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: KeywordSearchResult[] };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("401 without auth", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/memories"),
      buildWorkerEnv()
    );
    expect(res.status).toBe(401);
  });

  test("GET /health", async () => {
    const res = await app.fetch(
      new Request("http://localhost/health"),
      buildWorkerEnv()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  test("DELETE /api/memories/:id → delete", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/memories/fake-id-123", {
        method: "DELETE",
        headers: authHeader(),
      }),
      buildWorkerEnv()
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
  });
});
