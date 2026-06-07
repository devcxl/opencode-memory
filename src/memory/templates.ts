import { getMemoryAwarenessInstructions } from "../instructions/memoryInstructions.js";

export const BOOTSTRAP_TEMPLATE = (
  bootstrapPath: string,
) => `# BOOTSTRAP.md - First Time Setup

**IMPORTANT:** First setup must be done in OpenCode **build mode** (not plan mode). AI cannot write files in plan mode.

**Bootstrap file location:** \`${bootstrapPath}\`

This is your first run! Let's set up your memory system.

## Instructions

Ask the user the following questions and fill in the memory files:

### For IDENTITY.md
Ask the user:
1. What name should the AI call itself?
2. What's the AI's personality/vibe? (e.g., professional, casual, critical, helpful)
3. What languages should the AI use?
4. Any specific behavioral rules?

### For USER.md
Ask the user:
1. What's your name? (how should AI address you)
2. What's your role/profession?
3. What programming languages/frameworks do you work with?
4. Where are you located? (timezone relevant)
5. What's your communication style preference?
6. Any specific preferences or constraints?

### For MEMORY.md
Ask the user:
1. Any crucial technical knowledge to remember?
2. Any system configurations or paths to remember?
3. Any preferences about how code should be written?

## After Setup

Once you've collected all the information:
1. Write to IDENTITY.md, USER.md, and MEMORY.md using the memory tool
2. Delete this BOOTSTRAP.md file: \`rm ${bootstrapPath}\`
3. Confirm setup is complete to the user

Be conversational and natural. Don't overwhelm with all questions at once.

---
${getMemoryAwarenessInstructions().trim()}
`;

export const MEMORY_TEMPLATE = `# MEMORY.md - Long-Term Memory

This file stores crucial facts, decisions, and preferences that should persist across sessions.

## Technical Knowledge

(Add important technical solutions, patterns, or configurations here)

## Preferences

(Add coding preferences, tool preferences, etc.)

## Important Facts

(Add any facts that should be remembered)

---

## Memory Awareness Guidelines

### Memory Classification Decision Tree:
\`\`\`
Is this information about...
├─ THE USER (name, role, preference, habit, style)? → USER.md
├─ MY BEHAVIOR (persona, rules, how I should act)? → IDENTITY.md
├─ TECHNICAL KNOWLEDGE (stack, patterns, decisions)? → MEMORY.md
└─ TASK ACTIVITY (what was done today)? → daily/YYYY-MM-DD.md
\`\`\`

### Proactive Behavior Rules:
- NEVER ask permission to update memory - just do it
- NEVER put same information in multiple files (NO REDUNDANCY)
- ALWAYS include timestamp context when relevant
- ALWAYS use concise but specific descriptions
`;

export const IDENTITY_TEMPLATE = `# IDENTITY.md - Agent Identity

- **Name**: (AI's name)
- **Vibe**: (personality and style)
- **Languages**: (primary communication languages)
- **Behavioral Rules**: (specific behavioral constraints)
`;

export const USER_TEMPLATE = `# USER.md - User Profile

- **Name**: (user's name)
- **Role**: (profession/role)
- **Technical Stack**: (languages, frameworks, tools)
- **Location**: (timezone/location)
- **Communication Style**: (preferred interaction style)
`;

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
