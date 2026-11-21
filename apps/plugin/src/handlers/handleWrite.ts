import type { MemoryManager } from "../memory/MemoryManager.js";
import type { MemoryOrigin } from "../types.js";
import { validateTarget, validateContent } from "../utils/validation.js";
import { toErrorMessage } from "../utils/fs.js";

/**
 * 写入或追加内容到内存文件。
 * 默认追加模式（携带时间戳），overwrite 模式直接覆盖。
 */
export async function handleWrite(
  params: {
    target?: string;
    content?: string;
    mode?: string;
    date?: string;
    project?: string;
    title?: string;
    replace_timestamps?: string[];
    origin?: MemoryOrigin;
  },
  memoryManager: MemoryManager,
): Promise<string> {
  const {
    target,
    content,
    mode,
    date,
    project,
    title,
    replace_timestamps,
    origin,
  } = params;

  if (!content) {
    return "Error: content is required for write action.";
  }

  if (!target) {
    return "Error: target is required for write action.";
  }

  validateTarget(target);
  validateContent(content);

  if (origin === "external" && target !== "daily") {
    return `Error: Entries with origin 'external' cannot be written directly to curated ${target}. Write to target 'daily' instead.`;
  }

  if (mode === "overwrite" && replace_timestamps?.length) {
    return "Error: replace_timestamps can only be used in append mode.";
  }

  if (project && (target === "memory" || target === "daily")) {
    memoryManager.ensureProjectDirs(project);
  }

  try {
    const { filePath, displayName } = memoryManager.getPathForTarget(
      target,
      date,
      project || undefined,
    );

    const effectiveContent = title ? `## ${title}\n${content}` : content;

    const budgetNote =
      mode === "overwrite"
        ? await memoryManager.writeFile(filePath, effectiveContent)
        : await memoryManager.appendFile(filePath, effectiveContent, {
            replaceTimestamps: replace_timestamps,
            origin,
          });

    const scopeTag = project
      ? `[scope: project/${project}]`
      : `[scope: global]`;

    const result = `${scopeTag} ${mode === "overwrite" ? "Wrote to" : "Appended to"} ${displayName}.`;
    const suffix = budgetNote
      ? `\n${budgetNote}\n\nTimestamp: ${memoryManager.getLocalTimestamp()}`
      : `\n\nTimestamp: ${memoryManager.getLocalTimestamp()}`;
    return `${result}${suffix}`;
  } catch (error) {
    return toErrorMessage(error, `Unknown target: ${target}`);
  }
}
