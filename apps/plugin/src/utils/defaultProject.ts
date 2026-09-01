/**
 * 根据 scope 解析 project ID。
 *
 * scope=global → 强制全局（返回 null）
 * scope=project → 自动检测当前项目 ID，检测不到时返回 null（全局）
 * 未指定 scope → 自动检测，检测不到返回 null
 */

/** project_id 格式：owner/repo 或 name.hash，限定合法字符 */
const PROJECT_ID_PATTERN = /^[\w.-]+(\/[\w.-]+|\.[0-9a-f]{8})$/;

export function isValidProjectId(projectId: string): boolean {
  return PROJECT_ID_PATTERN.test(projectId);
}

export function resolveProjectId(
  scope: string | undefined,
  detectedProjectId: string | null,
): string | null {
  if (scope === "global") return null;
  if (detectedProjectId && !isValidProjectId(detectedProjectId)) return null;
  return detectedProjectId;
}
