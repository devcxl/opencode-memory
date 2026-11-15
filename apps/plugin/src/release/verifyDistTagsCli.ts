/**
 * 发布后校验的命令行入口：读取 `npm view <pkg> dist-tags --json` 的输出文件后校验。
 *
 * 用法：bun apps/plugin/src/release/verifyDistTagsCli.ts <version> <dist-tag> <dist-tags.json>
 */

import { readFileSync } from "node:fs";
import { verifyDistTags, type DistTagSnapshot } from "./verifyDistTags.js";

const USAGE =
  "Usage: bun apps/plugin/src/release/verifyDistTagsCli.ts <version> <dist-tag> <dist-tags.json>";

const [version, distTag, snapshotPath] = process.argv.slice(2);

if (
  version === undefined ||
  distTag === undefined ||
  snapshotPath === undefined
) {
  console.error(USAGE);
  process.exit(1);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

let parsed: unknown;

try {
  parsed = JSON.parse(readFileSync(snapshotPath, "utf8"));
} catch (error) {
  fail(
    `无法读取 dist-tags 快照 ${snapshotPath}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
  fail(`dist-tags 快照格式非法（期望 JSON 对象）：${snapshotPath}`);
}

const snapshot = parsed as DistTagSnapshot;

const invalidEntry = Object.entries(snapshot).find(
  ([, value]) => typeof value !== "string",
);

if (invalidEntry !== undefined) {
  fail(
    `dist-tags 快照格式非法（${invalidEntry[0]} 不是字符串）：${snapshotPath}`,
  );
}

let problems: string[];

try {
  problems = verifyDistTags({ version, distTag, distTags: snapshot });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (problems.length > 0) {
  for (const problem of problems) {
    // GitHub Actions 会把 ::error:: 行渲染成注解，失败原因直接出现在 job 摘要里
    console.error(`::error::${problem}`);
  }
  process.exit(1);
}

console.log(`✓ dist-tags 校验通过：${distTag}=${version}`);
