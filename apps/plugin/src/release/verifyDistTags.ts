/**
 * 发布后校验 registry 上的 version 与 dist-tags —— 唯一实现。
 *
 * 期望状态（规则来自 `distTag.ts`）：
 * - 本次发布使用的 dist-tag 指向本次 version
 * - `latest` 存在且仍指 V1（`1.x`）。被切到 2.x 属于 S1：所有 V1 用户会被自动更新到 V2-only 包
 * - registry 上出现的每个已知 tag（`latest` / `v2` / `rc`）都必须与版本规则自洽
 *
 * 只做纯计算：读 registry 的动作留在 workflow 里，便于本地用 fixture 干跑。
 */

import { resolveDistTag, type DistTag } from "./distTag.js";

/** `npm view <pkg> dist-tags --json` 的输出形态。 */
export type DistTagSnapshot = Record<string, string>;

const KNOWN_DIST_TAGS: readonly DistTag[] = ["latest", "v2", "rc"];

export interface DistTagCheck {
  /** 本次发布的版本，例如 `2.0.0-rc.1`。 */
  version: string;
  /** 本次发布使用的 dist-tag，应等于 `resolveDistTag(version)`。 */
  distTag: string;
  /** registry 上读到的 dist-tags 快照。 */
  distTags: DistTagSnapshot;
}

function quote(value: unknown): string {
  return value === undefined ? "（未设置）" : JSON.stringify(value);
}

/**
 * 返回所有不符合发布规则的问题；空数组表示校验通过。
 *
 * @throws 版本非法或 major 不受支持时抛错（由 `resolveDistTag` 提供）。
 */
export function verifyDistTags({
  version,
  distTag,
  distTags,
}: DistTagCheck): string[] {
  const expected = resolveDistTag(version);
  const problems: string[] = [];

  if (distTag !== expected) {
    problems.push(
      `本次发布使用了 dist-tag ${quote(distTag)}，但 ${version} 按规则应发布到 ${quote(expected)}`,
    );
  }

  if (distTags[distTag] !== version) {
    problems.push(
      `dist-tag ${quote(distTag)} 指向 ${quote(distTags[distTag])}，期望 ${quote(version)}`,
    );
  }

  for (const tag of KNOWN_DIST_TAGS) {
    const value = distTags[tag];

    if (value === undefined) {
      // latest 缺失会让 V1 用户失去自动更新路径；v2 / rc 在首个稳定版 / RC 之前可以不存在。
      if (tag === "latest") {
        problems.push(`dist-tag "latest" 不存在：V1 用户会失去自动更新路径`);
      }
      continue;
    }

    let mapped: DistTag;

    try {
      mapped = resolveDistTag(value);
    } catch {
      problems.push(
        `dist-tag ${quote(tag)} 指向无法识别的版本 ${quote(value)}`,
      );
      continue;
    }

    if (mapped !== tag) {
      problems.push(
        `dist-tag ${quote(tag)} 指向 ${quote(value)}，但该版本按规则属于 ${quote(mapped)}`,
      );
    }
  }

  return problems;
}
