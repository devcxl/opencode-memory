# @devcxl/opencode-memory

[![npm version](https://img.shields.io/npm/v/@devcxl/opencode-memory)](https://www.npmjs.com/package/@devcxl/opencode-memory)
[![npm downloads](https://img.shields.io/npm/dm/@devcxl/opencode-memory)](https://www.npmjs.com/package/@devcxl/opencode-memory)
[![license](https://img.shields.io/npm/l/@devcxl/opencode-memory)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/devcxl/opencode-memory/ci.yml?branch=main)](https://github.com/devcxl/opencode-memory/actions)

[English](./README.md) | [中文](./README.zh.md)

Simple markdown-based memory plugin for OpenCode.

## Installation

Add to your OpenCode configuration at `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["@devcxl/opencode-memory"]
}
```

## Memory Files

| File | Purpose |
|------|---------|
| `MEMORY.md` | Long-term memory (crucial facts, decisions, preferences) |
| `IDENTITY.md` | AI identity (name, persona, behavioral rules) |
| `USER.md` | User profile (name, preferences, context) |
| `daily/YYYY-MM-DD.md` | Daily logs (day-to-day activities) |
| `BOOTSTRAP.md` | First run setup instructions (deleted after setup) |

## Storage Location

- **macOS/Linux**: `~/.config/opencode/memory/`
- **Windows**: `%APPDATA%/opencode/memory/`

## Tool: memory

**Actions:**

| Action | Description | Parameters |
|--------|-------------|------------|
| `read` | Read memory file | `target`: memory, identity, user, daily; `date`, `scope` (optional) |
| `write` | Write to memory file | `target`, `content`, `mode`: append/overwrite; `date`, `scope` (optional) |
| `edit` | Edit specific part of file | `target`, `oldString`, `newString`; `date`, `scope` (optional) |
| `delete` | Delete entry by timestamp | `target`, `timestamp`; `date`, `scope` (optional) |
| `search` | Semantic search memory files | `query`, `max_results`, `period`, `scope` (optional) |
| `list` | List memory files | `period` (optional) |

**Examples:**

Use `--scope project` for the current project memory. The project ID is auto-detected from git; if detection fails, memory falls back to global.

```bash
memory --action read --target memory
memory --action write --target memory --content "Remember to use PostgreSQL for all projects"
memory --action write --target daily --content "Fixed critical bug in auth module"
memory --action edit --target memory --oldString "Project: Auth Service" --newString "Project: Payment Service"
memory --action delete --target daily --timestamp "2026-06-06 15:40:23"
memory --action search --query "PostgreSQL"
memory --action search --query "bug" --period 2026-06 --scope project
memory --action list
memory --action list --period 2026-06
memory --action write --target memory --scope project --content "Use port 5432"
```

## First Run Flow

**Important:** First setup must be done in OpenCode **build mode** (not plan mode). AI cannot write files in plan mode.

1. Plugin detects no MEMORY.md exists
2. Creates BOOTSTRAP.md with setup instructions
3. AI reads BOOTSTRAP.md and asks user questions interactively
4. AI writes to MEMORY.md, IDENTITY.md, USER.md
5. AI deletes BOOTSTRAP.md
6. Setup complete

The setup can be triggered manually with `/memory-init` at any time (only available when the memory system is not yet fully initialized).

## Context Injection

MEMORY.md, IDENTITY.md, and USER.md are automatically injected into the system prompt at session start.

Daily logs must be accessed via the `memory` tool.

## License

MIT
