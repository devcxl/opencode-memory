import type { MemoryManager } from "../memory/MemoryManager.js";

/**
 * 替换内存文件中的指定文本片段。
 * 要求先读取文件获取精确的 oldString，防止正则歧义匹配。
 *
 * @param params - target、oldString、newString、date、project
 * @param memoryManager - MemoryManager 实例
 * @returns 操作结果（含时间戳）
 */
export async function handleEdit(
  params: {
    target?: string;
    oldString?: string;
    newString?: string;
    date?: string;
    project?: string;
  },
  memoryManager: MemoryManager,
): Promise<string> {
  const { target, oldString, newString, date, project } = params;

  if (!target) {
    return "Error: target is required for edit action.";
  }

  if (!oldString) {
    return "Error: oldString is required for edit action.";
  }

  if (newString === undefined) {
    return "Error: newString is required for edit action.";
  }

  try {
    const { filePath, displayName } = memoryManager.getPathForTarget(
      target,
      date,
      project || undefined,
    );
    await memoryManager.editFile(filePath, oldString, newString);
    const timestamp = memoryManager.getLocalTimestamp();
    return `Edited ${displayName}\n\nTimestamp: ${timestamp}`;
  } catch (error) {
    return error instanceof Error ? error.message : `Failed to edit ${target}`;
  }
}
