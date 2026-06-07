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

/** bootstrap 模板，包含动态路径和记忆指令注入 */
export function bootstrapTemplate(
  bootstrapPath: string,
  memoryAwareness: string,
): string {
  return bootstrapTemplateRaw
    .replace(/\{bootstrapPath\}/g, bootstrapPath)
    .replace(/\{memoryAwareness\}/, memoryAwareness);
}
