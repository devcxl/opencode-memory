import type { Plugin } from "@opencode/plugin";
import type { MemoryManager } from "../memory/MemoryManager.js";
import type { SessionProjectResolver } from "../session/SessionProjectResolver.js";
import { handleRead } from "../handlers/handleRead.js";
import { handleWrite } from "../handlers/handleWrite.js";
import { handleEdit } from "../handlers/handleEdit.js";
import { handleDelete } from "../handlers/handleDelete.js";
import { handleSearch } from "../handlers/handleSearch.js";
import { handleList } from "../handlers/handleList.js";
import { resolveProjectId } from "../utils/defaultProject.js";
import { toErrorMessage } from "../utils/fs.js";
import { validateAction } from "../utils/validation.js";
import {
  MemoryToolInput,
  MEMORY_TOOL_DESCRIPTION,
  type MemoryToolInput as MemoryToolArgs,
} from "./schema.js";

type PluginContext = Plugin.Context;

export interface MemoryToolDependencies {
  memoryManager: MemoryManager;
  projects: SessionProjectResolver;
}

/**
 * 注册 V2 `memory` 工具。
 *
 * V2 通过 `ctx.tool.transform` 注册工具，input 直接使用 Zod 4 schema
 * （满足 Standard Schema），执行结果必须返回 `{ content }` 结构。
 */
export async function registerMemoryTool(
  ctx: PluginContext,
  deps: MemoryToolDependencies,
): Promise<void> {
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "memory",
      description: MEMORY_TOOL_DESCRIPTION,
      input: MemoryToolInput,
      async execute(args, context) {
        try {
          const content = await executeMemoryTool(
            args,
            context.sessionID,
            deps,
          );
          return { content };
        } catch (error) {
          return {
            content: toErrorMessage(error, "Memory tool execution failed"),
          };
        }
      },
    });
  });
}

/** 按 action 分发到既有 handler；业务逻辑与 V1 保持一致 */
async function executeMemoryTool(
  args: MemoryToolArgs,
  sessionID: string,
  deps: MemoryToolDependencies,
): Promise<string> {
  const { memoryManager, projects } = deps;

  await memoryManager.ensureDirectories();
  validateAction(args.action);

  // 使用 session 自身所在项目，而不是插件加载位置
  const detectedProject = await projects.resolve(sessionID);
  const resolvedProject = resolveProjectId(args.scope, detectedProject);
  const project = resolvedProject ?? undefined;

  switch (args.action) {
    case "read":
      return handleRead({ ...args, project }, memoryManager);
    case "write":
      return handleWrite({ ...args, project }, memoryManager);
    case "edit":
      return handleEdit({ ...args, project }, memoryManager);
    case "delete":
      return handleDelete({ ...args, project }, memoryManager);
    case "search":
      return handleSearch(
        {
          ...args,
          scope: args.scope ?? (resolvedProject !== null ? "all" : "global"),
        },
        memoryManager,
        resolvedProject,
      );
    case "list":
      return handleList({ ...args, project }, memoryManager);
    default: {
      const exhaustive: never = args.action;
      return `Unknown action: ${exhaustive}`;
    }
  }
}
