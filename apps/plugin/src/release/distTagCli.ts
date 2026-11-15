/**
 * 发布 workflow 的命令行入口：stdout 输出 dist-tag，失败时非零退出。
 *
 * 用法：bun apps/plugin/src/release/distTagCli.ts <version>
 */

import { resolveDistTag } from "./distTag.js";

const USAGE = "Usage: bun apps/plugin/src/release/distTagCli.ts <version>";

const version = process.argv[2];

if (version === undefined) {
  console.error(USAGE);
  process.exit(1);
}

try {
  console.log(resolveDistTag(version));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
