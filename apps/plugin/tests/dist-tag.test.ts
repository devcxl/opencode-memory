import { expect, test } from "bun:test";
import * as path from "node:path";
import { resolveDistTag } from "../src/release/distTag.js";

const CLI_SCRIPT = path.join(
  import.meta.dir,
  "..",
  "src",
  "release",
  "distTagCli.ts",
);

// ─── 版本 → dist-tag 映射 ─────────────────────────────────────

test("1.x 映射到 latest", () => {
  expect(resolveDistTag("1.2.0")).toBe("latest");
  expect(resolveDistTag("1.2.1")).toBe("latest");
});

test("2.x 稳定版映射到 v2", () => {
  expect(resolveDistTag("2.0.0")).toBe("v2");
  expect(resolveDistTag("2.0.1")).toBe("v2");
  expect(resolveDistTag("2.1.0")).toBe("v2");
  expect(resolveDistTag("2.0.0+build.5")).toBe("v2");
});

test("2.x prerelease 映射到 rc", () => {
  expect(resolveDistTag("2.0.0-rc.1")).toBe("rc");
  expect(resolveDistTag("2.1.0-beta.1")).toBe("rc");
  expect(resolveDistTag("2.0.0-rc.2")).toBe("rc");
});

test("任何 2.x 都不会映射到 latest", () => {
  const versions = [
    "2.0.0",
    "2.0.1",
    "2.1.0",
    "2.99.99",
    "2.0.0-rc.1",
    "2.1.0-beta.1",
    "2.0.0-alpha.1",
  ];

  for (const version of versions) {
    expect(resolveDistTag(version)).not.toBe("latest");
  }
});

// ─── 非法版本 ────────────────────────────────────────────────

test("空版本或非法格式抛明确错误", () => {
  const invalidVersions = [
    "",
    "   ",
    "2.0",
    "2",
    "v2.0.0",
    "abc",
    "2.0.0-",
    "latest",
  ];

  for (const version of invalidVersions) {
    expect(() => resolveDistTag(version)).toThrow(/Invalid version/);
    // 错误信息必须带上原始输入，便于在 CI 日志中定位
    try {
      resolveDistTag(version);
    } catch (error) {
      expect((error as Error).message).toContain(JSON.stringify(version));
    }
  }
});

test("不支持的 major 版本抛明确错误，避免误落 latest", () => {
  expect(() => resolveDistTag("0.9.0")).toThrow(/Unsupported major version/);
  expect(() => resolveDistTag("3.0.0")).toThrow(/Unsupported major version/);
});

// ─── CLI 入口（workflow 使用的唯一实现）──────────────────────

test("CLI 输出映射结果并以 0 退出", () => {
  const result = Bun.spawnSync([process.execPath, CLI_SCRIPT, "2.0.1"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim()).toBe("v2");
});

test("CLI 缺少版本参数时输出用法并以非零退出", () => {
  const result = Bun.spawnSync([process.execPath, CLI_SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toMatch(/Usage:/);
});

test("CLI 对非法版本以非零退出并输出错误", () => {
  const result = Bun.spawnSync([process.execPath, CLI_SCRIPT, "2.0"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toMatch(/Invalid version/);
});
