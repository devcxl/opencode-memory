import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { verifyDistTags } from "../src/release/verifyDistTags.js";

const CLI_SCRIPT = path.join(
  import.meta.dir,
  "..",
  "src",
  "release",
  "verifyDistTagsCli.ts",
);

/** 发布后的真实形态：latest 停在 V1。 */
const HEALTHY_TAGS = {
  latest: "1.2.1",
  v2: "2.0.0",
  rc: "2.0.0-rc.1",
};

// ─── 健康状态 ────────────────────────────────────────────────

test("2.x 稳定版发布后 latest 仍指 V1、v2 指本次版本时校验通过", () => {
  expect(
    verifyDistTags({ version: "2.0.0", distTag: "v2", distTags: HEALTHY_TAGS }),
  ).toEqual([]);
});

test("RC 发布时只有 rc 前进，latest / v2 保持不动", () => {
  const distTags = { latest: "1.2.1", v2: "2.0.0", rc: "2.0.0-rc.2" };

  expect(
    verifyDistTags({ version: "2.0.0-rc.2", distTag: "rc", distTags }),
  ).toEqual([]);
});

test("首次 RC（还没有 v2）时校验通过", () => {
  const distTags = { latest: "1.2.1", rc: "2.0.0-rc.1" };

  expect(
    verifyDistTags({ version: "2.0.0-rc.1", distTag: "rc", distTags }),
  ).toEqual([]);
});

test("1.x 发布到 latest 时校验通过", () => {
  const distTags = { latest: "1.2.1", v2: "2.0.0" };

  expect(
    verifyDistTags({ version: "1.2.1", distTag: "latest", distTags }),
  ).toEqual([]);
});

// ─── 失败状态 ────────────────────────────────────────────────

test("发布的版本不在目标 dist-tag 上时报告问题", () => {
  const problems = verifyDistTags({
    version: "2.0.1",
    distTag: "v2",
    distTags: HEALTHY_TAGS,
  });

  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("v2");
  expect(problems[0]).toContain("2.0.0");
});

test("latest 被切到 2.x 时报告问题（S1）", () => {
  const problems = verifyDistTags({
    version: "2.0.0",
    distTag: "v2",
    distTags: { ...HEALTHY_TAGS, latest: "2.0.0" },
  });

  expect(problems.some((problem) => problem.includes("latest"))).toBe(true);
});

test("latest 被误用为本次发布 tag 时同时报告两处问题", () => {
  const problems = verifyDistTags({
    version: "2.0.0",
    distTag: "latest",
    distTags: { ...HEALTHY_TAGS, latest: "2.0.0" },
  });

  expect(problems.length).toBeGreaterThanOrEqual(2);
  expect(problems.some((problem) => problem.includes("按规则应发布到"))).toBe(
    true,
  );
});

test("latest 缺失时报告问题（V1 用户失去升级路径）", () => {
  const problems = verifyDistTags({
    version: "2.0.0",
    distTag: "v2",
    distTags: { v2: "2.0.0" },
  });

  expect(problems.some((problem) => problem.includes("latest"))).toBe(true);
});

test("rc 指向稳定版、v2 指向 V1 时报告问题", () => {
  const problems = verifyDistTags({
    version: "2.0.0",
    distTag: "v2",
    distTags: { latest: "1.2.1", v2: "1.2.1", rc: "2.0.0" },
  });

  expect(problems.some((problem) => problem.includes('"rc"'))).toBe(true);
  expect(problems.some((problem) => problem.includes('"v2"'))).toBe(true);
});

test("dist-tag 指向无法识别的版本时报告问题", () => {
  const problems = verifyDistTags({
    version: "2.0.0",
    distTag: "v2",
    distTags: { latest: "1.2.1", v2: "2.0.0", rc: "not-a-version" },
  });

  expect(problems.some((problem) => problem.includes("无法识别"))).toBe(true);
});

// ─── CLI 入口（workflow 使用的唯一实现）──────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dist-tags-verify-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeSnapshot(distTags: unknown): string {
  const file = path.join(tempDir, "dist-tags.json");
  fs.writeFileSync(file, JSON.stringify(distTags), "utf8");
  return file;
}

function runCli(args: string[]) {
  return Bun.spawnSync([process.execPath, CLI_SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("CLI 校验通过时以 0 退出", () => {
  const result = runCli(["2.0.0", "v2", writeSnapshot(HEALTHY_TAGS)]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("校验通过");
});

test("CLI 校验失败时以非零退出并输出 ::error:: 注解", () => {
  const snapshot = writeSnapshot({ ...HEALTHY_TAGS, latest: "2.0.0" });
  const result = runCli(["2.0.0", "v2", snapshot]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("::error::");
  expect(result.stderr.toString()).toContain("latest");
});

test("CLI 缺少参数时输出用法并以非零退出", () => {
  const result = runCli(["2.0.0", "v2"]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toMatch(/Usage:/);
});

test("CLI 对非法快照内容以非零退出", () => {
  const invalid = runCli([
    "2.0.0",
    "v2",
    writeSnapshot(["not", "an", "object"]),
  ]);

  expect(invalid.exitCode).not.toBe(0);
  expect(invalid.stderr.toString()).toContain("格式非法");

  const missing = runCli(["2.0.0", "v2", path.join(tempDir, "missing.json")]);

  expect(missing.exitCode).not.toBe(0);
  expect(missing.stderr.toString()).toContain("无法读取");
});
