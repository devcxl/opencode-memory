/**
 * E2E 测试：远程模式直连本地 Worker
 *
 * 运行前需要：
 *   1. 启动 Worker:  cd apps/api && JWT_SECRET=test-secret npx wrangler dev --remote
 *   2. 生成 JWT:      JWT_SECRET=test-secret npx tsx scripts/generate-jwt.ts
 *   3. 设置环境变量:   export CFMEM_E2E_API_KEY=<JWT>
 *
 * 运行时跳过（除非设置 CFMEM_E2E=1），日常用 mock 测试覆盖
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const API_URL = process.env.CFMEM_API_URL || "http://localhost:8787";
const API_KEY = process.env.CFMEM_E2E_API_KEY || "";
const RUN_E2E = process.env.CFMEM_E2E === "1";

// 没有 JWT 或未设置 CFMEM_E2E=1 则跳过
const it = RUN_E2E && API_KEY ? test : test.skip;

describe("E2E: Remote mode → Cloudflare Worker", () => {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
  };

  const writtenIds: string[] = [];

  afterAll(async () => {
    // 清理测试数据
    for (const id of writtenIds) {
      await fetch(`${API_URL}/api/memories/${id}`, {
        method: "DELETE",
        headers,
      }).catch(() => {});
    }
  });

  it("health check", async () => {
    const res = await fetch(`${API_URL}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  it("write → search → read → delete 完整流程", async () => {
    // 1. 写入
    const writeRes = await fetch(`${API_URL}/api/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: "E2E 测试：React 项目使用 TypeScript + Vite 作为构建工具",
        kind: "long",
        file_type: "memory",
        project_id: "test/e2e-project",
        tags: ["react", "typescript", "e2e"],
      }),
    });
    expect(writeRes.status).toBe(200);
    const { data: writeData } = (await writeRes.json()) as any;
    expect(writeData.id).toBeTruthy();
    writtenIds.push(writeData.id);

    // 2. 搜索（等 Vectorize 索引，最多 5 秒）
    await new Promise((r) => setTimeout(r, 2000));
    const searchRes = await fetch(`${API_URL}/api/memories/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: "React TypeScript 构建工具",
        topK: 5,
        project_id: "test/e2e-project",
      }),
    });
    expect(searchRes.status).toBe(200);
    const { data: searchData } = (await searchRes.json()) as any;
    expect(searchData.length).toBeGreaterThan(0);

    // 3. 读取列表
    const listRes = await fetch(
      `${API_URL}/api/memories?kind=long&file_type=memory&project_id=test/e2e-project`,
      { headers }
    );
    expect(listRes.status).toBe(200);
    const { data: listData } = (await listRes.json()) as any;
    expect(listData.some((m: any) => m.id === writeData.id)).toBe(true);

    // 4. 获取 context
    const ctxRes = await fetch(
      `${API_URL}/api/context?project_id=test/e2e-project`,
      { headers }
    );
    expect(ctxRes.status).toBe(200);
    const { data: ctxData } = (await ctxRes.json()) as any;
    expect(ctxData).toContain("## MEMORY.md");

    // 5. 删除
    const delRes = await fetch(`${API_URL}/api/memories/${writeData.id}`, {
      method: "DELETE",
      headers,
    });
    expect(delRes.status).toBe(200);

    // 从清理列表移除（已手动删除）
    writtenIds.splice(writtenIds.indexOf(writeData.id), 1);
  }, 15000);

  it("daily 日志写入与日期过滤", async () => {
    const writeRes = await fetch(`${API_URL}/api/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: "完成了 E2E 测试配置",
        kind: "short",
        file_type: "daily",
        date: "2026-07-22",
        project_id: "test/e2e-project",
      }),
    });
    expect(writeRes.status).toBe(200);
    const { data } = (await writeRes.json()) as any;
    writtenIds.push(data.id);

    const listRes = await fetch(
      `${API_URL}/api/memories?file_type=daily&project_id=test/e2e-project`,
      { headers }
    );
    expect(listRes.status).toBe(200);
    const { data: listData } = (await listRes.json()) as any;
    expect(listData.length).toBeGreaterThan(0);
  }, 10000);
});
