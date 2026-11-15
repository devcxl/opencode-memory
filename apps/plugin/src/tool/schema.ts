import { z } from "zod";

/**
 * memory 工具参数定义。
 *
 * V2 工具直接把整个对象作为 `input`（Zod 4 满足 Standard Schema），
 * 不再需要 V1 的「字段 → schema」映射。
 */
export const MemoryToolInput = z.object({
  action: z
    .enum(["read", "write", "edit", "delete", "search", "list"])
    .describe("Action to perform"),
  target: z
    .enum(["memory", "identity", "user", "daily"])
    .optional()
    .describe(
      "Target file: memory, identity, user, or daily (backward compatible)",
    ),
  category: z
    .enum(["instruction", "learning", "daily"])
    .optional()
    .describe(
      "Memory category: instruction (rules/workflows), learning (knowledge/preferences), daily (logs)",
    ),
  sub_type: z
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
  title: z
    .string()
    .optional()
    .describe("Title for instruction or learning (for structured memory)"),
  path_pattern: z
    .string()
    .optional()
    .describe("Glob pattern for path-scoped rule loading (e.g. 'src/api/**')"),
  content: z
    .string()
    .optional()
    .describe("Content to write (for write action)"),
  mode: z
    .enum(["append", "overwrite"])
    .optional()
    .describe("Write mode (default: append)"),
  date: z
    .string()
    .optional()
    .describe(
      "Date (YYYY-MM-DD) or timestamp (YYYY-MM-DD HH:MM:SS) for daily target",
    ),
  query: z.string().optional().describe("Search query (for search action)"),
  max_results: z
    .number()
    .optional()
    .describe("Max search results (default: 20)"),
  oldString: z
    .string()
    .optional()
    .describe(
      "Text to replace (for edit action). Must read file first to get exact text.",
    ),
  newString: z
    .string()
    .optional()
    .describe("Replacement text (for edit action)"),
  timestamp: z
    .string()
    .optional()
    .describe(
      "Timestamp to delete (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS). For delete action only.",
    ),
  period: z
    .string()
    .optional()
    .describe(
      "Filter by period: YYYY-MM (month) or YYYY (year). For list and search actions.",
    ),
  scope: z
    .enum(["all", "global", "project"])
    .optional()
    .describe(
      "Scope for memory operations: 'global' (global only), 'project' (current project only), 'all' (search both, default for search). Write/read default to auto-detect current project, fallback to global.",
    ),
});

export type MemoryToolInput = z.infer<typeof MemoryToolInput>;

/** memory 工具描述，供模型选择动作与 target */
export const MEMORY_TOOL_DESCRIPTION: string = [
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
].join("\n");
