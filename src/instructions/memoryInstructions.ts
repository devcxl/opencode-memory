import memoryAwarenessRaw from "./memory-awareness.md";
import bootstrapInstructionsRaw from "./bootstrap-instructions.md";
import bootstrapTemplateRaw from "./bootstrap-template.md";

/**
 * 内存感知指令，从 memory-awareness.md 加载并替换动态占位符。
 * daily 日志不会被自动注入，需要时显式读取。
 */
export function getMemoryAwarenessInstructions(): string {
  const today = new Date().toISOString().slice(0, 10);
  return memoryAwarenessRaw.replace(/\{today\}/g, today);
}

/** 首次运行的引导指令 */
export const BOOTSTRAP_INSTRUCTIONS: string = bootstrapInstructionsRaw;

/** bootstrap 模板，包含动态路径和记忆指令注入 */
export function bootstrapTemplate(
  bootstrapPath: string,
  memoryAwareness: string,
): string {
  return bootstrapTemplateRaw
    .replace(/\{bootstrapPath\}/g, bootstrapPath)
    .replace(/\{memoryAwareness\}/, memoryAwareness);
}
