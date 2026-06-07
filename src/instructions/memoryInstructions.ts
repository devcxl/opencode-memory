import * as fs from "node:fs";
import * as path from "node:path";

const readInstruction = (filename: string): string =>
  fs.readFileSync(path.join(__dirname, filename), "utf-8");

/**
 * 内存感知指令，从 memory-awareness.md 加载并替换动态占位符。
 * daily 日志不会被自动注入，需要时显式读取。
 */
export function getMemoryAwarenessInstructions(): string {
  const today = new Date().toISOString().slice(0, 10);
  return readInstruction("memory-awareness.md").replace(/\{today\}/g, today);
}

/** 首次运行的引导指令 */
export const BOOTSTRAP_INSTRUCTIONS: string = readInstruction(
  "bootstrap-instructions.md",
);

/** bootstrap 模板，包含动态路径和记忆指令注入 */
export function bootstrapTemplate(
  bootstrapPath: string,
  memoryAwareness: string,
): string {
  return readInstruction("bootstrap-template.md")
    .replace(/\{bootstrapPath\}/g, bootstrapPath)
    .replace(/\{memoryAwareness\}/, memoryAwareness);
}
