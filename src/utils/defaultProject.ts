import { validateProjectId } from "./validation.js";

/** memory 工具调用中涉及 project 的参数集合 */
interface ProjectScopedArgs {
  action?: string;
  target?: string;
  project?: string;
}

/**
 * 为 read/write + target=memory 的操作自动注入当前项目 ID。
 *
 * 仅在以下条件同时满足时才注入：
 * - action 为 read 或 write
 * - target 为 memory
 * - 调用方未手动传 project 参数
 * - 当前工作目录能被识别为一个有效 project
 *
 * 避免 AI 在跨项目场景下忘记传 project，导致全局 MEMORY.md 被误写。
 */
export function applyDefaultProject<T extends ProjectScopedArgs>(
  args: T,
  projectId: string | null,
): T {
  if (
    (args.action !== "read" && args.action !== "write") ||
    args.target !== "memory" ||
    args.project !== undefined ||
    !projectId
  ) {
    return args;
  }

  validateProjectId(projectId);
  return { ...args, project: projectId };
}
