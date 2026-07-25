import type { MemoryManager } from "../memory/MemoryManager.js";
import { handleList } from "./handleList.js";
import { toErrorMessage } from "../utils/fs.js";

export async function handleRead(
  params: {
    target?: string;
    date?: string;
    project?: string;
    category?: string;
    sub_type?: string;
    scope?: string;
  },
  memoryManager: MemoryManager,
): Promise<string> {
  const { target, date, project, category, sub_type, scope } = params;

  if (!target) {
    return handleList({}, memoryManager);
  }

  try {
    const { filePath, displayName } = memoryManager.getPathForTarget(
      target,
      date,
      project || undefined,
      category,
      sub_type,
      scope,
    );
    const scopeTag = project
      ? `[scope: project/${project}]`
      : `[scope: global]`;
    const content = await memoryManager.readFile(filePath);
    if (!content) {
      return `${scopeTag} ${displayName} not found or empty.`;
    }
    return `${scopeTag}\n\n${content}`;
  } catch (error) {
    return toErrorMessage(error, `Unknown target: ${target}`);
  }
}
