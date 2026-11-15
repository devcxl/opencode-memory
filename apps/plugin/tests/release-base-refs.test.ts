import { expect, test } from "bun:test";
import * as path from "node:path";
import {
  DEFAULT_BRANCH,
  V1_MAINTENANCE_BRANCH,
  resolveReleaseBaseRefs,
} from "../src/release/releaseBaseRefs.js";

const CLI_SCRIPT = path.join(
  import.meta.dir,
  "..",
  "src",
  "release",
  "releaseBaseRefsCli.ts",
);

// ─── 1.x：允许 v1 维护线 ─────────────────────────────────────

test("1.x 允许来自 v1 维护分支", () => {
  const refs = resolveReleaseBaseRefs("1.2.1");

  expect(refs).toContain(V1_MAINTENANCE_BRANCH);
  expect(refs[0]).toBe(V1_MAINTENANCE_BRANCH);
});

test("1.x 也允许来自 main（V1 时代的提交仍在 main 历史上）", () => {
  expect(resolveReleaseBaseRefs("1.2.1")).toContain(DEFAULT_BRANCH);
  expect(resolveReleaseBaseRefs("1.3.0")).toContain(DEFAULT_BRANCH);
});

// ─── 2.x：只允许 main，v1 例外不放宽 ─────────────────────────

test("2.x 稳定版只允许来自 main", () => {
  expect(resolveReleaseBaseRefs("2.0.0")).toEqual([DEFAULT_BRANCH]);
  expect(resolveReleaseBaseRefs("2.0.1")).toEqual([DEFAULT_BRANCH]);
});

test("2.x prerelease 只允许来自 main", () => {
  expect(resolveReleaseBaseRefs("2.0.0-rc.1")).toEqual([DEFAULT_BRANCH]);
  expect(resolveReleaseBaseRefs("2.1.0-beta.1")).toEqual([DEFAULT_BRANCH]);
});

test("任何 2.x 都不允许来自 v1 维护分支", () => {
  const versions = ["2.0.0", "2.0.1", "2.0.0-rc.1", "2.1.0-beta.1"];

  for (const version of versions) {
    expect(resolveReleaseBaseRefs(version)).not.toContain(
      V1_MAINTENANCE_BRANCH,
    );
  }
});

// ─── 非法输入 ────────────────────────────────────────────────

test("非法版本抛明确错误", () => {
  for (const version of ["", "2.0", "v2.0.0", "abc"]) {
    expect(() => resolveReleaseBaseRefs(version)).toThrow(/Invalid version/);
  }
});

test("不支持的 major 版本抛明确错误", () => {
  expect(() => resolveReleaseBaseRefs("3.0.0")).toThrow(
    /Unsupported major version/,
  );
  expect(() => resolveReleaseBaseRefs("0.9.0")).toThrow(
    /Unsupported major version/,
  );
});

// ─── CLI 入口（workflow 使用的唯一实现）──────────────────────

test("CLI 输出允许的分支并以 0 退出", () => {
  const result = Bun.spawnSync([process.execPath, CLI_SCRIPT, "1.2.1"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim()).toBe("v1 main");
});

test("CLI 对 2.x 只输出 main", () => {
  const result = Bun.spawnSync([process.execPath, CLI_SCRIPT, "2.0.0-rc.1"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim()).toBe("main");
});

test("CLI 缺少版本参数时输出用法并以非零退出", () => {
  const result = Bun.spawnSync([process.execPath, CLI_SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toMatch(/Usage:/);
});

test("CLI 对不支持的 major 以非零退出并输出错误", () => {
  const result = Bun.spawnSync([process.execPath, CLI_SCRIPT, "3.0.0"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toMatch(/Unsupported major version/);
});
