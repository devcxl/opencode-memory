import type { MemoryManager } from "../memory/MemoryManager.js";
import { validateTarget, validateTimestamp } from "../utils/validation.js";
import { toErrorMessage } from "../utils/fs.js";

/**
 * 按精确时间戳删除内存文件中的条目。
 * timestamp 需先通过 list 或 search 获取，格式严格为 YYYY-MM-DD 或 YYYY-MM-DD HH:MM:SS。
 *
 * @param params - target、timestamp、date、project
 * @param memoryManager - MemoryManager 实例
 * @returns 操作结果
 */
export async function handleDelete(
  params: {
    target?: string;
    timestamp?: string;
    date?: string;
    project?: string;
  },
  memoryManager: MemoryManager,
): Promise<string> {
  const { target, timestamp, date, project } = params;

  if (!target) {
    return "Error: target is required for delete action.";
  }

  if (!timestamp) {
    return "Error: timestamp is required for delete action. Format: YYYY-MM-DD or YYYY-MM-DD HH:MM:SS. Use memory_list or memory_search to find exact timestamps.";
  }

  validateTarget(target);
  validateTimestamp(timestamp);

  try {
    const result = await memoryManager.deleteByTimestamp(
      target,
      timestamp,
      date,
      project || undefined,
    );
    const scopeTag = project
      ? `[scope: project/${project}]`
      : `[scope: global]`;
    return `${scopeTag} ${result}\n\nDeleted timestamp: ${timestamp}`;
  } catch (error) {
    return toErrorMessage(error, `Failed to delete from ${target}`);
  }
}
