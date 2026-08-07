import type { MemoryManager } from "../memory/MemoryManager.js";
import { toErrorMessage } from "../utils/fs.js";

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
    const scopeTag = project
      ? `[scope: project/${project}]`
      : `[scope: global]`;
    const result = `${scopeTag} Edited ${displayName}`;
    // remote 模式：记录时间由服务端 created_at 决定，本地时间戳无意义且会误导删除
    if (memoryManager.isRemote()) {
      return `${result}\n\n(remote 记录时间以 read/list 返回的时间戳为准)`;
    }
    return `${result}\n\nTimestamp: ${memoryManager.getLocalTimestamp()}`;
  } catch (error) {
    return toErrorMessage(error, `Failed to edit ${target}`);
  }
}
