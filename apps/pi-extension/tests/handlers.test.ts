import { describe, test, expect, afterEach } from "bun:test";
import { MemoryClient } from "@devcxl/cabbage-memory-shared";
import {
  handleAdd,
  handleSearch,
  handleList,
  handleUpdate,
  handleDelete,
} from "../src/handlers.js";

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetch(respond: (url: string, init?: RequestInit) => unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, init });
    return new Response(
      JSON.stringify({ success: true, data: respond(url, init) }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;
  return calls;
}

const client = new MemoryClient({
  apiUrl: "https://mem.test",
  apiKey: "opm_k",
});

describe("pi 扩展 handlers", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("handleAdd：fact 校验 subtype，daily 默认挂当前项目", async () => {
    const calls = mockFetch(() => ({ id: "m-1" }));

    const ok = await handleAdd(
      client,
      { type: "fact", subtype: "knowledge", title: "T", content: "C" },
      "owner/repo",
    );
    expect(ok).toContain("m-1");
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.project_id).toBe("owner/repo");
    expect(body.type).toBe("fact");

    expect(
      handleAdd(
        client,
        { type: "fact", subtype: "rule", title: "T", content: "C" },
        null,
      ),
    ).rejects.toThrow(/subtype/);

    // scope=global 强制全局
    await handleAdd(
      client,
      { type: "daily", content: "x", scope: "global" },
      "owner/repo",
    );
    const globalBody = JSON.parse(calls[1].init?.body as string);
    expect(globalBody.project_id).toBeUndefined();
  });

  test("handleSearch：透传 query，scope=global 不过滤项目", async () => {
    const calls = mockFetch(() => [
      {
        id: "r1",
        type: "fact",
        subtype: "knowledge",
        title: "T",
        content: "华北销售额 100 万",
        tags: "[]",
        project_id: "",
        date: "",
        created_at: 1,
        bucket: "full-match",
        score: 0.1,
        snippet: "",
      },
    ]);

    const out = await handleSearch(
      client,
      { query: "销售额", scope: "global" },
      "owner/repo",
    );
    expect(
      JSON.parse(calls[0].init?.body as string).project_id,
    ).toBeUndefined();
    expect(out).toContain("华北销售额 100 万");
    expect(out).toContain("bucket=full-match");
  });

  test("handleList 按 type 分组", async () => {
    mockFetch(() => [
      {
        id: "d1",
        type: "daily",
        subtype: "",
        title: "",
        content: "day log",
        project_id: "",
        date: "2026-09-01",
        created_at: 1,
      },
      {
        id: "f1",
        type: "fact",
        subtype: "knowledge",
        title: "Fact",
        content: "a fact",
        project_id: "",
        date: "",
        created_at: 2,
      },
    ]);
    const out = await handleList(client, {}, null);
    expect(out).toContain("## daily (2026-09-01) (1)");
    expect(out).toContain("## fact (1)");
  });

  test("handleUpdate / handleDelete 走对应端点", async () => {
    const calls = mockFetch(() => ({}));
    await handleUpdate(client, { id: "m-1", content: "new" });
    expect(calls[0].url).toContain("/api/memories/m-1");
    expect(calls[0].init?.method).toBe("PUT");

    await handleDelete(client, { id: "m-1" });
    expect(calls[1].init?.method).toBe("DELETE");
  });
});
