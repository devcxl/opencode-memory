import * as path from "node:path";
import * as fs from "node:fs";
import type { Plugin } from "@opencode/plugin";
import { DEFAULT_MEMORY_LIMITS, type MemoryLimits } from "../config/runtime.js";
import type { MemoryManager } from "../memory/MemoryManager.js";
import type { SessionContextCache } from "../session/SessionContextCache.js";
import type { SessionProjectResolver } from "../session/SessionProjectResolver.js";
import { readFileSafe } from "../utils/fs.js";
import { stripExternalOriginEntries } from "../utils/timestampParser.js";

type PluginContext = Plugin.Context;

const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_LOOKBACK_DAYS = 90;

export interface MemoryConsolidateCommandDependencies {
  memoryManager: MemoryManager;
  projects: SessionProjectResolver;
  contextCache: SessionContextCache;
  limits?: MemoryLimits;
}

/** 解析 `/memory-consolidate [global] [days]` 参数 */
export function parseConsolidateArgs(rawText: string): {
  days: number;
  forceGlobal: boolean;
} {
  const tokens = rawText.trim().split(/\s+/).filter(Boolean);
  let days = DEFAULT_LOOKBACK_DAYS;
  let forceGlobal = false;

  for (const tok of tokens) {
    if (tok.toLowerCase() === "global") {
      forceGlobal = true;
      continue;
    }
    if (/^\d+$/.test(tok)) {
      const parsed = Number.parseInt(tok, 10);
      if (parsed > 0) {
        days = Math.min(parsed, MAX_LOOKBACK_DAYS);
      }
    }
  }

  return { days, forceGlobal };
}

function getCutoffDateStr(days: number, nowMs: number = Date.now()): string {
  const cutoff = new Date(nowMs - (days - 1) * 86_400_000);
  return cutoff.toISOString().slice(0, 10);
}

function collectRecentDailyLogs(
  dailyDir: string,
  cutoffDate: string,
): Array<{ file: string; content: string }> {
  let entries: string[];
  try {
    entries = fs
      .readdirSync(dailyDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse();
  } catch {
    return [];
  }

  const collected: Array<{ file: string; content: string }> = [];
  for (const file of entries) {
    const datePart = file.replace(/\.md$/, "");
    if (datePart < cutoffDate) continue;

    const raw = readFileSafe(path.join(dailyDir, file));
    if (!raw?.trim()) continue;

    // 过滤 external 来源条目，防止未经确认自动晋升为常驻核心记忆
    const sanitized = stripExternalOriginEntries(raw);
    if (sanitized) {
      collected.push({ file, content: sanitized });
    }
  }

  return collected;
}

/**
 * 注册 `/memory-consolidate` 按需记忆蒸馏命令。
 */
export async function registerMemoryConsolidateCommand(
  ctx: PluginContext,
  deps: MemoryConsolidateCommandDependencies,
): Promise<void> {
  const {
    memoryManager,
    projects,
    contextCache,
    limits = DEFAULT_MEMORY_LIMITS,
  } = deps;

  await ctx.command.transform((editor) => {
    editor.add({
      name: "memory-consolidate",
      description:
        "Consolidate recent daily logs into MEMORY.md within character budget",
      async execute({ sessionID, prompt, delivery }) {
        const { days, forceGlobal } = parseConsolidateArgs(prompt.text);
        const detectedProject = forceGlobal
          ? null
          : await projects.resolve(sessionID);
        const scopeLabel = detectedProject
          ? `project/${detectedProject}`
          : "global";
        const scopeArg = detectedProject ? "project" : "global";

        const dailyDir = detectedProject
          ? path.join(memoryManager.getProjectDir(detectedProject), "daily")
          : path.dirname(memoryManager.getDailyPath(memoryManager.todayStr()));

        const cutoffDate = getCutoffDateStr(days);
        const dailyLogs = collectRecentDailyLogs(dailyDir, cutoffDate);

        if (dailyLogs.length === 0) {
          await ctx.session.prompt({
            sessionID,
            text: `No non-external daily logs found in the last ${days} days for [${scopeLabel}] (since ${cutoffDate}). Nothing to consolidate.`,
            delivery,
          });
          return;
        }

        const { filePath: memoryPath, displayName } =
          memoryManager.getPathForTarget("memory", undefined, detectedProject);
        const currentMemory = (await memoryManager.readFile(memoryPath)) ?? "";
        const budgetLimit = detectedProject
          ? limits.projectMemory
          : limits.memory;
        const pct = Math.round((currentMemory.length / budgetLimit) * 100);

        const logsBlock = dailyLogs
          .map((log) => `### ${log.file}\n${log.content}`)
          .join("\n\n");

        const consolidationPrompt = [
          `Consolidate recent daily engineering logs (last ${days} days, since ${cutoffDate}) into curated long-term memory for \`${scopeLabel}\`.`,
          "",
          `Target file: \`${displayName}\``,
          `Current budget usage: ${currentMemory.length}/${budgetLimit} chars (${pct}%)`,
          "",
          "Current curated MEMORY.md:",
          "```markdown",
          currentMemory.trim() || "(empty)",
          "```",
          "",
          "Recent daily logs (external-origin entries excluded):",
          logsBlock,
          "",
          "**Instructions:**",
          `1. Identify durable knowledge from the daily logs (architecture decisions, conventions, recurring pitfalls, stable preferences) not yet captured in \`${displayName}\`.`,
          "2. Merge duplicates and retire outdated/superseded entries rather than appending blindly.",
          `3. Use the \`memory\` tool (\`action="write"\`, \`target="memory"\`, \`scope="${scopeArg}"\`, optionally \`replace_timestamps=[...]\`, or \`edit\`/\`delete\`) to update \`${displayName}\` strictly within the ${budgetLimit}-char budget.`,
          "4. If nothing new is worth promoting, explain briefly and leave MEMORY.md unchanged.",
        ].join("\n");

        await ctx.session.prompt({
          sessionID,
          text: consolidationPrompt,
          delivery,
        });
        contextCache.invalidate(sessionID);
      },
    });
  });
}
