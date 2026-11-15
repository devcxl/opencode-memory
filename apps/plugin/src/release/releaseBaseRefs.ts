/**
 * 发布 tag 允许的基底分支 —— 唯一实现。
 *
 * 发布 workflow 通过 `releaseBaseRefsCli.ts` 读取本规则，不要在每个 workflow 里重复判断。
 *
 * - `1.x`（dist-tag `latest`）：V1 维护线。允许来自 `v1` 维护分支，也允许来自 `main`
 *   （V1 时代的提交仍在 main 历史上；tag 必须等于 package version 的校验会挡住 2.x 代码）。
 * - `2.x`（dist-tag `v2` / `rc`）：**只允许** `main`。V2 代码必须经过 main 上的 CI 与审查。
 * - 其它 major：抛错（fail closed，与 `distTag.ts` 的规则保持一致）。
 *
 * 本模块刻意复用 `resolveDistTag`：不可能出现「按 dist-tag 规则可发到 v2、却允许从 v1 分支发」的组合。
 */

import { resolveDistTag } from "./distTag.js";

/** 默认分支：2.x 发布的唯一合法基底。 */
export const DEFAULT_BRANCH = "main";

/** V1 维护分支：只服务 1.x 发布。 */
export const V1_MAINTENANCE_BRANCH = "v1";

/**
 * 返回允许承载该版本发布 tag 的分支名（按优先级排序）。
 *
 * @throws 版本格式非法、major 不受支持时抛出带有原始输入的错误（由 `resolveDistTag` 提供）。
 */
export function resolveReleaseBaseRefs(version: string): string[] {
  const distTag = resolveDistTag(version);

  if (distTag === "latest") {
    return [V1_MAINTENANCE_BRANCH, DEFAULT_BRANCH];
  }

  if (distTag === "v2" || distTag === "rc") {
    return [DEFAULT_BRANCH];
  }

  throw new Error(
    `No release base branch configured for dist-tag ${JSON.stringify(distTag)}: ` +
      `新增 dist-tag 时必须先决定它允许从哪些分支发布`,
  );
}
