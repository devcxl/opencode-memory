import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { loadConfig } from "./config.js";
import { MemoryManager } from "./MemoryManager.js";
import { BootstrapManager } from "./BootstrapManager.js";
import { detectProject } from "./projectDetector.js";
import {
  MEMORY_AWARENESS_INSTRUCTIONS,
  BOOTSTRAP_INSTRUCTIONS,
} from "./memoryInstructions.js";
import {
  validateAction,
  validateTarget,
  validateContent,
  validateTimestamp,
} from "./validation.js";

interface SessionState {
  memoryOperations: Array<{
    action: string;
    target: string;
    timestamp: string;
  }>;
  lastDailyUpdate: string | null;
}

const sessionStates = new Map<string, SessionState>();

export const MemoryPlugin: Plugin = async (ctx: PluginInput) => {
  const config = loadConfig();
  const memoryManager = new MemoryManager(config);
  const bootstrapManager = new BootstrapManager(memoryManager);
  const projectId = detectProject();

  bootstrapManager.initialize();

  memoryManager.ensureDirectories();

  (async () => {
    try {
      await memoryManager.embedAllExistingFiles();
    } catch (err) {}
  })();

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

  const getMemoryInstructions = (): string => {
    if (bootstrapManager.isBootstrapNeeded()) {
      return BOOTSTRAP_INSTRUCTIONS;
    }
    return MEMORY_AWARENESS_INSTRUCTIONS;
  };

  return {
    event: async ({ event }) => {
      const sessionID = (event as any).sessionID || (event as any).session_id;

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

        if (state) {
          state.memoryOperations.push({
            action: (input.args as any).action,
            target: (input.args as any).target,
            timestamp: new Date().toISOString(),
          });

          if ((input.args as any).target === "daily") {
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

          switch (args.action) {
            case "read":
              return handleRead(args, memoryManager);
            case "write":
              return handleWrite(args, memoryManager);
            case "edit":
              return handleEdit(args, memoryManager);
            case "delete":
              return handleDelete(args, memoryManager);
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

function handleRead(
  params: { target?: string; date?: string; project?: string },
  memoryManager: MemoryManager,
): string {
  const { target, date, project } = params;

  if (!target) {
    return handleList({}, memoryManager);
  }

  try {
    const { filePath, displayName } = memoryManager.getPathForTarget(
      target,
      date,
      project || undefined,
    );
    const content = memoryManager.readFile(filePath);
    if (!content) {
      return `${displayName} not found or empty.`;
    }
    return content;
  } catch (error) {
    return error instanceof Error ? error.message : `Unknown target: ${target}`;
  }
}

async function handleWrite(
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
      memoryManager.appendFile(filePath, content);
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

async function handleEdit(
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

async function handleDelete(
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
    return `${result}\n\nDeleted timestamp: ${timestamp}`;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : `Failed to delete from ${target}`;
  }
}

async function handleSearch(
  params: {
    query?: string;
    max_results?: number;
    period?: string;
    scope?: string;
  },
  memoryManager: MemoryManager,
  projectId: string | null,
): Promise<string> {
  const { query, max_results, period, scope } = params;

  if (!query) {
    return "Error: query is required for search action.";
  }

  const effectiveProjectId =
    scope === "project" ? projectId : scope === "global" ? null : projectId;

  try {
    const results = await memoryManager.semanticSearch(
      query,
      max_results ?? 20,
      period,
      scope === "project" ? projectId : effectiveProjectId,
    );

    if (scope === "project" && !projectId) {
      return "No current project detected. Use --scope all or --scope global instead.";
    }

    if (results.length === 0) {
      const periodMsg = period ? ` (filtered by period: ${period})` : "";
      return `No results for "${query}"${periodMsg}.`;
    }

    const output = results
      .map((r) => {
        const ts = r.timestamp ? `[${r.timestamp}]` : "[no timestamp]";
        const heading = r.heading ? ` (${r.heading})` : "";
        return `${ts} ${r.filePath}${heading}:${r.score.toFixed(4)}: ${r.text.slice(0, 200)}`;
      })
      .join("\n\n");

    const periodMsg = period ? ` (filtered by period: ${period})` : "";
    return `Found ${results.length} results${periodMsg}:\n\n${output}`;
  } catch (error) {
    throw error;
  }
}

function handleList(
  params: { period?: string },
  memoryManager: MemoryManager,
): string {
  const { period } = params;

  if (period) {
    const filesWithTimestamps = memoryManager.listFilesByPeriod(period);
    if (filesWithTimestamps.length === 0) {
      return `No daily logs found for period: ${period}`;
    }

    const content = filesWithTimestamps
      .map((f) => {
        const tsList =
          f.timestamps.length > 0
            ? f.timestamps.map((ts) => `    - ${ts}`).join("\n")
            : "    (no timestamps)";
        return `- ${f.name}:\n${tsList}`;
      })
      .join("\n");

    return `Daily logs for ${period} (${filesWithTimestamps.length} files):\n${content}`;
  }

  const grouped = memoryManager.listFilesGroupedByMonth();
  const parts: string[] = [];

  if (
    grouped.root.length > 0 &&
    grouped.root.some((f) => f.timestamps.length > 0)
  ) {
    const rootContent = grouped.root
      .filter((f) => f.timestamps.length > 0)
      .map((f) => {
        const count = f.timestamps.length;
        const recentTs = f.timestamps.slice(0, 3);
        const more = count > 3 ? `... and ${count - 3} more` : "";
        const tsList = recentTs.map((ts) => `    - ${ts}`).join("\n");
        return `- ${f.name} (${count} entries):\n${tsList}${more ? `\n    ${more}` : ""}`;
      })
      .join("\n");
    parts.push(`Root files:\n${rootContent}`);
  }

  if (grouped.monthly.length > 0) {
    const displayMonthly = grouped.monthly.slice(0, 6);
    const moreCount = grouped.monthly.length - 6;

    const monthlyContent = displayMonthly
      .map((m) => {
        const recentFiles = m.files.slice(0, 3);
        const moreFiles = m.files.length - 3;
        const filesList = recentFiles
          .map((f) => {
            const count = f.timestamps.length;
            return `    - ${f.name} (${count} entries)`;
          })
          .join("\n");
        const moreFilesText =
          moreFiles > 0 ? `\n    ... and ${moreFiles} more files` : "";
        return `- ${m.month} (${m.fileCount} files, ${m.entryCount} entries):\n${filesList}${moreFilesText}`;
      })
      .join("\n");

    const moreText = moreCount > 0 ? `\n... and ${moreCount} more months` : "";
    parts.push(`Daily logs by month:\n${monthlyContent}${moreText}`);
  }

  if (parts.length === 0) {
    return "No memory files found.";
  }

  parts.push(
    "\nUse memory_list({period: 'YYYY-MM'}) to see details for specific month.",
  );
  parts.push(
    "Use memory_list({period: 'YYYY'}) to see all daily logs for specific year.",
  );

  return parts.join("\n");
}

export default MemoryPlugin;
