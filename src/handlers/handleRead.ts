import type { MemoryManager } from "../memory/MemoryManager.js";
import { handleList } from "./handleList.js";

/**
 * 读取指定目标的内存文件内容。
 * 未指定 target 时回退到 list 行为，避免静默失败。
 *
 * @param params - target、date、project
 * @param memoryManager - MemoryManager 实例
 * @returns 文件内容字符串，或错误提示
 */
export function handleRead(
  params: { target?: string; date?: string; project?: string },
  memoryManager: MemoryManager,
): string {
  const { target, date, project } = params;

  if (!target) {
    return handleList({}, memoryManager);
  }

  try {
    const { filePath, displayName } = memoryManager.getPathForTarget(
      target,
      date,
      project || undefined,
    );
    const content = memoryManager.readFile(filePath);
    if (!content) {
      return `${displayName} not found or empty.`;
    }
    return content;
  } catch (error) {
    return error instanceof Error ? error.message : `Unknown target: ${target}`;
  }
}
