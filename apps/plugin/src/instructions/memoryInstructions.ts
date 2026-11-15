import memoryAwarenessRaw from "./memory-awareness.md";
import bootstrapInstructionsRaw from "./bootstrap-instructions.md";
import bootstrapTemplateRaw from "./bootstrap-template.md";

/**
 * 内存感知指令（静态，不包含日期以避免 KV cache 失效）。
 * daily 日志不会被自动注入，需要时显式读取。
 */
export function getMemoryAwarenessInstructions(): string {
  return memoryAwarenessRaw;
}

/** 首次运行的引导指令 */
export const BOOTSTRAP_INSTRUCTIONS: string = bootstrapInstructionsRaw;

/**
 * /memory-init 命令的初始化提示。
 * 静态文本，不包含日期，避免每次注入产生不同的 prompt。
 */
export const MEMORY_INIT_PROMPT: string = [
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
].join("\n");

/** bootstrap 模板，包含动态路径和记忆指令注入 */
export function bootstrapTemplate(
  bootstrapPath: string,
  memoryAwareness: string,
): string {
  return bootstrapTemplateRaw
    .replace(/\{bootstrapPath\}/g, bootstrapPath)
    .replace(/\{memoryAwareness\}/, memoryAwareness);
}
