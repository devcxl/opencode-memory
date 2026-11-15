/**
 * 发布 workflow 的命令行入口：stdout 输出允许的基底分支（空格分隔），失败时非零退出。
 *
 * 用法：bun apps/plugin/src/release/releaseBaseRefsCli.ts <version>
 */

import { resolveReleaseBaseRefs } from "./releaseBaseRefs.js";

const USAGE =
  "Usage: bun apps/plugin/src/release/releaseBaseRefsCli.ts <version>";

const version = process.argv[2];

if (version === undefined) {
  console.error(USAGE);
  process.exit(1);
}

try {
  console.log(resolveReleaseBaseRefs(version).join(" "));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
