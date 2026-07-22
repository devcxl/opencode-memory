---
name: "tsconfig 统一"
phase: 1
depends_on: ["T2", "T3", "T4", "T5"]
labels: ["config"]
worktree_root: ".worktree/t6-tsconfig-unify/"
test_commands:
  - "pnpm -r run typecheck"
verify_commands:
  - "pnpm -r run typecheck"
tdd:
  mode: strict
  min_cycles: 1
acceptance:
  - criteria: "根 tsconfig.json 存在，作为 base config"
    verification_type: manual
  - criteria: "worker/tsconfig.json extends 根配置，typecheck 通过"
    verification_type: test
    test_command: "pnpm --filter @cfmem/api typecheck"
  - criteria: "web/tsconfig.json extends 根配置，typecheck 通过"
    verification_type: test
    test_command: "pnpm --filter @cfmem/web typecheck"
  - criteria: "packages/shared/tsconfig.json extends 根配置，typecheck 通过"
    verification_type: test
    test_command: "pnpm --filter @cfmem/shared typecheck"
  - criteria: "插件根 tsconfig.json typecheck 通过"
    verification_type: test
    test_command: "pnpm exec tsc --noEmit"
  - criteria: "pnpm -r run typecheck 全仓库递归通过"
    verification_type: test
    test_command: "pnpm -r run typecheck"
---

# T6: tsconfig 统一

**阶段**：Phase 1 — 仓库合并
**依赖**：T2（worker）, T3（web）, T4（shared）, T5（scripts/docs）
**标签**：`config`
**预估**：1h

## 目标

统一所有子包的 TypeScript 配置，使 `pnpm -r run typecheck` 递归通过。

## 背景

两个项目的 tsconfig 可能存在差异（target、module、paths 等），需要创建统一的 base config 并调整各子包的 extends 路径。

## 实现步骤

### 1. 创建根 `tsconfig.base.json`（或增强现有 `tsconfig.json`）

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

### 2. 调整各子包的 tsconfig.json

#### `worker/tsconfig.json`
- `extends: "../tsconfig.base.json"`
- `compilerOptions.types: ["@cloudflare/workers-types"]`
- `compilerOptions.paths` 中 `@cfmem/shared` 指向 `../packages/shared/src`

#### `web/tsconfig.json`
- `extends: "../tsconfig.base.json"`
- `compilerOptions.jsx: "react-jsx"`

#### `packages/shared/tsconfig.json`
- `extends: "../../tsconfig.base.json"`

#### 插件根 `tsconfig.json`
- 保持现有结构（Bun 兼容），但确保不与 base 冲突
- 添加 `references` 或 `paths` 引用 `@cfmem/shared`（如果需要）

### 3. 修复类型错误

逐个修复 `pnpm -r run typecheck` 报告的错误：
- 路径引用错误
- 类型不兼容
- 缺失的类型声明

### 4. 验证

```bash
pnpm -r run typecheck
```

## 文件变更

| 操作 | 文件 |
|------|------|
| ✏️ 修改 | `tsconfig.json`（根，增强为 base config） |
| ✏️ 修改 | `worker/tsconfig.json` |
| ✏️ 修改 | `web/tsconfig.json` |
| ✏️ 修改 | `packages/shared/tsconfig.json` |

## 注意事项

- 插件使用 `tsc --noEmit` 做 typecheck，不使用 Bun 的类型检查
- Worker 项目需要 `@cloudflare/workers-types` 类型支持
- 如果插件和 Worker 的 target 不同，考虑按子包覆盖，不在 base 中强制统一
