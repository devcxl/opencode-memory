import { describe, test, expect, beforeAll, mock, afterEach } from "bun:test";

/**
 * 扩展入口集成测试：
 * mock 掉 pi 运行时模块与 fetch，验证工具注册、execute 分发与上下文注入。
 */

const ORIGINAL_FETCH = globalThis.fetch;

interface RegisteredTool {
  name: string;
  description: string;
  parameters: object;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

const registeredTools = new Map<string, RegisteredTool>();
const eventHandlers = new Map<
  string,
  Array<
    (
      event: { systemPrompt: string },
      ctx: unknown,
    ) => Promise<{ systemPrompt?: string } | void>
  >
>();

mock.module("@mariozechner/pi-coding-agent", () => ({
  pi: {
    registerTool: (tool: RegisteredTool) =>
      registeredTools.set(tool.name, tool),
    on: (
      event: string,
      handler: (
        event: { systemPrompt: string },
        ctx: unknown,
      ) => Promise<{ systemPrompt?: string } | void>,
    ) => {
      if (!eventHandlers.has(event)) eventHandlers.set(event, []);
      eventHandlers.get(event)!.push(handler);
    },
  },
}));

// 测试环境注入 fetch mock（加载扩展前完成）
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
  let data: unknown = null;
  if (url.includes("/api/context"))
    data = { context: "## IDENTITY\n\nTest identity" };
  if (url.includes("/api/memories") && init?.method === "POST")
    data = { id: "m-new" };
  if (url.includes("/api/memories/search"))
    data = [
      {
        id: "r1",
        type: "fact",
        subtype: "knowledge",
        title: "T",
        content: "hello world",
        tags: "[]",
        project_id: "",
        date: "",
        created_at: 1,
        bucket: "fused",
        score: 0.5,
        snippet: "",
      },
    ];
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;

let extensionLoadError: Error | null = null;
beforeAll(async () => {
  process.env.OPM_API_URL = "https://mem.test";
  process.env.OPM_API_KEY = "opm_test";
  try {
    await import("../src/extension.js");
  } catch (error) {
    extensionLoadError = error as Error;
  }
});

describe("pi 扩展入口", () => {
  afterEach(() => {
    // 保留 fetch mock（模块加载即注册，卸载会破坏后续用例）
  });

  test("加载成功且注册 6 个 memory 工具", () => {
    expect(extensionLoadError).toBeNull();
    const names = [...registeredTools.keys()].sort();
    expect(names).toEqual([
      "memory_add",
      "memory_delete",
      "memory_get",
      "memory_list",
      "memory_search",
      "memory_update",
    ]);
  });

  test("memory_add execute 走 client 并返回文本内容", async () => {
    const tool = registeredTools.get("memory_add")!;
    const result = await tool.execute("t1", {
      type: "daily",
      content: "今天写了 pi 扩展",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("m-new");
  });

  test("memory_search execute 返回搜索结果", async () => {
    const tool = registeredTools.get("memory_search")!;
    const result = await tool.execute("t2", { query: "hello" });
    expect(result.content[0].text).toContain("hello world");
  });

  test("参数校验错误以 isError 文本返回，不抛异常", async () => {
    const tool = registeredTools.get("memory_add")!;
    const result = await tool.execute("t3", {
      type: "fact",
      subtype: "rule",
      content: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("subtype");
  });

  test("before_agent_start 注入上下文与使用说明", async () => {
    const handlers = eventHandlers.get("before_agent_start")!;
    expect(handlers.length).toBe(1);
    const result = await handlers[0]({ systemPrompt: "BASE" }, {});
    expect(result?.systemPrompt).toContain("BASE");
    expect(result?.systemPrompt).toContain("## IDENTITY");
    expect(result?.systemPrompt).toContain("# Memory Usage");
  });
});
