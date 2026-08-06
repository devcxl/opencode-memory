import { validateProjectId } from "./validation.js";

/**
 * 根据 scope 解析 project ID。
 *
 * scope=global → 强制全局（返回 null）
 * scope=project → 自动检测当前项目 ID，检测不到或非法时降级为 null（全局）
 * 未指定 scope → 自动检测，检测不到或非法时返回 null
 */
export function resolveProjectId(
  scope: string | undefined,
  detectedProjectId: string | null,
): string | null {
  if (scope === "global") return null;
  if (detectedProjectId) {
    try {
      validateProjectId(detectedProjectId);
    } catch {
      return null;
    }
  }
  return detectedProjectId;
}
