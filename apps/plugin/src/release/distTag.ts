/**
 * 发布 dist-tag 推导规则 —— 唯一实现。
 *
 * 发布 workflow 通过 `distTagCli.ts` 调用本模块，不要在 workflow 里重复这些规则。
 *
 * - `1.x` → `latest`：V1 线永久占据 `latest`，自动更新的 V1 用户不会被推到 V2。
 * - `2.x` 稳定版 → `v2`。
 * - `2.x` prerelease → `rc`。
 * - 其它 major → 抛错：新大版本必须显式更新本规则，不能静默落到 `latest`。
 */

export type DistTag = "latest" | "v2" | "rc";

// 仅接受 MAJOR.MINOR.PATCH [+ optional prerelease/build]；
// 不追求完整 semver 校验，只要能识别发布流水线会遇到的输入即可。
const SEMVER_PATTERN =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const LATEST_MAJOR = 1;
const V2_MAJOR = 2;

/**
 * 把版本字符串映射为 npm dist-tag。
 *
 * @throws 版本格式非法或不支持的 major 版本时抛出带有原始输入的错误。
 */
export function resolveDistTag(version: string): DistTag {
  const match = SEMVER_PATTERN.exec(version);

  if (!match) {
    throw new Error(
      `Invalid version ${JSON.stringify(version)}: expected MAJOR.MINOR.PATCH with an optional prerelease, ` +
        `e.g. "1.2.1" or "2.0.0-rc.1"`,
    );
  }

  const major = Number(match[1]);
  const isPrerelease = match[4] !== undefined;

  if (major === LATEST_MAJOR) {
    return "latest";
  }

  if (major === V2_MAJOR) {
    return isPrerelease ? "rc" : "v2";
  }

  throw new Error(
    `Unsupported major version in ${JSON.stringify(version)}: ` +
      `only 1.x ("latest") and 2.x ("v2"/"rc") are supported by this release pipeline`,
  );
}
