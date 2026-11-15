import type { Plugin } from "@opencode/plugin";
import type { MemoryManager } from "../memory/MemoryManager.js";
import type { BootstrapManager } from "../memory/BootstrapManager.js";
import { MEMORY_INIT_PROMPT } from "../instructions/memoryInstructions.js";

type PluginContext = Plugin.Context;

export interface MemoryInitCommandDependencies {
  memoryManager: MemoryManager;
  bootstrapManager: BootstrapManager;
}

/**
 * 注册 `/memory-init` 命令。
 *
 * V2 没有 V1 的 `config` hook 和 `command.execute.before`；
 * 命令通过 `ctx.command.transform` 注册，模板创建与引导 prompt
 * 都放在命令的 `execute` 里。
 */
export async function registerMemoryInitCommand(
  ctx: PluginContext,
  deps: MemoryInitCommandDependencies,
): Promise<void> {
  await ctx.command.transform((editor) => {
    editor.add({
      name: "memory-init",
      description: "Initialize OpenCode memory system (first-time setup)",
      async execute({ sessionID, prompt, delivery }) {
        // 已初始化：命令保持注册但不再执行引导
        if (deps.memoryManager.getInitState() === "ready") return;

        await deps.bootstrapManager.createInitTemplates();

        const extra = prompt.text.trim();
        const text = extra
          ? `${MEMORY_INIT_PROMPT}\n\nAdditional user input:\n${extra}`
          : MEMORY_INIT_PROMPT;

        await ctx.session.prompt({ sessionID, text, delivery });
      },
    });
  });
}
