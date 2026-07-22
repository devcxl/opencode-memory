---
name: "文档更新"
phase: 4
depends_on: ["T15"]
labels: ["config"]
worktree_root: ".worktree/t17-docs-update/"
test_commands: []
verify_commands:
  - "ls README.md"
  - "cat README.md | head -50"
tdd:
  mode: advisory
  min_cycles: 1
acceptance:
  - criteria: "根 README.md 新增双模式说明和使用指南"
    verification_type: manual
  - criteria: "README 包含 local/remote 配置示例和部署指南"
    verification_type: manual
  - criteria: "worker/wrangler.toml 的注释完善"
    verification_type: manual
  - criteria: "部署指南可复现（新用户按文档操作可成功部署 Worker）"
    verification_type: manual
---

# T17: 文档更新

**阶段**：Phase 4 — 清理
**依赖**：T15（端到端集成测试通过）
**标签**：`config`
**预估**：1h

## 目标

更新仓库文档，说明双模式架构的使用方法、配置方式和部署流程。

## 背景

合并后仓库的 README 需要整合两个项目的信息，同时为远程模式用户提供清晰的部署指南。文档更新分为根 README 和 Worker 配置两部分。

## 实现步骤

### 1. 更新根 `README.md`

需要新增/修改以下章节：

#### 双模式说明
```markdown
## 运行模式

opencode-memory 支持两种运行模式：

### 本地模式（默认）
所有数据存储在本地 `~/.config/opencode/memory/`，零网络依赖，完全隐私。

### 远程模式
数据存储在 Cloudflare Workers 后端，支持跨机器共享记忆。

**配置示例** (`~/.config/opencode/opencode.json`)：
\```jsonc
{
  "plugin": [
    ["@devcxl/opencode-memory", {
      "mode": "remote",
      "remote": {
        "apiUrl": "https://memory.example.workers.dev",
        "apiKey": "env://OPM_API_KEY"
      }
    }]
  ]
}
\```
```

#### 部署指南
```markdown
## 部署 Worker（远程模式必读）

### 前置条件
- Cloudflare 账号
- Node.js >= 20 + pnpm >= 9
- Wrangler CLI (`npm i -g wrangler`)

### 步骤
1. Clone 仓库 + 安装依赖
2. 创建 D1 数据库和 Vectorize 索引
3. 设置 JWT_SECRET（wrangler secret put JWT_SECRET）
4. 执行 migrations（wrangler d1 migrations apply memory-db）
5. 部署（wrangler deploy）
6. 生成 JWT token（node scripts/generate-jwt.js）

详细指南见 [docs/deployment.md](docs/deployment.md)
```

#### 架构图（可选）
使用项目记忆中的架构图或 Mermaid 图。

### 2. 创建 `docs/deployment.md`（可选）

如果 README 中的部署指南过长，提取到独立文档：

- D1 数据库创建命令
- Vectorize 索引创建命令
- JWT_SECRET 设置方法
- wrangler deploy 命令
- 验证部署成功的 curl 命令

### 3. 更新 `worker/wrangler.toml`

添加注释说明：

```toml
# === opencode-memory Worker 配置 ===
# 此 Worker 为 opencode-memory 插件的远程模式后端
#
# 部署前需要：
# 1. wrangler d1 create memory-db
# 2. wrangler vectorize create memory-index --dimensions=1024 --metric=cosine
# 3. wrangler secret put JWT_SECRET
# 4. wrangler d1 migrations apply memory-db
```

### 4. 清理残留引用

- 删除 cloudflare-memory 相关的路径引用（如果有 `/apps/api/` 等旧路径）
- 更新 `@cfmem/*` 的说明（这些是内部 workspace 包，不是对外发布的包）

## 文件变更

| 操作 | 文件 |
|------|------|
| ✏️ 修改 | `README.md`（根） |
| ✏️ 修改 | `worker/wrangler.toml`（注释） |
| 🆕 新增 | `docs/deployment.md`（可选） |

## 注意事项

- 文档用中文撰写（符合项目规范）
- 配置示例必须是可复制粘贴的合法 JSONC
- 部署步骤需要是可复现的（建议实际跑一遍验证）
- 不要在 README 中添加 emoji 花里胡哨的内容，保持技术文档风格
