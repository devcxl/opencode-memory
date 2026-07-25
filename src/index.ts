import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { loadConfig } from "./config/runtime.js";
import { MemoryManager } from "./memory/MemoryManager.js";
import { BootstrapManager } from "./memory/BootstrapManager.js";
import { createProviders, type Providers } from "./providers/factory.js";
import { detectProject } from "./utils/projectDetector.js";
import {
  getMemoryAwarenessInstructions,
  BOOTSTRAP_INSTRUCTIONS,
} from "./instructions/memoryInstructions.js";
import { validateAction } from "./utils/validation.js";
import { handleRead } from "./handlers/handleRead.js";
import { handleWrite } from "./handlers/handleWrite.js";
import { handleEdit } from "./handlers/handleEdit.js";
import { handleDelete } from "./handlers/handleDelete.js";
import { handleSearch } from "./handlers/handleSearch.js";
import { handleList } from "./handlers/handleList.js";
import { resolveProjectId } from "./utils/defaultProject.js";

/** 追踪当前会话中 memory 工具调用记录，用于空闲时提示更新 daily log */
interface SessionState {
  /** 本会话所有 memory 操作记录，按时间排序 */
  memoryOperations: Array<{
    action: string;
    target: string;
    timestamp: string;
  }>;
  /** 最近一次 daily 更新的 ISO 时间戳，null 表示未更新过 */
  lastDailyUpdate: string | null;
}

/** memory 工具调用参数中需要的字段 */
interface MemoryCallArgs {
  action?: string;
  target?: string;
}

/** sessionID → 会话状态映射，随 session 生命周期管理 */
const sessionStates = new Map<string, SessionState>();

/**
 * OpenCode 记忆插件入口。
 * 通过 Plugin 接口集成到 OpenCode 事件系统与工具系统：
 * - 在 chat.system.transform 阶段注入记忆上下文
 * - 提供 memory 工具用于读写、编辑、删除、搜索、列出
 * - 追踪会话状态，空闲时提示更新 daily log
 * - 首次运行自动进入 bootstrap 引导流程
 */
export const MemoryPlugin: Plugin = async (ctx: PluginInput) => {
  const config = loadConfig();

  // 🆕 根据 mode 创建 Provider 实例并注入 MemoryManager
  let providers: Providers | undefined;
  if (config.mode === "remote" && config.remote) {
    providers = await createProviders("remote", config);
  }
  // local 模式：不注入 providers，MemoryManager 内部自动创建 LocalProvider

  const memoryManager = new MemoryManager(config, providers);
  const bootstrapManager = new BootstrapManager(memoryManager);
  const projectId = detectProject();

  // 引导阶段优先展示 BOOTSTRAP.md，避免同时展示引导和常规记忆造成信息过载。
  // 常规阶段按 MEMORY > IDENTITY > USER > PROJECT 顺序注入上下文文件。
  const buildContext = async (pId?: string | null): Promise<string> => {
    const sections: string[] = [];
    if (bootstrapManager.isBootstrapNeeded()) {
      const bootstrapContent = await memoryManager.readFile(
        memoryManager.getBootstrapPath(),
      );
      if (bootstrapContent?.trim()) {
        sections.push(
          `## BOOTSTRAP.md (First Run Setup)\n\n${bootstrapContent.trim()}`,
        );
      }
    } else {
      const contextFiles = await memoryManager.getContextFiles(pId);
      for (const file of contextFiles) {
        sections.push(`## ${file.name}\n\n${file.content}`);
      }
    }
    if (sections.length === 0) return "";
    return `# Memory Context\n\n${sections.join("\n\n---\n\n")}`;
  };

  // 引导阶段使用静态指令，常规阶段使用不含日期的静态指令。
  // 避免 {today} 替换导致每天 prompt 不同、KV cache 全量失效。
  const getMemoryInstructions = (): string => {
    if (bootstrapManager.isBootstrapNeeded()) {
      return BOOTSTRAP_INSTRUCTIONS;
    }
    return getMemoryAwarenessInstructions();
  };

  return {
    config: async (cfg) => {
      const state = memoryManager.getInitState();
      if (state !== "ready") {
        cfg.command = {
          ...cfg.command,
          "memory-init": {
            description: "Initialize OpenCode memory system (first-time setup)",
            template: [
              "You are initializing the OpenCode memory system for the first time.",
              "",
              "The initialization command has already created the following files:",
              "- BOOTSTRAP.md - First run setup instructions",
              "- MEMORY.md - Long-term memory template",
              "- IDENTITY.md - Agent identity template",
              "- USER.md - User profile template",
              "",
              "**Your task:**",
              "1. Read BOOTSTRAP.md to understand the setup process",
              "2. Interactively ask the user the bootstrap questions",
              "3. Write user responses to MEMORY.md, IDENTITY.md, USER.md using the memory tool",
              "4. Delete BOOTSTRAP.md when setup is complete",
              "",
              "Be conversational and natural. Do not overwhelm with all questions at once.",
            ].join("\n"),
          },
        };
      }
    },

    "command.execute.before": async (input) => {
      if (input.command !== "memory-init") return;
      if (memoryManager.getInitState() === "ready") return;
      // 创建所有初始模板文件（仅对尚不存在的文件创建）
      await bootstrapManager.createInitTemplates();
    },

    event: async ({ event }) => {
      // 不同事件类型携带的 sessionID 在不同属性位置
      const sessionID =
        event.type === "session.idle"
          ? event.properties.sessionID
          : event.type === "session.created" || event.type === "session.deleted"
            ? event.properties.info.id
            : undefined;

      // session.created：注册新的会话状态
      if (event.type === "session.created" && sessionID) {
        sessionStates.set(sessionID, {
          memoryOperations: [],
          lastDailyUpdate: null,
        });
      }

      // session.deleted：清理会话状态，避免内存泄漏
      if (event.type === "session.deleted" && sessionID) {
        sessionStates.delete(sessionID);
      }

      // session.idle：用户离开终端时，若有 memory 操作但未更新 daily，弹出提示
      if (event.type === "session.idle" && sessionID) {
        const state = sessionStates.get(sessionID);
        if (
          state &&
          state.memoryOperations.length > 0 &&
          !state.lastDailyUpdate
        ) {
          await ctx.client.tui.showToast({
            body: {
              message:
                "Tip: Update daily log with memory_write({target: 'daily', content: '...'})",
              variant: "info",
            },
          });
        }
      }
    },

    "tool.execute.after": async (input) => {
      if (input.tool === "memory") {
        const sessionID = input.sessionID;
        const state = sessionStates.get(sessionID);
        const args = input.args as MemoryCallArgs;

        if (state) {
          // 记录每次 memory 工具调用，用于空闲提醒
          state.memoryOperations.push({
            action: args.action ?? "unknown",
            target: args.target ?? "unknown",
            timestamp: new Date().toISOString(),
          });

          // 单独标记 daily 更新，避免在已更新后重复提醒
          if (args.target === "daily") {
            state.lastDailyUpdate = new Date().toISOString();
          }
        }
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      const memoryContext = await buildContext(
        resolveProjectId(undefined, projectId),
      );
      if (!memoryContext) return;
      // 将记忆上下文和感知指令注入到系统提示词中
      const instructions = getMemoryInstructions();
      output.system.push(memoryContext + instructions);
    },

    tool: {
      memory: tool({
        description: [
          "Manage memory files for persistent context across sessions.",
          "",
          "**Actions:**",
          "- `read`: Read a memory file (memory, identity, user, daily, or list all)",
          "- `write`: Write to a memory file. **DEFAULT to daily** for task summaries. Use memory target for knowledge worth retaining across sessions.",
          "- `edit`: Edit a specific part of memory/identity/user/daily file. AI must read file first to get exact oldString.",
          "- `delete`: Delete entries from a memory file by exact timestamp (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)",
          "- `search`: Semantic search across memory files. Defaults to project+global (`all`) in project context, global-only otherwise. Use `scope: 'project'` or `scope: 'global'` to restrict range. Use `period` to filter by month.",
          "- `list`: List memory files grouped by month. Use `period` filter for detailed view.",
          "",
          "**Targets:**",
          "- `daily` (DEFAULT): daily/YYYY-MM-DD.md - Task logs and day-to-day activities",
          "- `memory`: MEMORY.md - Long-term memory (decisions, architecture, patterns, preferences) - **preferred for any knowledge worth reusing**",
          "- `identity`: IDENTITY.md - AI identity (name, persona, behavioral rules)",
          "- `user`: USER.md - User profile (name, preferences, context)",
          "",
          "**Important:**",
          "- **DEFAULT to daily logs** for task summaries. Write to memory for reusable knowledge (architecture, conventions, preferences).",
          "- For `delete` action: Use exact timestamp shown in results",
          "- For `search` action: Use `period` filter (YYYY-MM or YYYY) to narrow results",
          "- For `list` action: Shows grouped summary by default, use `period` for details",
        ].join("\n"),
        args: {
          action: tool.schema
            .enum([
              "read",
              "write",
              "edit",
              "delete",
              "search",
              "list",
              "extract",
            ])
            .describe("Action to perform"),
          target: tool.schema
            .enum(["memory", "identity", "user", "daily"])
            .optional()
            .describe(
              "Target file: memory, identity, user, or daily (backward compatible)",
            ),
          category: tool.schema
            .enum(["instruction", "learning", "daily"])
            .optional()
            .describe(
              "Memory category: instruction (rules/workflows), learning (knowledge/preferences), daily (logs)",
            ),
          sub_type: tool.schema
            .enum([
              "identity",
              "rule",
              "workflow",
              "preference",
              "episodic",
              "knowledge",
            ])
            .optional()
            .describe(
              "Sub-type for instruction (identity/rule/workflow) or learning (preference/episodic/knowledge)",
            ),
          title: tool.schema
            .string()
            .optional()
            .describe(
              "Title for instruction or learning (for structured memory)",
            ),
          path_pattern: tool.schema
            .string()
            .optional()
            .describe(
              "Glob pattern for path-scoped rule loading (e.g. 'src/api/**')",
            ),
          content: tool.schema
            .string()
            .optional()
            .describe("Content to write (for write action)"),
          mode: tool.schema
            .enum(["append", "overwrite"])
            .optional()
            .describe("Write mode (default: append)"),
          date: tool.schema
            .string()
            .optional()
            .describe(
              "Date (YYYY-MM-DD) or timestamp (YYYY-MM-DD HH:MM:SS) for daily target",
            ),
          query: tool.schema
            .string()
            .optional()
            .describe("Search query (for search action)"),
          max_results: tool.schema
            .number()
            .optional()
            .describe("Max search results (default: 20)"),
          oldString: tool.schema
            .string()
            .optional()
            .describe(
              "Text to replace (for edit action). Must read file first to get exact text.",
            ),
          newString: tool.schema
            .string()
            .optional()
            .describe("Replacement text (for edit action)"),
          timestamp: tool.schema
            .string()
            .optional()
            .describe(
              "Timestamp to delete (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS). For delete action only.",
            ),
          period: tool.schema
            .string()
            .optional()
            .describe(
              "Filter by period: YYYY-MM (month) or YYYY (year). For list and search actions.",
            ),
          scope: tool.schema
            .enum(["all", "global", "project"])
            .optional()
            .describe(
              "Scope for memory operations: 'global' (global only), 'project' (current project only), 'all' (search both, default for search). Write/read default to auto-detect current project, fallback to global.",
            ),
        },
        async execute(args) {
          await memoryManager.ensureDirectories();
          validateAction(args.action);
          // scope → project 解析：project 时自动 detectProject()，检测不到降级为全局
          const resolvedProject = resolveProjectId(args.scope, projectId);

          switch (args.action) {
            case "read":
              return handleRead(
                { ...args, project: resolvedProject ?? undefined },
                memoryManager,
              );
            case "write":
              return handleWrite(
                { ...args, project: resolvedProject ?? undefined },
                memoryManager,
              );
            case "edit":
              return handleEdit(
                { ...args, project: resolvedProject ?? undefined },
                memoryManager,
              );
            case "delete":
              return handleDelete(
                { ...args, project: resolvedProject ?? undefined },
                memoryManager,
              );
            case "search":
              // 搜索作用域与 resolveProjectId 保持一致：
              // 当 args.scope 未指定时，优先项目上下文；检测不到项目则只搜全局
              return handleSearch(
                {
                  ...args,
                  scope: args.scope ?? (resolvedProject ? "all" : "global"),
                },
                memoryManager,
                resolvedProject,
              );
            case "list":
              return handleList(args, memoryManager);
            default:
              return `Unknown action: ${args.action}`;
          }
        },
      }),
    },
  };
};

export default MemoryPlugin;
