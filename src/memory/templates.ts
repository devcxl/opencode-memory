import * as fs from "node:fs";
import * as path from "node:path";
import { bootstrapTemplate } from "../instructions/memoryInstructions.js";

const readTemplate = (filename: string): string =>
  fs.readFileSync(
    path.join(__dirname, "..", "instructions", filename),
    "utf-8",
  );

export const BOOTSTRAP_TEMPLATE = (bootstrapPath: string): string => {
  const memoryAwareness = readTemplate("memory-awareness.md").replace(
    /\{today\}/g,
    new Date().toISOString().slice(0, 10),
  );
  return bootstrapTemplate(bootstrapPath, memoryAwareness);
};

export const MEMORY_TEMPLATE = readTemplate("memory-template.md");

export const IDENTITY_TEMPLATE = readTemplate("identity-template.md");

export const USER_TEMPLATE = readTemplate("user-template.md");

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

/** 判断内容是否只保留了初始化模板行 */
export function isInitTemplateContent(content: string): boolean {
  const lines = nonEmptyLines(content);
  if (lines.length === 0) return true;

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

function hasSubstantiveFieldValue(
  lines: string[],
  fieldPrefixes: string[],
): boolean {
  for (const line of lines.slice(1)) {
    const fieldPrefix = fieldPrefixes.find((prefix) => line.startsWith(prefix));
    if (!fieldPrefix) return true;

    const value = line.slice(fieldPrefix.length).trim();
    if (value && !isPlaceholder(value)) return true;
  }

  return false;
}

function isPlaceholder(value: string): boolean {
  return /^\([^)]*\)$/.test(value);
}

function containsOnlyTemplateLines(
  lines: string[],
  templateLines: string[],
): boolean {
  const templateLineSet = new Set(templateLines);
  return lines.every((line) => templateLineSet.has(line));
}

function nonEmptyLines(content: string): string[] {
  return content
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
