<div align="center">

# @devcxl/opencode-memory

[![npm version](https://img.shields.io/npm/v/@devcxl/opencode-memory)](https://www.npmjs.com/package/@devcxl/opencode-memory)
[![npm downloads](https://img.shields.io/npm/dm/@devcxl/opencode-memory)](https://www.npmjs.com/package/@devcxl/opencode-memory)
[![license](https://img.shields.io/npm/l/@devcxl/opencode-memory)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/devcxl/opencode-memory/ci.yml?branch=main)](https://github.com/devcxl/opencode-memory/actions)

[English](./README.md) | [中文](./README.zh.md)

Local-only, markdown-based memory plugin for OpenCode.

</div>

## Which version do I need?

This package ships two incompatible plugin lines. Pick by **OpenCode** version, not by
"newest is best":

| Your OpenCode | Install                                                   | Config key | Package version                              |
| ------------- | --------------------------------------------------------- | ---------- | -------------------------------------------- |
| V1            | `plugin: ["@devcxl/opencode-memory"]` or pin `@1.2.1`     | `plugin`   | `latest` → `1.2.1` (V1 maintenance line)     |
| V2 (≥ 2.3.x)  | `plugins: ["@devcxl/opencode-memory@v2"]` or pin `@2.0.0` | `plugins`  | `v2` → `2.0.x`, `rc` → current V2 prerelease |

`latest` stays on the V1 line on purpose: V1 users are auto-updated from `latest`, and a
V2-only package would not load in V1. OpenCode V2 users must use `@v2` or an exact `2.x`
version.

- Requires **OpenCode 2.3.x** (runtime dependency `@opencode/plugin@^2.3.0`).
- **Linux is verified; macOS and Windows are unverified.**
- **Local mode only.** There is no remote provider, Worker, web console or shared package
  in this repository.
- Migrating from V1, downgrading, or troubleshooting: see [docs/migration-v2.md](./docs/migration-v2.md).

### Remote memory

The remote memory service (Cloudflare Worker + web console) and its client now live in
[`@devcxl/cabbage-memory`](https://github.com/devcxl/cabbage-memory). A config that still
sets `mode: "remote"` (or passes a `remote` block) fails with a migration error instead of
silently falling back to local files.

## Installation

Add to your OpenCode V2 configuration at `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@devcxl/opencode-memory@v2"],
}
```

Pin an exact version when you want reproducible installs:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@devcxl/opencode-memory@2.0.0"],
}
```

On OpenCode V1 the key is `plugin`, and the V1 line is what you want:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@devcxl/opencode-memory"],
}
```

Notes:

- V2 reads `plugins` (plural). A leftover `plugin` key is ignored by V2, so the plugin
  never loads and nothing tells you why.
- `@v2` is a dist-tag, not an exact version: OpenCode checks unpinned npm plugins for
  updates. Pin `@2.0.0` for repeatable installs.
- `opencode plugin list` shows the installed version; `opencode plugin check` looks for
  update candidates (`opencode plugin add @devcxl/opencode-memory@v2` also works).
- Local plugin paths in V2 must point at a directory.
- Keep `optionalDependencies` (`vectra`, `@huggingface/transformers`) installed. Semantic
  `search` needs them; `--omit=optional` breaks it.

### Embedding options (optional)

The only plugin options left are local embedding settings. Do not pass `mode` or `remote`;
`mode: "remote"` is a migration error.

In the object form the `package` field is also a package spec: keep `@v2` (or an exact
version) in it. Omitting the version resolves to `latest`, which is the V1 line.

```jsonc
{
  "plugins": [
    {
      "package": "@devcxl/opencode-memory@v2",
      "options": {
        "embeddingModel": "jina-embeddings-v2-base-zh", // or nomic-embed-text-v1.5
        "dtype": "fp32", // fp32 | fp16 | q8 | q4 | int8 | uint8
      },
    },
  ],
}
```

Defaults: `nomic-embed-text-v1.5`, `fp32`, except that a Chinese system locale selects
`jina-embeddings-v2-base-zh`. Environment overrides: `OPM_EMBEDDING_MODEL`,
`OPM_EMBEDDING_DTYPE`, `OPM_DEBUG=1` for debug logs.

## Memory Files

| File                     | Purpose                                                  |
| ------------------------ | -------------------------------------------------------- |
| `MEMORY.md`              | Long-term memory (crucial facts, decisions, preferences) |
| `IDENTITY.md`            | AI identity (name, persona, behavioral rules)            |
| `USER.md`                | User profile (name, preferences, context)                |
| `daily/YYYY-MM-DD.md`    | Daily logs (day-to-day activities)                       |
| `projects/<project-id>/` | Per-project memory and daily logs                        |
| `BOOTSTRAP.md`           | First run setup instructions (deleted after setup)       |

## Storage Location

- **Linux**: `~/.config/opencode/memory/`
- **macOS**: `~/.config/opencode/memory/` (unverified)
- **Windows**: `%APPDATA%\opencode\memory\` (unverified)

## Tool: memory

**Actions:**

| Action   | Description                  | Parameters                                                                |
| -------- | ---------------------------- | ------------------------------------------------------------------------- |
| `read`   | Read memory file             | `target`: memory, identity, user, daily; `date`, `scope` (optional)       |
| `write`  | Write to memory file         | `target`, `content`, `mode`: append/overwrite; `date`, `scope` (optional) |
| `edit`   | Edit specific part of file   | `target`, `oldString`, `newString`; `date`, `scope` (optional)            |
| `delete` | Delete entry by timestamp    | `target`, `timestamp`; `date`, `scope` (optional)                         |
| `search` | Semantic search memory files | `query`, `max_results`, `period`, `scope` (optional)                      |
| `list`   | List memory files            | `period` (optional)                                                       |

**Examples:**

Use `--scope project` for the current project memory. The project ID is derived from the
session's location via git; if detection fails, memory falls back to global.

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

`/memory-init` stays registered in OpenCode V2 and is always safe to run: once memory is
fully initialized it returns immediately without creating or overwriting templates.

## Context Injection

MEMORY.md, IDENTITY.md, and USER.md are injected into the system prompt **before each model
request**, rebuilt from disk every time (there is no context cache yet). Daily logs must be
accessed via the `memory` tool.

When a session performs `memory` operations without writing the daily log, the next model
request carries a `Memory Reminder` system section instead of the V1 TUI toast.

## Repository Structure

This repository is a pnpm monorepo with a single package: the npm-published plugin.

```
opencode-memory/
├── apps/
│   └── plugin/         # @devcxl/opencode-memory  (this README)
├── docs/
│   ├── migration-v2.md # V1 → V2 upgrade, downgrade, troubleshooting
│   ├── adr/            # Architecture decision records
│   └── dev/            # Architecture flow, release notes, rollback runbook, RC checklist
└── package.json        # workspace root (private)
```

## Documentation

- [Migration guide: V1 → V2](./docs/migration-v2.md) · [迁移指南](./docs/migration-v2.md)
- [Architecture flow (local-only)](./docs/dev/architecture-flow.md)
- [RC acceptance checklist (release gate)](./docs/dev/release-checklist.md)
- [ADR: OpenCode V2-only 2.0.0](./docs/adr/2026-11-15-opencode-v2-only.md)

## License

MIT
