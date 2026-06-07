import memoryTemplateRaw from "../instructions/memory-template.md";
import identityTemplateRaw from "../instructions/identity-template.md";
import userTemplateRaw from "../instructions/user-template.md";
import { bootstrapTemplate } from "../instructions/memoryInstructions.js";
import memoryAwarenessRaw from "../instructions/memory-awareness.md";

export const BOOTSTRAP_TEMPLATE = (bootstrapPath: string): string => {
  const memoryAwareness = memoryAwarenessRaw.replace(
    /\{today\}/g,
    new Date().toISOString().slice(0, 10),
  );
  return bootstrapTemplate(bootstrapPath, memoryAwareness);
};

export const MEMORY_TEMPLATE = memoryTemplateRaw;

export const IDENTITY_TEMPLATE = identityTemplateRaw;

export const USER_TEMPLATE = userTemplateRaw;

const MEMORY_TEMPLATE_LINES = nonEmptyLines(MEMORY_TEMPLATE);
const IDENTITY_TEMPLATE_LINES = nonEmptyLines(IDENTITY_TEMPLATE);
const USER_TEMPLATE_LINES = nonEmptyLines(USER_TEMPLATE);

const IDENTITY_FIELD_PREFIXES = [
  "- **Name**:",
  "- **Vibe**:",
  "- **Languages**:",
  "- **Behavioral Rules**:",
];

const USER_FIELD_PREFIXES = [
  "- **Name**:",
  "- **Role**:",
  "- **Technical Stack**:",
  "- **Location**:",
  "- **Communication Style**:",
];

/**
 * 判断文件内容是否只保留了初始化模板行（即用户尚未编辑）。
 *
 * 算法：
 * - MEMORY.md：逐行与模板对比，全部匹配模板行集合即为未编辑
 * - IDENTITY.md / USER.md：检查关键字段值是否为占位符
 *   如 "- **Name**: (your name)" 中的 "(your name)" 被视为占位符
 * - 第一行标题用于区分文件类型
 */
export function isInitTemplateContent(content: string): boolean {
  const lines = nonEmptyLines(content);
  if (lines.length === 0) return true;

  // 根据第一行标题判断文件类型
  if (lines[0] === IDENTITY_TEMPLATE_LINES[0]) {
    return !hasSubstantiveFieldValue(lines, IDENTITY_FIELD_PREFIXES);
  }

  if (lines[0] === USER_TEMPLATE_LINES[0]) {
    return !hasSubstantiveFieldValue(lines, USER_FIELD_PREFIXES);
  }

  if (lines[0] === MEMORY_TEMPLATE_LINES[0]) {
    return containsOnlyTemplateLines(lines, MEMORY_TEMPLATE_LINES);
  }

  return false;
}

/**
 * 检查 IDENTITY/USER 的字段值是否有实质内容。
 * 返回 false 表示所有字段值都是占位符（如 "(your name)"），用户未编辑。
 */
function hasSubstantiveFieldValue(
  lines: string[],
  fieldPrefixes: string[],
): boolean {
  for (const line of lines.slice(1)) {
    const fieldPrefix = fieldPrefixes.find((prefix) => line.startsWith(prefix));
    if (!fieldPrefix) return true; // 非模板行 → 用户已添加自定义内容

    const value = line.slice(fieldPrefix.length).trim();
    if (value && !isPlaceholder(value)) return true;
  }

  return false;
}

/** 判断值是否仍然为模板占位符格式 "(...)" */
function isPlaceholder(value: string): boolean {
  return /^\([^)]*\)$/.test(value);
}

/** MEMORY.md 判等：所有行都在模板行集合内 */
function containsOnlyTemplateLines(
  lines: string[],
  templateLines: string[],
): boolean {
  const templateLineSet = new Set(templateLines);
  return lines.every((line) => templateLineSet.has(line));
}

/** 按行分割并过滤空白行 */
function nonEmptyLines(content: string): string[] {
  return content
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
