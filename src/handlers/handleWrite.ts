import type { MemoryManager } from "../memory/MemoryManager.js";
import { validateTarget, validateContent } from "../utils/validation.js";

/**
 * 写入或追加内容到内存文件。
 * 默认追加模式（携带时间戳），overwrite 模式直接覆盖。
 * 写入后附带反思提示，引导 AI 评估本次写入的意义与关联。
 *
 * @param params - target、content、mode、date、project
 * @param memoryManager - MemoryManager 实例
 * @returns 操作结果（含时间戳和反思提示）
 */
export async function handleWrite(
  params: {
    target?: string;
    content?: string;
    mode?: string;
    date?: string;
    project?: string;
  },
  memoryManager: MemoryManager,
): Promise<string> {
  const { target, content, mode, date, project } = params;

  if (!content) {
    return "Error: content is required for write action.";
  }

  if (!target) {
    return "Error: target is required for write action.";
  }

  validateTarget(target);
  validateContent(content);

  if (project && target === "memory") {
    memoryManager.ensureProjectDirs(project);
  }

  try {
    const { filePath, displayName } = memoryManager.getPathForTarget(
      target,
      date,
      project || undefined,
    );

    const timestamp = memoryManager.getLocalTimestamp();

    if (mode === "overwrite") {
      await memoryManager.writeFile(filePath, content);
    } else {
      await memoryManager.appendFile(filePath, content);
    }

    const reflectionPrompt = [
      "",
      "[REFLECTION TRIGGERED]",
      `After writing to ${displayName}, ask yourself:`,
      "1. Why was this update important?",
      "2. What pattern does this reveal about the user or project?",
      "3. Should this trigger additional memory updates (cross-referencing)?",
      "4. How does this connect to previous memories?",
    ].join("\n");

    return `${mode === "overwrite" ? "Wrote to" : "Appended to"} ${displayName}.${reflectionPrompt}\n\nTimestamp: ${timestamp}`;
  } catch (error) {
    return error instanceof Error ? error.message : `Unknown target: ${target}`;
  }
}
