---
name: Issue Triage
description: 自动分析新提交的 Issue 内容，完成意图分类并打上标签（后端基于 Pi Agent，支持自定义插件扩展）
intent: Classify newly opened issues into bug, enhancement, documentation, or question and apply appropriate labels.
on:
  issues:
    types: [opened]
  workflow_dispatch:

permissions:
  contents: read
  issues: read

engine:
  id: pi
  model-provider: openai
  # 在此处配置 Pi 的自定义插件/扩展列表（编译时会自动生成 pi install 或对应扩展加载步骤）
  extensions:
    - apps/pi-extension/src/extension.ts
  # 也支持通过 args 传参扩展自定义插件：
  # args:
  #   - "-e"
  #   - ".github/pi-extensions/my-plugin.ts"

features:
  gh-aw-detection: false

tools:
  github:
    mode: gh-proxy
    toolsets: [issues]

safe-outputs:
  threat-detection:
    engine: false
  add-labels:
    allowed:
      - bug
      - enhancement
      - documentation
      - question
      - duplicate
      - invalid
      - help wanted
    max: 3
  add-comment:
    max: 1
---

# Issue Triage & Classification

## 目标与职责

对刚刚提交的 GitHub Issue 进行语义分析与意图识别，判定其类型并利用 safe-outputs 工具打上合适标签；若关键信息严重缺失，可做简要引导说明。

## 审查与分类准则

1. **类型分类**：
   - `bug`：反馈系统崩溃、测试未通过、API 异常报错、功能未按预期工作等缺陷。
   - `enhancement`：提出新功能需求、新 API 扩展、架构优化、性能调优建议。
   - `documentation`：文档修正、使用说明补全、README 或类型定义说明相关。
   - `question`：配置咨询、架构咨询、排错求助等非代码缺陷问题。

2. **边界与信息完整性**：
   - 若 Issue 内容语义不明确、纯属无意义字符或垃圾信息，打上 `invalid` 标签。
   - 若 Issue 属于缺陷报告（bug），但未提供基本的复现步骤、日志或运行环境，使用 `add_comment` 工具礼貌提醒补充信息。

## 动作规范 (Safe Outputs)

- 使用 `add_labels` 工具为当前 Issue 添加最匹配的 1~2 个标签（只在允许的 labels 列表中选择）。
- 当且仅当需要向提问者提示补充必要信息时，才使用 `add_comment` 工具。
- 若该 Issue 已具备合规标签或无需任何标签变动，**必须**调用 `noop` 工具结束，附带简要说明：
  ```json
  {"message": "No labels needed: already classified or insufficient context."}
  ```
