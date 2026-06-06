import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { loadConfig } from "./config/runtime.js";
import { MemoryManager } from "./memory/MemoryManager.js";
import { BootstrapManager } from "./memory/BootstrapManager.js";
import { detectProject } from "./utils/projectDetector.js";
import {
  MEMORY_AWARENESS_INSTRUCTIONS,
  BOOTSTRAP_INSTRUCTIONS,
} from "./instructions/memoryInstructions.js";
import { validateAction } from "./utils/validation.js";
import { handleRead } from "./handlers/handleRead.js";
import { handleWrite } from "./handlers/handleWrite.js";
import { handleEdit } from "./handlers/handleEdit.js";
import { handleDelete } from "./handlers/handleDelete.js";
import { handleSearch } from "./handlers/handleSearch.js";
import { handleList } from "./handlers/handleList.js";
import { applyDefaultProject } from "./utils/defaultProject.js";

/** 追踪当前会话中的 memory 工具调用记录，用于在 session 超时时提示更新 daily log。 */
interface SessionState {
  memoryOperations: Array<{
    action: string;
    target: string;
    timestamp: string;
  }>;
  lastDailyUpdate: string | null;
}

interface MemoryCallArgs {
  action?: string;
  target?: string;
}

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
  const memoryManager = new MemoryManager(config);
  const bootstrapManager = new BootstrapManager(memoryManager);
  const projectId = detectProject();

  // 首次运行且存在 BOOTSTRAP.md 时优先展示引导内容，
  // 避免同时展示引导和常规记忆导致信息过载。
  const buildContext = (pId?: string | null): string => {
    const sections: string[] = [];
    if (bootstrapManager.isBootstrapNeeded()) {
      const bootstrapContent = memoryManager.readFile(
        memoryManager.getBootstrapPath(),
      );
      if (bootstrapContent?.trim()) {
        sections.push(
          `## BOOTSTRAP.md (First Run Setup)\n\n${bootstrapContent.trim()}`,
        );
      }
    } else {
      const contextFiles = memoryManager.getContextFiles(pId);
      for (const file of contextFiles) {
        sections.push(`## ${file.name}\n\n${file.content}`);
      }
    }
    if (sections.length === 0) return "";
    return `# Memory Context\n\n${sections.join("\n\n---\n\n")}`;
  };

  // 引导阶段需要交互式问答流程，常规阶段只需要自我检查 trigger。
  const getMemoryInstructions = (): string => {
    if (bootstrapManager.isBootstrapNeeded()) {
      return BOOTSTRAP_INSTRUCTIONS;
    }
    return MEMORY_AWARENESS_INSTRUCTIONS;
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
      bootstrapManager.createInitTemplates();
    },

    event: async ({ event }) => {
      const sessionID =
        event.type === "session.idle"
          ? event.properties.sessionID
          : event.type === "session.created" || event.type === "session.deleted"
            ? event.properties.info.id
            : undefined;

      if (event.type === "session.created" && sessionID) {
        sessionStates.set(sessionID, {
          memoryOperations: [],
          lastDailyUpdate: null,
        });
      }

      if (event.type === "session.deleted" && sessionID) {
        sessionStates.delete(sessionID);
      }

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
          state.memoryOperations.push({
            action: args.action ?? "unknown",
            target: args.target ?? "unknown",
            timestamp: new Date().toISOString(),
          });

          if (args.target === "daily") {
            state.lastDailyUpdate = new Date().toISOString();
          }
        }
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      const memoryContext = buildContext(projectId);
      if (!memoryContext) return;
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
          "- `write`: Write to a memory file. **DEFAULT to daily** for task summaries. Use memory target ONLY for crucial long-term knowledge.",
          "- `edit`: Edit a specific part of memory/identity/user/daily file. AI must read file first to get exact oldString.",
          "- `delete`: Delete entries from a memory file by exact timestamp (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)",
          "- `search`: Semantic search across all memory files. Use `period` filter to narrow results.",
          "- `list`: List memory files grouped by month. Use `period` filter for detailed view.",
          "",
          "**Targets:**",
          "- `daily` (DEFAULT): daily/YYYY-MM-DD.md - Task logs and day-to-day activities",
          "- `memory`: MEMORY.md - Long-term memory (crucial decisions, architecture, patterns) - **explicit only**",
          "- `identity`: IDENTITY.md - AI identity (name, persona, behavioral rules)",
          "- `user`: USER.md - User profile (name, preferences, context)",
          "",
          "**Important:**",
          "- **DEFAULT to daily logs** for task summaries unless user explicitly requests memory.md",
          "- For `delete` action: Use exact timestamp shown in results",
          "- For `search` action: Use `period` filter (YYYY-MM or YYYY) to narrow results",
          "- For `list` action: Shows grouped summary by default, use `period` for details",
        ].join("\n"),
        args: {
          action: tool.schema
            .enum(["read", "write", "edit", "delete", "search", "list"])
            .describe("Action to perform"),
          target: tool.schema
            .enum(["memory", "identity", "user", "daily"])
            .optional()
            .describe("Target file: memory, identity, user, or daily"),
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
            .describe("Search scope: all (default), global, or project only"),
          project: tool.schema
            .string()
            .optional()
            .describe(
              "Target project ID for read/write. Auto-detected if omitted.",
            ),
        },
        async execute(args) {
          memoryManager.ensureDirectories();
          validateAction(args.action);
          const projectArgs = applyDefaultProject(args, projectId);

          switch (args.action) {
            case "read":
              return handleRead(projectArgs, memoryManager);
            case "write":
              return handleWrite(projectArgs, memoryManager);
            case "edit":
              return handleEdit(projectArgs, memoryManager);
            case "delete":
              return handleDelete(projectArgs, memoryManager);
            case "search":
              return handleSearch(args, memoryManager, projectId);
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
