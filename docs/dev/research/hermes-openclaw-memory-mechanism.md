# Hermes Agent 与 OpenClaw 记忆机制源码级调研

> 研究日期: 2026-11-21 | 状态: 完成 | 结论: 两者代表两种互斥范式——Hermes 是「小容量常驻 + 模型主动写入 + 按需检索」，OpenClaw 是「文件分层 + 框架自动 flush + 后台 dreaming 固化 + 规则闸门」
>
> 方法: 仅使用官方一手信源（GitHub 官方仓库源码、官方文档站源文件）。**文档与源码冲突时以源码为准，并在文中标注「源码已确认」或「文档与源码不一致」**。文中行号均指 2026-11-21 抓取的 `main` 分支快照。

---

## 研究结论摘要

**两者不是同一类系统的两种实现，而是对「记忆应该由谁负责」的两种相反回答。**

- **Hermes Agent**（`NousResearch/hermes-agent`，Python）把记忆压缩到极小：内置 `MEMORY.md`（默认 **2,200 字符**）与 `USER.md`（默认 **1,375 字符**）以 `\n§\n` 分隔条目，在**加载时冻结成一份 snapshot** 注入 system prompt 的 `volatile` 尾段；写入完全由模型通过 `memory` 工具主动发起（`add` / `patch` / `remove` 批量原子提交）；历史对话不进入这张表，而是落在 SQLite `messages_fts`（FTS5 + BM25）里，由 `session_search` 工具按需检索。外部记忆后端通过 `MemoryProvider` ABC 接入，**同一时刻只允许一个外部 provider**。
- **OpenClaw**（`openclaw/openclaw`，TypeScript）把记忆摊开成一套分层文件系统 + 单个 SQLite 索引，并围绕它建了一条**自动流水线**：日常追加到 `memory/YYYY-MM-DD.md` → 压缩前由框架强制发起一次 _memory flush_ 转写 → 会话结束转录进索引 → 夜间 _dreaming_（light → REM → deep）按加权信号与阈值闸门固化进 `MEMORY.md`。检索是 hybrid（BM25 + 向量）+ 时间衰减 + importance + MMR。安全边界由**写入时的 provenance 列**（`owner`/`agent`/`untrusted`/`system`）在结构上强制。

一句话对照：**Hermes 把「记什么」交给模型判断并施加硬预算；OpenClaw 把「记什么」交给规则闸门并让模型只在闸门内做语言判断。**

### 关键数字对照（全部源码/官方文档可查）

| 维度         | Hermes Agent                                                        | OpenClaw                                                                                     |
| ------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 常驻记忆容量 | `MEMORY.md` 2,200 chars、`USER.md` 1,375 chars                      | `bootstrapMaxChars` 默认 20,000 chars（含 `MEMORY.md`）；`USER.md` 另有固定 4,000 chars 上限 |
| 条目分隔     | `ENTRY_DELIMITER = "\n§\n"`                                         | Markdown 列表行 + 尾部 HTML 注释注解                                                         |
| 检索默认返回 | `session_search` 分页 + 每消息 2,000 chars 截断                     | `maxResults` 6、`minScore` 0.35                                                              |
| 混合权重     | 无 hybrid（`session_search` 走 FTS5/BM25）                          | `vectorWeight` 0.7 / `textWeight` 0.3，`candidateMultiplier` 4                               |
| 时间衰减     | 无                                                                  | 固定 30 天半衰期（`MEMORY.md`/`USER.md` 永不衰减）                                           |
| 多样性重排   | 无                                                                  | MMR，`lambda` 0.7                                                                            |
| 压缩前保护   | 仅外部 provider 的 `on_pre_compress` checkpoint（可选 fail-closed） | 框架强制 memory flush，`softThresholdTokens` 4,000                                           |
| 固化机制     | 无自动固化（模型主动写 / provider `on_session_end`）                | dreaming，深睡闸门 `minScore` 0.75、`minRecallCount` 3、`minUniqueQueries` 3                 |
| 自动注入范围 | 内置两层（memory + user），全量常驻                                 | 仅 curated tier（`MEMORY.md`/`USER.md`）；daily 与 transcript 永不自动注入                   |

---

## 0. 信源、方法与边界

### 0.1 一手信源

| 系统         | 仓库                                  | 主要查阅对象                                                                                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hermes Agent | `NousResearch/hermes-agent`（`main`） | `agent/memory_*.py`、`tools/memory_tool*.py`、`agent/system_prompt.py`、`agent/turn_context.py`、`tools/session_search_tool.py`、`persistence/sqlite/*`、`agent/agent_init*.py`、`plugin-catalog/honcho.yaml`、`website/docs/**`                                                                             |
| OpenClaw     | `openclaw/openclaw`（`main`）         | `src/agents/memory-search.ts`、`extensions/memory-core/src/**`、`extensions/active-memory/trigger-recall.ts`、`src/memory-host-sdk/dreaming.ts`、`src/state/openclaw-agent-storage-schema.ts`、`packages/memory-host-sdk/src/memory-entry-origins.ts`、`docs/concepts/**`、`docs/reference/memory-config.md` |

### 0.2 判定规则

1. 每个机制、字段、阈值、默认参数都给出**文件路径 + 符号名**（必要时附行号）。官方文档仅用于解释设计意图，数值一律回源核对。
2. 文档与源码不一致处显式标注。本次调研发现 **1 处**实质差异与 **1 处**用户预期与现实不符（见 §5）。
3. 无法从一手信源确认的内容统一列入 §5「未在源码中证实」，不作推测性补全。

### 0.3 本报告不覆盖

- 两者压缩算法内部的完整实现（Hermes `agent/context_compressor.py` 约 300 KB，未逐行审阅；OpenClaw 的 compaction 主体亦未逐行审阅）。
- 非记忆相关的 gateway / 多平台适配细节。

---

## 1. Hermes Agent 记忆机制

### 1.1 存储架构与分层

Hermes 的记忆分成**四个物理上完全不同的存储**，彼此不共享 schema：

| 层                       | 介质                | 路径 / 表                                            | 写入者                        | 是否常驻 prompt                       |
| ------------------------ | ------------------- | ---------------------------------------------------- | ----------------------------- | ------------------------------------- |
| 策展记忆（curated）      | Markdown            | `<HERMES_HOME>/memories/MEMORY.md`、`USER.md`        | 模型经 `memory` 工具          | 是，冻结快照进 system prompt          |
| 会话转录（episodic）     | SQLite              | `messages` + `messages_fts` + `messages_fts_trigram` | 运行时持久化                  | 否，`session_search` 按需             |
| 程序性记忆（procedural） | Markdown skill 文件 | skills 目录（`skill_manage` 管理）                   | 模型经 `skill_manage`         | 仅索引常驻，正文按需加载              |
| 外部后端（可选）         | provider 自定       | 由插件决定（Honcho / Byterover / RetainDB …）        | provider 自身 + 生命周期 hook | 仅 `system_prompt_block()` 的静态文本 |

**源码依据**

- 记忆目录：`tools/memory_tool.py` `get_memory_dir()` → `get_hermes_home() / "memories"`（L38-41）。文件按 target 映射：`USER.md` / `MEMORY.md`（`tools/memory_tool_store.py` `_path_for`，L304-306）。
- 条目分隔符与渲染头：`tools/memory_tool_store.py` L23-26
  ```python
  MEMORY_BLOCK_HEADERS = {"memory": "MEMORY (your personal notes)", "user": "USER PROFILE (who the user is)"}
  ENTRY_DELIMITER = "\n§\n"
  ```
- 容量上限是**字符数**而非 token：`MemoryStore.__init__(memory_char_limit: int = 2200, user_char_limit: int = 1375, ...)`（L188-193）；计数方式为 `len(ENTRY_DELIMITER.join(entries))`（`_char_count`，L314-315）。官方文档给出等价换算：2,200 chars ≈ 800 tokens，1,375 chars ≈ 500 tokens（`website/docs/user-guide/features/memory.md` L17-18、L182-183）。
- 上限可配置：`memory.memory_char_limit` / `memory.user_char_limit`（同文档 L290-291；代码读取点 `agent/agent_init.py` L1180-1183）。

**作用域与隔离**

Hermes 的作用域单位是 **profile（HERMES_HOME）**，不是「项目」：

- 所有路径经 `get_hermes_home()` 解析，provider 被要求「bind every store, path, client, bank or tenant from `initialize()`'s `hermes_home`」（`agent/memory_provider.py` L84-103 的 multiplexing contract）。
- 一个 gateway 进程可服务多个 profile，每个 agent 的 `MemoryManager` 持有自己的 provider 实例；`claim_instance()` 拒绝把已被别的 profile 绑定的实例再绑定（`agent/memory_manager.py` `initialize_all` L951-965；`agent/memory_caller_scope.py`）。
- **没有 workspace/project 维度的记忆分区**。`agent_workspace` 仅作为 `initialize()` 的 kwargs 传给 provider（`agent/memory_provider.py` L121-134），内置 store 不使用它。

**没有数据库、没有向量索引、没有 embedding**——这是 Hermes 内置路径的明确设计，语义检索能力被外置到 provider 或 `session_search` 的 FTS5。

### 1.2 注入：三层 prompt tier 与冻结快照

#### 1.2.1 system prompt 的三段式缓存布局

`agent/system_prompt.py` `build_system_prompt_parts()` 把 system prompt 拆成**有序的三段**（L769-830）：

| tier       | 内容                                                                                      | 变更频率         |
| ---------- | ----------------------------------------------------------------------------------------- | ---------------- |
| `stable`   | identity、guidance、coding brief、pinned skills                                           | 每会话常量       |
| `context`  | caller `system_message`、项目 context 文件、workspace snapshot                            | 跨会话可能变     |
| `volatile` | skills index、**memory**、**user profile**、外部记忆块、profile 行、时间戳、runtime hints | 最易变，故放最后 |

关键注释（L769-776）：

> `volatile` (skills index, memory, user profile, external memory block, timestamp line, runtime environment hints) … **Never re-rendered mid-session.**

记忆位于 `volatile` 段，由 `_memory_parts(agent)` 组装（L548-574）：先取内置 store 的 `format_for_system_prompt("memory" | "user")`，再追加外部 provider 的 `system_prompt_block()`（并用与工具注入相同的 gate `memory_provider_tools_exposed` 防止「广告了不存在的工具」）。

#### 1.2.2 冻结快照（prefix-cache 友好）

`MemoryStore` 维护 `_system_prompt_snapshot: dict[str, str]`，**只在 `load_from_disk()` 时生成一次**（`tools/memory_tool_store.py` L194、L223-258），读取接口明确写死语义（L655-658）：

```python
def format_for_system_prompt(self, target: str) -> Optional[str]:
    """Frozen load-time snapshot (NOT live state — mid-session writes don't touch
    it, preserving the prefix cache); None if empty."""
```

即：**会话中通过 `memory` 工具写入的内容，不会改变本会话已发出的 system prompt**——下一次会话（或压缩后重建）才生效。这是 Hermes 对 prompt cache 的核心取舍：牺牲「写完立刻可见」，换取前缀字节稳定。

重建时机只有一个：压缩之后。`invalidate_system_prompt(agent)`（`agent/system_prompt.py` L841-860）会清 `_cached_system_prompt`，并**重新从磁盘加载记忆**，同时清空 plugin section 的冻结快照（fail-open 保留上次字节作为兜底）。

渲染格式（`_render_block`，L675-680）：`═`×46 分隔线 + 标题 + `[usage% — used/limit chars]` + 条目正文。usage 指示器是刻意设计的：让模型看到容量压力（示例见 `website/docs/user-guide/features/memory.md` L42）。

#### 1.2.3 动态召回：注入到 user 消息，而非 system prompt

外部 provider 的 `prefetch()` 结果**不进 system prompt**，而是作为每轮 user 消息的附加块：

- `agent/turn_context.py` L1084-1096：每轮先 `on_turn_start`，再在 `not is_trivial_prompt(_query)` 时调用 `agent._memory_manager.prefetch_all(...)`；命中则通过 `describe_recall()` 发一条确定性状态行（`🧠 Provider — recalled N memories`，`agent/memory_manager.py` L427-438），防止模型静默丢弃注入内容。
- 组装：`compose_user_api_content()`（L127-140）把 `<memory-context>` 块**追加到 user content 尾部**；`compose_multimodal_context_part()`（L114-125）负责 fence。
- **cache 稳定性技巧**：注入结果写入 `api_content` sidecar，`substitute_api_content()`（L143-149）在发请求前替换回 `content`——注释原文「keeps the prompt-cache prefix byte-stable」。也就是说重放历史时不会因为「当时注入了什么」而改变字节，只有当前轮注入会体现。

fence 与清洗（`agent/memory_context.py`）：

- `build_memory_context_block()`（L170-186）输出：
  ```
  <memory-context>
  [System note: The following is recalled memory context, NOT new user input. ...]
  ...
  </memory-context>
  ```
- `StreamingContextScrubber`（L31-117）在流式输出中剥离该 fence（含跨 delta 的半截标签），`flush()` 对未闭合 span「宁可截断回答也不泄露记忆上下文」（L81-87）。
- `_drop_repeated_recall_lines()`（L124-167）在**同一 section 内**去掉逐字重复的 bullet，理由写在 docstring 里：composed block 会被写入 `api_content` 并在该 row 留在上下文期间**每轮重复计费**。

**注入节流**：`is_trivial_prompt()`（`agent/memory_provider.py` L66-81）用一条锚定正则 `TRIVIAL_PROMPT_RE` 过滤空输入、`/` 命令、以及 `yes|no|ok|thanks|hi|continue|lgtm...` 等无语义消息，避免为单词回复付一次召回往返。

### 1.3 读写与更新：`memory` 工具

#### 1.3.1 工具契约

`tools/memory_tool.py` L373-438 定义唯一工具 `memory`：

- `target`: `"memory" | "user"`
- `operations`: 数组，元素 `{action: "add" | "patch" | "remove", content?, old_text?}`
- **批量原子**：`"The batch applies atomically and the char limit is checked only on the FINAL result"`（L378-382）——因此「先删旧条目再加新条目」可以在一次调用里完成，即使单独 add 会溢出。
- 兼容性：handler 仍接受旧的顶层单 op 形状与 `new_text` 别名（L398-400 注释）。

#### 1.3.2 写入路径的六道闸门

`MemoryStore._mutate()`（`tools/memory_tool_store.py` L353-400）是唯一落盘入口，按顺序：

1. **hosted 能力检查**：`host_feature_enabled("builtin_memory")` 为假则整体禁用（L359-361）。
2. **独占文件锁**：`_file_lock()` 在**独立的 `.lock` 文件**上 `fcntl.flock(LOCK_EX)`（Windows 走 `msvcrt.locking`），`O_NOFOLLOW` + `fchmod(0600)` 收紧权限（L260-300）。用独立 lock 文件是为了让正文文件本身仍可被原子替换。
3. **重读磁盘**：在锁内重新 `_read_raw_checked()`，读取失败（存在但不可读）直接拒绝写入——避免「把读不到当成空文件然后覆盖」（`_read_failed_error`，L65-71）。
4. **drift 检测**：若某个条目长度超过**整个文件的字符上限**，判定为「有人用 shell/patch 塞了无分隔符的自由文本」，拒绝重写并先存 `.bak`（`_drift_error`，L51-62，注释指向 issue #26045）。只有纯删除操作可以继续。
5. **威胁扫描**：`_scan_memory_content()` → `_first_threat_message(content, scope="strict")`（L29-32），因为记忆会进 system prompt。
6. **预算检查**：`_over_limit()`（L129-130）给出「需要腾出 N 字符」的精确文案。

#### 1.3.3 匹配与编辑语义

- `_find_unique_match()`（L98-109）：**整条精确匹配优先**，其次子串匹配；多个不同条目命中则返回 ambiguous。
- 容错匹配 `_normalize_for_match()`（L76-95）：把弯引号/反引号折成 `'`、各种连字符折成 `-`、折叠空白、把字面 `\n` 当空格——理由是模型重述条目时排版会漂移。
- `patch` 只替换**唯一出现的 span**，出现多次则报错要求扩大上下文（`_patch_entry` L147-158、`_repeated_span_message` L137-139）。
- `remove` 删整条；`patch` 无操作（no-op）被显式拒绝（L155）。

#### 1.3.4 失败预算：防止模型在工具里死循环

`_MAX_CONSOLIDATION_FAILURES_PER_TURN = 3`（L186）。`_consolidation_failure()`（L206-220）在超过 3 次后返回**终态**结果：

> "Memory consolidation failed N times this turn. Stop retrying memory calls — leave memory unchanged for now and continue with your reply to the user."

设计意图（docstring）：「a failed memory side effect must never block the turn's reply」（issue #42405）。成功写入会重置该计数（`_success_response` L660-673）。

同时 `_success_response` **不回显条目列表**，注释解释：回显会诱导模型「再找点可修的」并重复同样的操作。

#### 1.3.5 并发模型

- 内置 store：进程内 `flock`（跨进程也有效，因为锁在文件系统上）。
- 外部 provider：`MemoryManager` 用**单 worker** `ThreadPoolExecutor` 串行化同一 provider 的写（`_submit_background`，`agent/memory_manager.py` L496-534），因此 `sync_turn` / `queue_prefetch` 不会并发打到同一个后端。
- 卡死保护：`_StuckCallGate`（L147-199）按 `(hermes_home, provider)` 维度限流——`_MAX_STUCK_CALLS=4` 后关闭闸门，每 `_PROBE_INTERVAL_S=60s` 放一个半开探测，`_MAX_INFLIGHT_CALLS=16` 为硬上限；`prefetch` 超时 `_EXTERNAL_PREFETCH_TIMEOUT_S=8.0`，后台调用 `_BACKGROUND_CALL_STALL_S=30.0`，shutdown 排空 `_SYNC_DRAIN_TIMEOUT_S=5.0`（L42-58）。

### 1.4 检索：`session_search`（FTS5 / BM25，无 LLM）

`tools/session_search_tool.py` 的模块 docstring 直接定义了四种形状（L1-11）：

> DISCOVERY（`query`；FTS5 deduped by lineage，自适应细节只水合 top-1）、SCROLL（`session_id` + `around_message_id`，±window）、READ（`session_id`，整段或 head/tail）、BROWSE（无参数）。**No LLM calls — every shape returns actual DB messages.**

关键算法与参数：

| 机制         | 实现                                                                                                                                    | 依据                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 全文索引     | SQLite FTS5，双表 `messages_fts`（词）与 `messages_fts_trigram`（trigram，用于 CJK/子串）                                               | `persistence/sqlite/_schema_ddl.py`；`FTS_STORAGE_VERSION = 3`（L84-90）                 |
| 排序         | SQLite `bm25()` 原生排序                                                                                                                | `persistence/sqlite/conversation/_store/search.py`（`SELECT bm25({table}) ... MATCH ?`） |
| 来源降权     | `_DEMOTED_SESSION_SOURCES = ("cron",)`，理由：cron 词汇量大，裸 BM25 下会把用户自己的会话挤出 top-N（"recall blindness"，issue #19434） | L29-38                                                                                   |
| 来源隐藏     | `_HIDDEN_SESSION_SOURCES = ("kanban", "subagent", "tool")`                                                                              | L25-26                                                                                   |
| 扫描上限     | `_DISCOVER_SCAN_LIMIT = 300` 行 FTS 结果，再按 lineage 去重                                                                             | L44-46                                                                                   |
| 单消息截断   | `_READ_MAX_CONTENT = 2000` chars，避免一条归档工具结果把上下文从 50K 抬到 89K tokens（issue #69334）                                    | L39-43                                                                                   |
| 排除表上限   | `_EXCLUDE_SESSION_IDS_CAP = 20`                                                                                                         | L47-48                                                                                   |
| 压缩摘要识别 | `_COMPACTION_PREFIXES = ("[CONTEXT COMPACTION", "[CONTEXT SUMMARY]:")`，bookends 会跳过                                                 | L52-53                                                                                   |

**注意**：Hermes 的 `session_search` 是**纯词法检索**，没有向量、没有 rerank、没有时间衰减。语义能力被明确外置：Honcho 的文档把「Search across history」列为 Honcho 相对内置的差异项（`website/docs/user-guide/features/honcho.md` 能力对照表）。

### 1.5 压缩、flush 与跨会话固化

这是 Hermes 与 OpenClaw 差异最大的部分，必须精确表述：

**（1）内置 store 没有「压缩前自动 flush」。**

在 `agent/conversation_compression.py` 中，`flush` 的全部出现都指**把待持久化消息写入 session DB**（如 L2086-2089 `_flush_messages_to_session_db`、L3195-3217 会话轮转时的 flush），不是「抽取记忆」。仓库内检索 `"memory flush"` 命中的是 gateway 缓存驱逐生命周期与 provider 侧 pending turn 提交（如 `hermes_cli/cli_shutdown.py` 提到 "Supermemory flushes pending turns"），均非策展记忆的自动沉淀。

**结论：Hermes 的 `MEMORY.md`/`USER.md` 只能由模型在对话中主动调用 `memory` 工具写入；框架不会在压缩前替你保存。**

**（2）外部 provider 有一条「压缩前 checkpoint」通道，可选 fail-closed。**

`agent/memory_provider.py` 定义两代契约（L35-37）：

```python
# v1 = best-effort on_pre_compress() with the raw message list;
# v2 = opt-in fail-closed checkpoint (normalized evidence handoff + strict-mode failure propagation).
PRE_COMPRESS_CHECKPOINT_API_VERSION = 2
```

`MemoryManager.on_pre_compress()`（`agent/memory_manager.py` L721-766）：

- v2 provider 收到 host 归一化后的 `evidence_messages`，v1 收到原始 `messages`；
- 当 `require_checkpoint=True` 时，**任一 v2 provider 抛异常会向上传播**，调用方据此保留未压缩转录；
- 若要求 checkpoint 却没有任何 v2 provider 成功，抛 `RuntimeError("No active memory provider completed pre-compress checkpoint API v2")`；
- 返回值会拼进压缩摘要 prompt（provider 可以借此把「即将被丢弃的关键信息」喂给摘要器）。

**（3）会话结束是外部 provider 的固化点**：`on_session_end(messages)` 的 docstring 明确「fires only at real session boundaries, never per-turn」（`agent/memory_provider.py` L197-198）。Honcho 的能力声明正是 `provides_hooks: [on_session_end]`（`plugin-catalog/honcho.yaml`）。

**（4）程序性知识的沉淀走 skills，不走 memory**。`memory` 工具描述里写死了分工（`tools/memory_tool.py` L384-396）：

> "Anything learned while doing a task (procedures, pitfalls, and the user's preferences and corrections for that kind of work) belongs in the task's skill via skill_manage, where it loads only when relevant; memory is injected into every turn and must stay small."

这条设计让 2,200 字符的硬预算在工程上成立——否则「操作步骤」会迅速吃满配额。

### 1.6 扩展机制：`MemoryProvider` ABC 与单 provider 约束

**接口**（`agent/memory_provider.py` L84-267）——生命周期为
`initialize → (system_prompt_block / prefetch / queue_prefetch / sync_turn) per turn → tool dispatch → shutdown`，另有可选 hook：

| 类别     | 方法                                                                                                                                                     | 时机                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 必选     | `name`、`is_available`、`initialize`、`get_tool_schemas`                                                                                                 | 启动                     |
| 注入     | `system_prompt_block()`（**STATIC**，明确写「Recalled context goes through prefetch(), not here」）、`prefetch()`、`queue_prefetch()`、`recall_status()` | 每轮                     |
| 持久化   | `sync_turn()`（non-blocking）、`on_session_end()`                                                                                                        | 每轮 / 会话边界          |
| 压缩     | `on_pre_compress()`（v1/v2）                                                                                                                             | 压缩前                   |
| 一致性   | `on_memory_write(action, target, content, metadata)`                                                                                                     | 内置工具写入后镜像       |
| 委派     | `on_delegation(task, result, child_session_id)`                                                                                                          | 子代理完成后（父侧观察） |
| 生命周期 | `on_session_switch`、`on_turn_start`、`on_profile_created/renamed`                                                                                       | 各类边界                 |

**单 provider 约束**（`agent/memory_manager.py` `add_provider` L285-300）：内置 `builtin` 永远接受，第二个外部 provider 会被**拒绝并 warn**，提示「Configure which one via `memory.provider` in config.yaml」。理由写在模块 docstring（L1-5）：「tool-schema bloat, conflicting backends」。

**发现与装载**（`agent/agent_init_memory_provider.py` L57-89）：`load_memory_provider(name)` → 若未安装且已在 catalog 中则 `recover_at_startup()` 拉取一次 → `is_available()` 为假则 warn 一次（每 home/provider/kind）并回退到仅内置。provider 可来自四个来源（bundled `plugins/memory/<name>/`、用户目录、Python entry point `hermes_agent.memory_providers`、catalog），见 `website/docs/developer-guide/memory-provider-plugin.md` L15-36。

**Honcho 是 catalog 插件，不是内置**：`plugin-catalog/honcho.yaml` 记录 `repo: https://github.com/plastic-labs/honcho`、`subdir: hermes-plugin-honcho`、`sha: 894b8832...`、`tier: community`、`maintainer: plastic-labs`。官方文档明确「Homes upgraded from a release that bundled Honcho get the plugin installed automatically」（`website/docs/user-guide/features/honcho.md` L12）——即**它曾经在内置树里，现已迁出**。

**provider 侧的安全边界**：所有 fan-out 到 provider 的数据都过 `_redact_for_provider()`（`agent/memory_manager.py` L101-137），注释写明「Providers archive whatever they are handed (#115104)」，且该 scrub 在 `security.redact_secrets` 关闭时**依然生效**（因为管的是「离开 agent 的东西」，不是本地日志，L90-96）。工具参数走 `urls=False`（provider 可能要真的去 fetch 预签名 URL）。

---

## 2. OpenClaw 记忆机制

### 2.1 存储架构与分层

OpenClaw 的权威描述在 `docs/concepts/memory-architecture.md` L53-61 的 tier 表，源码逐层可验：

| Tier         | 实际载体                                    | 写入者                               | 注入                                  |
| ------------ | ------------------------------------------- | ------------------------------------ | ------------------------------------- |
| Instructions | `AGENTS.md` 及 workspace 指令文件           | 仅人类                               | 会话开始，总是                        |
| Curated core | `MEMORY.md`、`USER.md`                      | dreaming 固化；用户直接要求          | 会话开始时按 provenance 合格性 + 预算 |
| Episodic     | `memory/YYYY-MM-DD.md`、session transcripts | agent 工作中；memory flush；转录捕获 | 仅检索时，不自动注入                  |
| Prospective  | standing intents（SQLite）+ cron jobs       | `intent` 工具；定时任务              | 仅触发器命中                          |
| Review       | `DREAMS.md`、dreaming reports               | dreaming 各阶段                      | 从不注入，供人阅读                    |

**SQLite 索引结构**（每 agent 一个库：`resolveOpenClawAgentSqlitePath({ agentId })`，`src/agents/memory-search.ts` L247-249）：

| 表                              | 作用                                                                           | 依据                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `memory_index_chunks`           | 分块正文 + embedding + hash/model/updated_at                                   | `src/state/openclaw-agent-storage-schema.ts` L17-28                                                           |
| `memory_index_chunks_fts`       | FTS5 正文索引（tokenizer `unicode61`）                                         | `src/infra/database-engine/sqlite-search-schema.ts`（表名常量）；tokenizer 默认见 `memory-search.ts` L250-253 |
| `memory_index_paths_fts`        | 路径/文件名单独索引（精确路径、basename、stem 优先）                           | 同上；语义见 `docs/concepts/memory-search.md` L158                                                            |
| `memory_index_chunk_provenance` | 每 chunk 的 `origin_class` / `session_kind` / `observed_at` / `supersedes_key` | `extensions/memory-core/src/memory/manager-chunk-writer.ts` L45-49、L126-140                                  |
| `memory_entry_origins`          | 条目级来源（含 CHECK 约束）                                                    | `packages/memory-host-sdk/src/memory-entry-origins.ts` L31-40                                                 |
| `memory_embedding_cache`        | embedding LRU 缓存（默认上限 50,000）                                          | `openclaw-agent-storage-schema.ts` L29-38；`DEFAULT_CACHE_MAX_ENTRIES = 50_000`（`memory-search.ts` L92）     |

`memory_entry_origins` 的 CHECK 约束是安全模型的地基（L31-40）：

```sql
CREATE TABLE IF NOT EXISTS memory_entry_origins (
  ...
  origin_class TEXT NOT NULL CHECK (origin_class IN ('owner', 'agent', 'untrusted', 'system')),
  observed_at INTEGER NOT NULL,
  ...
```

**分块参数**：`chunking: { tokens: 400, overlap: 80 }`（`src/agents/memory-search.ts` L260）。

**作用域与隔离**（三层，互不替代）：

1. **agent 级**：索引库按 `agentId` 分文件（L247-249），`memory.search` 支持 `agents.entries.<id>` 覆盖（`resolveMemorySearchIndexConfig` 用 `resolveAgentConfig(cfg, agentId)?.memory?.search`，L124-127）。
2. **project 级（同一文件内做排序/注入分区，不切分文件）**：条目可带尾注 `<!-- project: github.com/openclaw/openclaw -->`；key 来自归一化的 `origin` remote（fork 因 remote 不同而天然分离，无 origin 时用绝对根路径）；每个 session 保留最多 **4 个**最近活跃 repo key（MRU，超出即驱逐，且该集合是**不持久化的运行时状态**）。见 `memory-architecture.md` L293-344。
3. **audience / 会话隐私**：`rememberAcrossConversations` 打开后，同 agent 的其他「已识别私有会话」片段才可参与回复上下文（`memory-architecture.md` L64-73；配置解析 `memory-search.ts` L132-144）。

### 2.2 写入路径与 provenance

**唯一主写入者**是 dreaming 的 consolidation（`memory-architecture.md` L136-150 的 mermaid 与文字：「Durable memory has exactly one primary writer: the dreaming consolidation pass. Everything else feeds it.」）。

数据流（同文档 L141-150）：

```
交互会话 --(notes, flush)--> episodic + index(with provenance)
会话结束 --(transcript ingestion)--> 同上
压缩前 flush --(facts to daily notes)--> 同上
episodic --> dreaming check(规则) --> gated candidates(永不 untrusted/system)
         --> consolidation(模型, 有界) --(merge/supersede/dedupe)--> MEMORY.md / USER.md
         --> summary + pre-image --> DREAMS.md
```

**provenance 在写入时确定，且模型无法用正文伪造**（`memory-architecture.md` L75-115）：

- `origin_class` 是**闭集**：`owner` / `agent` / `untrusted` / `system`；判定保守，「never defaulted to `owner`」（L91-93）。
- `session_kind` 记录来源会话类型；cron/heartbeat/sub-agent 会话**不产生** durable candidate（L100-102）。
- **recall-loop prevention**：从记忆注入到上下文的内容被结构化标记，永不再被抽取为新记忆——「A fact recalled one hundred times stays one fact」（L103-106）。
- **taint 在轮内传播**：工具结果若声明为网络来源，则该轮之后所有 assistant 消息带 taint，记忆分类按 `untrusted` 处理，直到下一条用户消息清除（L126-134）。
- **文件哈希 + 最小信任类**：一次 flush 会把整个文件记为**最不信任**的类别，受信行会刻意失去晋升资格，防止「搭可信文件哈希的便车」（L119-124）。

代码侧：`memory_index_chunk_provenance` 的四列由 `manager-chunk-writer.ts` 写入（L126-140），缺省 provenance 会被填成 `originClass: "untrusted"`（L129-138 附近）。`memory-artifact-provenance.ts` 另外维护 workspace 文件的 `fileHash + originClass + observedAt`（`MEMORY_ARTIFACT_PROVENANCE_MAX_ENTRIES = 50_000`，L11）。

**写入安全（乐观并发）**：替换 `MEMORY.md` 前重新校验构建输入时捕获的内容哈希，再原子 rename；若期间被编辑器/其他 session 改动，则**放弃本次重写、退回 append**（`memory-architecture.md` L212-220）。这与 Hermes 的 `flock` 是两种不同策略：OpenClaw 明确接受「毫秒级竞态窗口可恢复」，以换取「不需要所有 Markdown 编辑器共享一把锁」。

### 2.3 注入：三条 lane 与预算

OpenClaw 把召回按成本分成两条 lane（`memory-architecture.md` L222-291）。

#### Lane 1：零模型调用，每轮常开

1. **Bootstrap injection**：`MEMORY.md` / `USER.md` 在会话开始加载，**只有 provenance 合格才注入**；不合格/缺失/不受支持的分类会被排除出自动上下文，但仍可经显式工具访问（doc L230-238）。源码：`src/agents/bootstrap-files.ts` 用 `isMemoryOriginEligibleForAutomaticInjection(originClass)` 过滤（L203-218），并对排除项发一次 warning（含 `run openclaw doctor` 提示）。
   - 预算：`DEFAULT_BOOTSTRAP_MAX_CHARS = 20_000`（`src/agents/embedded-agent-helpers/bootstrap-limits.ts`）；**`USER_BOOTSTRAP_MAX_CHARS = 4_000` 是固定上限，`bootstrapMaxChars` 无法抬高它**（`src/agents/embedded-agent-helpers/bootstrap.ts`；提示文案见 `src/flows/doctor-core-bootstrap-size-check.ts`：「USER.md has a fixed 4,000-character bootstrap cap that `bootstrapMaxChars` cannot raise」）。接近上限的告警阈值 `DEFAULT_BOOTSTRAP_NEAR_LIMIT_RATIO = 0.85`（`src/agents/bootstrap-budget.ts` L71）。
2. **Ranked search**：`memory_search` = hybrid relevance × 指数时间衰减（30 天半衰期）× importance 乘子（doc L239-245）。
3. **Trigger injection**：写入者可给条目挂 trigger 短语；每条入站消息做一次快速词法+向量预筛，**score ≥ 0.65** 的条目作为紧凑隐藏块注入，**每轮最多 3 条**。

Trigger 参数全部在 `extensions/active-memory/trigger-recall.ts` 常量区（L22-36）：

```ts
const TRIGGER_CANDIDATE_LIMIT = 24;
const TRIGGER_INJECTION_LIMIT = 3;
const MAX_TRIGGER_CONTEXT_CHARS = 1800;
const STRONG_TRIGGER_MATCH_SCORE = 0.65;
```

注释还给出了阈值标定依据（20 trigger / 50 unrelated 合成语料，0.60 以下零误报、0.72 拒绝合法改写、0.68 是单词概念 trigger 的分数上限 0.85×0.8）。打分函数（L57-97）：

- 单词 trigger：命中即 `0.85`；
- 多词：`coverage * 0.8 + min(1, overlap/2) * 0.2`；
- 最终：`triggerScore * 0.8 + relevance * 0.2`（relevance 取检索 score，clamp 0..1）。

分词细节：`WORD_RE = /[\p{L}\p{N}_]+/gu`，单字符词被过滤；含 Han/Hiragana/Katakana/Hangul 的词**允许词内匹配**（因为中日韩不用空格分词，韩语附着助词），已在注释里承认副作用（L34-36、L42-50）。

**Lane 1 不产生 embedding 调用**：`lexicalOnly: true`，注释写「Lane-1 runs on every eligible inbound message; it must stay deterministic and local, so query embedding is disabled」（L283-286）。

#### Lane 2：escalation（Active Memory 子代理）

阻塞式 recall 子代理，一个真实 agent turn，可跨会话检索历史。默认只在**两个固定条件同时成立**时启动（doc L279-291）：

1. 消息表现出 recall intent（显式回顾、时间性措辞、对既往决策/对话的直接提问）；
2. Lane 1 没有强命中。

`mode: "always"` / `"off"` 可覆盖。这里的取舍引用 LongMemEval：时间性与多跳问题正是扁平检索最弱的地方。

**自动注入只限 curated tier**：`MEMORY.md` / `USER.md` 可自动注入；daily notes 与 transcripts **无论匹配多强都不自动注入**，只能经显式工具或 escalation。文档称之为 security property 而非 tuning choice（L268-273）。

### 2.4 检索：hybrid → decay → importance → MMR

#### 2.4.1 默认参数（配置解析的唯一真源）

`src/agents/memory-search.ts` L155-174：

```ts
query: {
  maxResults: overrides?.query?.maxResults ?? defaults?.query?.maxResults ?? DEFAULT_MAX_RESULTS,   // 6
  minScore: clampNumber(... ?? DEFAULT_MIN_SCORE, 0, 1),                                            // 0.35
  hybrid: {
    enabled: true,
    vectorWeight: 0.7,
    textWeight: 0.3,
    candidateMultiplier: 4,
    mmr: { enabled: true, lambda: 0.7 },
    temporalDecay: { enabled: true, halfLifeDays: 30 },
  },
}
```

⚠️ 注意：这里 `hybrid` 整块是**字面量**，不读取 `overrides.query.hybrid`。这不是 bug——`docs/reference/memory-config.md` L586-591 明确写：

> "Hybrid retrieval remains enabled. The builtin engine always applies a fixed 30-day recency half-life ... a fixed importance multiplier ... then applies MMR diversity ordering with a fixed lambda of `0.7`. ... no migration or new tuning key is required for existing indexes."

即**当前版本这四项是写死的产品决策，不是可调参数**。文档与源码在此一致。

其他默认：`store.driver = "sqlite"`、`fts.tokenizer = "unicode61"`、`vector.enabled = true`、`chunking = { tokens: 400, overlap: 80 }`（L247-260）。同步策略：`onSessionStart / onSearch / watch = true`、`watchDebounceMs = 1500`、`sessions.deltaBytes = 100_000`、`sessions.deltaMessages = 50`、`postCompactionForce = true`（L293-307）。

候选放大：`Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier))`（`extensions/memory-core/src/memory/manager-search-orchestration.ts` L121）。

#### 2.4.2 混合与关键词分数标定

朴素加权会被 BM25 饱和坑掉，源码注释说得很清楚（`extensions/memory-core/src/memory/hybrid.ts` L60-79）：

> "BM25 keyword scores saturate as relevance / (1 + relevance), and every chunk outside the keyword window scores 0, so a fixed text weight mostly rewards window membership."

因此 `createKeywordScoreScale()` 先**反饱和**（`relevance = score / (1 - score)`），再按「相对本查询最强关键词命中」归一，并让最强命中最多只拿到本查询最佳向量分数：

```ts
const share = score >= 1 ? 1 : relevance(score) / strongest;
return Math.min(score, share * bestVectorScore);
```

合并公式（L155-180）：

```
contentScore = vectorWeight * vectorScore + textWeight * keywordScore
rankingScore = exactPathSpecificity > 0
                 ? (decay enabled ? (1+clamp(contentScore))/2 : ...)
                 : contentScore
```

BM25 → score 的转换在 `keyword-query.ts` L177-186（SQLite 的 `bm25()` 返回**负值越大越相关**）：

```ts
if (rank < 0) {
  const relevance = -rank;
  return relevance / (1 + relevance);
}
return 1 / (1 + rank);
```

（CHANGELOG 2026.3.7 记录过此前负数排序被压平/反转的修复，#33757。）

#### 2.4.3 时间衰减

`extensions/memory-core/src/memory/temporal-decay.ts` L18-27：

```ts
return params.score * Math.exp(-(Math.LN2 / halfLifeDays) * clampedAge);
```

**哪些文件会衰减**（同文件 `extractTimestamp`）：

| 路径                                               | 时间来源                               | 是否衰减                                |
| -------------------------------------------------- | -------------------------------------- | --------------------------------------- |
| `memory/YYYY-MM-DD.md`（含子目录、可带 `-suffix`） | 文件名内嵌日期（UTC）                  | 是                                      |
| `MEMORY.md`、`USER.md`                             | —                                      | **否**（evergreen）                     |
| `memory/**` 下无日期的主题文件                     | —                                      | **否**（evergreen）                     |
| 其他 workspace 文件                                | 索引记录的 mtime                       | 是（除非标为 `evergreen` 的 extraPath） |
| `source: "sessions"`                               | 索引记录的会话活动时间（不读文件系统） | 是                                      |

#### 2.4.4 importance 与 project 乘子

`extensions/memory-core/src/memory/project-ranking.ts` L38-51：

```ts
const multiplier =
  importance == null
    ? 1
    : 0.75 + Math.max(1, Math.min(10, Math.floor(importance))) * 0.05;
// importance=1 → 0.80；10 → 1.25；缺失 → 1.0（中性）
score: entry.score *
  multiplier *
  projectScoreMultiplier(entry.projectKey, activeProjectKeys);
```

`projectScoreMultiplier()`（L14-27）：条目所有 project key 都在活跃集合内 → **1.15**；否则 → **0.9**；无标签 → 1.0。

**阈值语义有个容易误读的点**（`docs/concepts/memory-search.md` L205-210）：

> "`minScore` threshold uses relevance before recency decay, including importance and project weighting. Recency changes the ordering of eligible hits, not whether they qualify."

代码里对应 `eligibilityScore` 在 decay **之前**计算，`selectHybridSearchResults()` 用它过阈值（`hybrid.ts` L299-344）。所以一条高相关旧笔记可以返回**最终 score 低于 minScore** 的结果。

#### 2.4.5 MMR

`extensions/memory-core/src/memory/mmr.ts` L1-70：标准 Carbonell & Goldstein（1998），`λ * relevance - (1-λ) * similarity`，relevance 在候选集内 min-max 归一到 0..1，相似度用 snippet 的 token 集合，选中后增量更新每个候选的 `maxSimilarity`（避免 O(n²) 重扫）。`lambda === 1` 退化为纯按 score 排序。

MMR **不改变分数、不改变阈值资格、不额外调用模型**（`memory-search.md` L216-218）。

#### 2.4.6 结果选择的两条兜底

`selectHybridSearchResults()`（`hybrid.ts` L299-344）：

1. 若**全部**候选都低于 `minScore` 但存在关键词命中，则返回纯词法候选（保 keyword recall）；
2. 若已达 `maxResults` 之外还有空位，用关键词候选补位（hybrid 会「填满剩余槽位」）。

### 2.5 压缩前 Memory Flush

**触发与计划**：`extensions/memory-core/src/flush-plan.ts`

| 常量 / 配置                                   | 值                                                                             | 依据   |
| --------------------------------------------- | ------------------------------------------------------------------------------ | ------ |
| `DEFAULT_MEMORY_FLUSH_SOFT_TOKENS`            | 4,000 tokens                                                                   | L12    |
| `DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES` | 2 MiB                                                                          | L13    |
| 开关                                          | `agents.defaults.compaction.memoryFlush.enabled === false` → 返回 null（禁用） | L66-69 |
| 目标文件                                      | `memory/${dateStamp}.md`（用户时区）                                           | L88-90 |

flush prompt 是**固定模板**（L21-39），三条硬约束值得单独记：

- `"Store durable memories only in memory/YYYY-MM-DD.md"`
- `"Treat workspace bootstrap/reference files such as MEMORY.md, DREAMS.md, SOUL.md, and AGENTS.md as read-only during this flush; never overwrite, replace, or edit them."`
- `"If memory/YYYY-MM-DD.md already exists, APPEND new content only and do not overwrite existing entries."`
- 无事可记则回 `SILENT_REPLY_TOKEN`

**频次控制**：`src/auto-reply/reply/memory-flush.ts` L138-145

```ts
/** One flush per compaction cycle, regardless of token or transcript-size trigger. */
export function hasAlreadyFlushedForCurrentCompaction(entry) {
  const compactionCount = entry.compactionCount ?? 0;
  return entry.memoryFlush?.compactionCount === compactionCount;
}
```

`shouldRunPreflightCompaction()`（L116-136）用 `totalTokens >= threshold` 判定；阈值来源含软阈值与 reserve 计算，`contextWindowTokens` 存在时软阈值还会被压到 `(contextWindowTokens - reserveTokensFloor) / 2` 以下（`flush-plan.ts` L77-86）。

**这是 OpenClaw 与 Hermes 最本质的差别**：flush 是**框架发起的独立 turn**（有专用 system prompt、专用目标文件、每压缩周期一次），不依赖模型「想起来要记」。

### 2.6 Dreaming：带闸门的固化

三阶段（`docs/concepts/dreaming.md` L70-106）：

| Phase | 作用                                           | 是否写 `MEMORY.md` |
| ----- | ---------------------------------------------- | ------------------ |
| Light | 排序/去重/暂存近期短时材料，记录 reinforcement | 否                 |
| REM   | 主题与反思摘要，记录 REM reinforcement         | 否                 |
| Deep  | 打分并通过闸门后晋升                           | **是**             |

**Deep 的六个基础信号与权重**（`dreaming.md` L196-206，官方表格）：

| 信号                          | 权重 |
| ----------------------------- | ---- |
| Relevance                     | 0.30 |
| Frequency                     | 0.24 |
| Query diversity               | 0.15 |
| Recency                       | 0.15 |
| Consolidation（多日复现强度） | 0.10 |
| Conceptual richness           | 0.06 |

Light/REM 阶段命中的 reinforcement 会带来小幅 recency-decayed 加成。

**闸门默认值**（`src/memory-host-sdk/dreaming.ts` L22-42，源码已确认；与 `docs/cli/memory.md` L659-663 一致）：

```ts
DEFAULT_MEMORY_DREAMING_FREQUENCY = "0 3 * * *";
DEFAULT_MEMORY_DEEP_DREAMING_LIMIT = 10;
DEFAULT_MEMORY_DEEP_DREAMING_MIN_SCORE = 0.75;
DEFAULT_MEMORY_DEEP_DREAMING_MIN_RECALL_COUNT = 3;
DEFAULT_MEMORY_DEEP_DREAMING_MIN_UNIQUE_QUERIES = 3;
DEFAULT_MEMORY_DEEP_DREAMING_RECENCY_HALF_LIFE_DAYS = 14;
DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS = 160;
DEFAULT_MEMORY_DEEP_DREAMING_MAX_PRIOR_ENTRY_LOSS_FRACTION = 0.25;
```

注意 **14 天是 dreaming 晋升用的半衰期，与检索的固定 30 天不是同一个参数**，容易混淆。

**两道顺序闸门**（`memory-architecture.md` L182-192）：

1. **规则检查**：加权排序 + 全部阈值闸门；`origin_class` 为 `untrusted`/`system` 的候选在**构建 prompt 之前**被结构性排除——"This is a precondition, not a score penalty: no amount of recall frequency promotes untrusted content into the curated core."
2. **consolidation 模型步**：拿到通过闸门的候选 + 当前 `MEMORY.md`，产出修订版全文（合并重复、用 supersession key 退休被取代条目、保留 daily-note 锚点引用）。

**产物验收**（L202-210）：必须通过结构校验、落在 bootstrap 预算内、且**丢失的既有条目不超过 `maxPriorEntryLossFraction`（0.25）**；否则该轮退回 append-only。若 append 仍装不下，则保留 `MEMORY.md` 原样、候选留待下次。

**可追溯性**：每次接受的改写都会保存 pre-image，并把人类可读摘要追加进 `DREAMS.md`（L212-220）。

**摄入边界**：只有交互会话可进入 dreaming 语料；cron/heartbeat/subagent/unknown 全部排除（`dreaming.md` L107-110）。转录文本**在摄入前不做 secret 脱敏**，但运行期标记的 recalled context 会被移除，防止「回忆被当作新记忆再学一遍」。

### 2.7 扩展机制：memory slot 与官方插件

**槽位模型**：`plugins.slots.memory` 选定**唯一** owner；未设置时默认 `memory-core`；设为 `"none"` 则关闭记忆插件（`docs/tools/plugin.md`；源码读取点 `src/plugins/plugin-root-contributions.ts`、`extensions/memory-core/src/cli-memory-slot.ts`）。

`memory-core` 的插件清单（`extensions/memory-core/openclaw.plugin.json`）：

```json
{
  "id": "memory-core",
  "name": "OpenClaw Memory",
  "kind": "memory",
  "contracts": { "tools": ["intent", "memory_get", "memory_search"] },
  "activation": { "onStartup": false }
}
```

**生态现状（重要，与常见认知不符）**：

| 插件                  | 状态                                                                                                                                     | 依据                                                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory-core`（内置） | 默认 slot owner，SQLite 索引 + dreaming                                                                                                  | plugin.json；`docs/concepts/memory-builtin.md`                                                                                                                                          |
| `memory-lancedb`      | **官方外部**插件，npm `@openclaw/memory-lancedb`，不在 runtime 镜像内；安装时**自动切换** `plugins.slots.memory` 并把原 owner 禁用并告警 | `docs/plugins/memory-lancedb.md` L22-40                                                                                                                                                 |
| `memory-wiki`         | 伴生插件，**不替代** slot owner（编译式知识库）                                                                                          | `docs/concepts/memory.md` L278-291                                                                                                                                                      |
| **`qmd`**             | **已被移除**                                                                                                                             | `docs/concepts/memory-builtin.md` L375-393：「QMD has been removed; builtin is the only memory engine」，`openclaw doctor` 会清理 `memory.backend` / `memory.qmd` / `memory.search.qmd` |

⚠️ 因此「OpenClaw 的 `memory-core` / `memory-lancedb` / `qmd` 三件套」这一说法**在当前上游已不成立**，`qmd` 只剩迁移残留（`src/commands/doctor/shared/legacy-config-migrations.runtime.retired-memory-qmd.ts`）。

**provider 契约**：`src/plugins/memory-provider-adapter.ts`、`memory-provider-open.ts`、`memory-backend.ts` 提供注册与打开；`packages/memory-host-sdk` 提供 host 侧 engine/storage/schema。文档入口 `docs/plugins/knowledge/memory-provider.md`。选型是**互斥**的：`docs/plugins/memory-lancedb.md` 明确「only one plugin owns the active memory slot at a time」，`knowledge` 插件同样会占用该 slot（`docs/plugins/knowledge.md`）。

---

## 3. 横向原理对比

### 3.1 总表

| 维度                  | Hermes Agent                                                                     | OpenClaw                                                                    |
| --------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **设计哲学**          | 小容量、高信号、模型自治；预算即纪律                                             | 分层、可审计、规则闸门；写入即安全边界                                      |
| **权威存储**          | Markdown（`MEMORY.md`/`USER.md`）+ SQLite 转录 + skills                          | Markdown 分层（curated/episodic/review）+ 单 SQLite 索引                    |
| **语义索引**          | 无（FTS5/BM25 词法）；语义靠 provider                                            | 有（SQLite vec + FTS5），hybrid 融合                                        |
| **容量上限**          | 2,200 / 1,375 chars（硬）                                                        | 20,000 chars bootstrap（`USER.md` 固定 4,000）                              |
| **作用域**            | profile（HERMES_HOME）；无 project 维度                                          | agent（独立 DB）→ project（注解 + 活跃集合，最多 4）→ audience              |
| **写入主体**          | 模型（`memory` 工具，批量原子）                                                  | 框架流水线（flush / transcript ingestion → dreaming consolidation）         |
| **注入位置**          | 内置：system prompt `volatile` 尾段；外部：user 消息尾部 fence                   | system prompt bootstrap 段（预算内）+ 隐藏 trigger 块 + escalation          |
| **Prompt cache 策略** | 冻结 load-time snapshot；压缩后才重建；召回走 `api_content` sidecar 保持字节稳定 | bootstrap 每轮在预算内刷新；curated 文件小、位置稳定                        |
| **检索排序**          | BM25（SQLite 原生）+ 来源降权（cron）+ lineage 去重                              | hybrid(0.7/0.3) → 关键词反饱和标定 → 30 天衰减 → importance → project → MMR |
| **时间衰减**          | 无                                                                               | 有，`score·exp(-(ln2/30)·ageDays)`；curated 永不衰减                        |
| **去重 / 冲突**       | 同 section 内逐字重复 bullet 丢弃；条目级 `§` 唯一匹配                           | supersession key 退休旧事实；MMR 降冗余；consolidation 合并                 |
| **压缩前保护**        | 无（内置）；provider 可 `on_pre_compress` 且可选 fail-closed                     | 框架强制 flush，每压缩周期一次                                              |
| **跨会话固化**        | 无自动固化；provider `on_session_end`                                            | dreaming 三阶段 + 阈值闸门 + 产物验收                                       |
| **安全模型**          | 写入前 `scope="strict"` 威胁扫描 + 载入时 `[BLOCKED:]` 占位 + egress 脱敏        | 写入时 provenance 列 + tier 隔离 + taint 传播 + 结构排除                    |
| **扩展点**            | `MemoryProvider` ABC（单外部 provider）                                          | `plugins.slots.memory`（单 owner 插件）                                     |
| **失败姿态**          | 绝不阻塞回复（超时/降级/失败预算）                                               | 「Failures never block replies」（超时 + fallback）                         |

### 3.2 四个值得注意的原理性差异

**（1）「记忆」的边界定义不同。**

Hermes 把记忆定义为「每一轮都要看见的那一小块」，因此 2,200 字符是**产品约束**而非实现限制；超出部分被显式分流到 skills（程序性）与 `session_search`（情节性）。OpenClaw 把记忆定义为「一个可分层的语料库」，`MEMORY.md` 只是它的**蒸馏产物**，原始证据留在 daily notes 与 transcripts 里可回溯。

**（2）Prompt cache 的解法相反。**

Hermes 选择**冻结**：会话中写入不生效，换前缀稳定。OpenClaw 选择**分层 + 预算**：curated 文件本来就小，每轮刷新带来的前缀变化被限制在尾部；真正的大块（daily/transcript）根本不进 prompt。两者都在避免同一件事——让易变内容污染长前缀。

**（3）自动化的位置不同。**

Hermes 把自动化放在**工具调用**里（模型决定何时写、写什么、删什么），框架只提供预算与闸门；OpenClaw 把自动化放在**调度**里（flush 由压缩触发、固化由 cron 触发），模型只在 consolidation 那一步做语言判断。前者对模型判断力要求高、对框架要求低；后者相反。

**（4）安全假设不同。**

Hermes 的威胁模型是「模型可能被诱导写入恶意条目」——所以扫描**内容**（`scope="strict"`），并在载入时把命中项替换成 `[BLOCKED: ...]` 占位（原文仍保留在 live list，让用户能看见并删除，`memory_tool_store.py` L223-258）。OpenClaw 明确否定内容扫描的有效性（`memory-architecture.md` L393-422），改为**结构上不可能**：`untrusted` 永远进不了 curated tier，也永远不自动注入。

---

## 4. 对 `opencode-memory` 的启示

先对齐本仓库现状（`docs/architecture.md`）：Markdown 为唯一真源（`MEMORY.md` / `IDENTITY.md` / `USER.md` / `daily/` / `projects/<id>/`）；`@huggingface/transformers` ONNX 本地嵌入 + Vectra 向量索引；Git 追踪变更；召回为「每次请求从磁盘重建并注入 system prompt」+「模型主动 `memory(action="search")`」双通道（§3.3、§4.1）。以下 5 条均可由前述一手源码支撑。

### 4.1 把「每轮重建注入」换成「会话级冻结 + 显式失效」

**现状**：`architecture.md` §3.3 注明「无上下文缓存，每次从磁盘实时重建」，仅靠 `memory-awareness.md` 纯静态文本保护 KV cache。文件一变，system prompt 前缀即变。

**参照**：Hermes `format_for_system_prompt()` 返回 load-time snapshot，注释直言「mid-session writes don't touch it, preserving the prefix cache」（`tools/memory_tool_store.py` L655-658），并且只在压缩后经 `invalidate_system_prompt()` 重载（`agent/system_prompt.py` L841-860）。

**建议**：将注入内容冻结在 session 维度（首次注入时快照），在本 session 自己的写操作成功后**主动失效一次**（这是 Hermes 没做的、我们可以做得更好的地方——写者即读者时无需牺牲可见性），压缩/上下文重建时再强制失效。这样既保住前缀，又避免「刚写完看不到」的困惑。

### 4.2 给写入加硬预算与批量原子语义

**现状**：`memory` 工具提供 6 个 action，但未见字符/token 预算与「一次调用内先删后加」的原子批量语义（`docs/architecture.md` §3.2、§4.4）。

**参照**：Hermes 的 `operations` 数组 + 「limit is checked only on the FINAL result」（`tools/memory_tool.py` L378-382），配合溢出时回传 `current_entries` 要求模型**一次批量**腾挪（`_add_overflow` L332-340）；以及 `_MAX_CONSOLIDATION_FAILURES_PER_TURN = 3` 的终态熔断（L186、L206-220），确保「失败的记忆副作用绝不阻塞回复」。

**建议**：(a) 为 `MEMORY.md` / 项目 `MEMORY.md` 设字符预算并在写入响应里回传 `usage: "67% — 1,474/2,200 chars"`（Hermes 的 usage 指示器是被验证有效的容量压力信号）；(b) 引入 `patch`（局部 span 替换）而不只是 `edit` 整文件，避免模型为大改一行而重写全文；(c) 加每轮失败上限，防止工具循环烧穿 turn。

### 4.3 检索从「纯向量」升级为 hybrid，并补上时间维度

**现状**：`FileSearcher` 只做向量检索（`embedText` → `vectorStore.searchGlobal/searchProject`），按余弦 score 降序，无词法通道、无时间衰减、无多样性重排（`docs/architecture.md` §3.3）。

**参照**：OpenClaw 的完整排序链（`hybrid.ts` L155-288）与三个可直接借鉴的工程细节：

1. **BM25 饱和必须矫正**：`relevance = score/(1-score)` 反饱和后按最强关键词命中归一，否则「共享常见词」会压过语义更近的结果（`hybrid.ts` L60-79）。
2. **衰减只作用于 episodic**：`MEMORY.md`/`USER.md` 标为 evergreen 不衰减，`memory/YYYY-MM-DD.md` 用文件名内嵌日期（`temporal-decay.ts` `extractTimestamp`）。我们的 `daily/YYYY-MM-DD.md` 有同样的天然时间戳，可零成本套用 `score·exp(-(ln2/30)·ageDays)`。
3. **阈值与衰减解耦**：`minScore` 在衰减**之前**判定（`selectHybridSearchResults`），否则旧但高度相关的笔记会被静默丢弃。这条如果我们加衰减，务必同步实现。

### 4.4 增加 provenance 分层，阻断「检索结果回流为长期记忆」

**现状**：`daily/` 与 `search` 结果不自动注入（这一点已经比很多系统严谨），但**写入侧没有来源标记**：模型可以把一次搜索结果、甚至外部网页摘要，直接 `write` 进 `MEMORY.md`。

**参照**：OpenClaw 的 `origin_class` 闭集 + 写入时定类 + `untrusted` 结构上排除出 curated tier（`memory_entry_origins` 的 CHECK 约束，L31-40；晋升闸门 `memory-architecture.md` L182-192）；以及 recall-loop prevention：「A fact recalled one hundred times stays one fact」（L103-106）。

**建议**：在 frontmatter 或条目旁记录 `origin: owner | agent | search-result | untrusted`，并规定：`search-result`/`untrusted` 来源的条目**不得进入自动注入区**（可留在 daily 或项目笔记），只有显式 promote 才升级。这对「模型把网页内容当事实记下来」这类污染是结构性防御，比内容扫描可靠。

### 4.5 用 slot/ABC 抽象把存储后端与注入策略解耦

**现状**：Vectra + ONNX + Markdown 深度耦合在 `MemoryManager` / `FileSearcher` / `vector-store.ts` 中（`architecture.md` §1 的 Pipeline 层），换后端等于改核心。

**参照**：Hermes 的 `MemoryProvider` ABC 把「注入（`system_prompt_block` / `prefetch`）/ 持久化（`sync_turn`）/ 压缩（`on_pre_compress`）/ 工具（`get_tool_schemas`）」拆成独立可选方法，且明确**只允许一个外部 provider**以避免 tool-schema 膨胀与后端冲突（`agent/memory_manager.py` L285-300）；OpenClaw 用 `plugins.slots.memory` 达到同样目的，并规定「only one plugin owns the active memory slot at a time」。

**建议**：抽出内部 `MemoryBackend` 接口（`search` / `upsert` / `delete` / `capabilities`），默认实现仍是 Vectra；把「注入策略」与「检索策略」作为独立策略对象，而不是写死在 `session.hook("context")` 与 `FileSearcher` 里。这样未来接 BM25、接远端 provider、或按 session 切后端，都不必动业务编排层。

> 注：以上仅为调研结论，本次未修改任何业务代码。

---

## 5. 未在源码中证实 / 需谨慎的表述

为避免后续引用出错，以下逐条标注可信度。

| #   | 事项                                                                 | 状态                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Hermes 内置 store 是否以 `name="builtin"` 注册进 `MemoryManager`** | **部分证实**。`agent/agent_init.py` L1188-1213 只把**外部** provider `add_provider(_mp)`；内置记忆是独立的 `MemoryStore`（L1160-1186）。但 `MemoryManager` 仍保留 `builtin` 特例（`add_provider` 永远接受、`initialize_all` 跳过、`_prefetch_provider` 不做超时），测试也构造 `_FakeProvider("builtin", ...)`。**结论：契约上存在 builtin provider 形状，实际 agent 装配路径不注册它**。不要再断言「内置 provider 由 manager 统一调度」。 |
| 2   | Hermes 压缩触发阈值（token 数 / 百分比）                             | **未证实**。`agent/context_compressor.py` 约 300 KB 未逐行审阅；本报告只使用「压缩后重建 prompt」这一有明确源码依据的事实。                                                                                                                                                                                                                                                                                                               |
| 3   | OpenClaw `hybrid` 参数是否可由配置覆盖                               | **已确认不可**。源码是字面量（`memory-search.ts` L163-170），文档明确「fixed ... no new tuning key」（`memory-config.md` L586-591）。二者一致，**不是**文档/源码冲突。                                                                                                                                                                                                                                                                    |
| 4   | OpenClaw dreaming light/REM 的逐项内部阈值                           | **未逐一证实**。已证实 deep 闸门默认值与六信号权重（源码 + 官方表格）；light/REM 的中间阈值属内部实现，官方文档亦声明「Most phase policy, thresholds, and storage behavior are internal implementation details」（`dreaming.md` L380-382）。                                                                                                                                                                                              |
| 5   | OpenClaw `MEMORY.md` bootstrap 的具体拼接顺序与截断算法              | **未逐行证实**。已证实过滤函数 `isMemoryOriginEligibleForAutomaticInjection`、预算常量与 0.85 告警比例；`buildBootstrapInjectionStats` / `analyzeBootstrapBudget` 的完整截断策略未审阅。                                                                                                                                                                                                                                                  |
| 6   | 「Hermes 有 memory flush」                                           | **证伪**。仓库内 `flush` 均指消息持久化或缓存驱逐；内置记忆无压缩前自动抽取。                                                                                                                                                                                                                                                                                                                                                             |
| 7   | 「OpenClaw 有 qmd memory 后端」                                      | **证伪（已移除）**。见 `memory-builtin.md` L375-393 与 doctor 迁移文件。                                                                                                                                                                                                                                                                                                                                                                  |
| 8   | Hermes Honcho 是否仍随仓库分发                                       | **证伪**。已迁至 catalog：`plugin-catalog/honcho.yaml` 指向 `plastic-labs/honcho` 的 `hermes-plugin-honcho` 子目录，`tier: community`。                                                                                                                                                                                                                                                                                                   |

---

## 6. 一手信源清单

### 6.1 Hermes Agent（`NousResearch/hermes-agent` @ `main`, 2026-11-21）

**核心实现**

- `agent/memory_provider.py` — `MemoryProvider` ABC、`PRE_COMPRESS_CHECKPOINT_API_VERSION`、`TRIVIAL_PROMPT_RE`、`CORE_MEMORY_PROVIDER_SENTINELS`、profile 多路复用契约
- `agent/memory_manager.py` — `MemoryManager`、`add_provider`（单外部 provider）、`prefetch_all`、`_StuckCallGate`、`on_pre_compress`、`_redact_for_provider`
- `agent/memory_context.py` — `<memory-context>` fence、`StreamingContextScrubber`、`_drop_repeated_recall_lines`
- `agent/memory_manager_tools.py` — provider 工具 schema 注入与 gate
- `agent/memory_caller_scope.py` — profile 作用域与实例认领
- `agent/agent_init.py`（L1160-1215）、`agent/agent_init_memory_provider.py` — 装配与初始化 kwargs
- `agent/system_prompt.py` — `build_system_prompt_parts`（stable/context/volatile）、`_memory_parts`、`invalidate_system_prompt`
- `agent/turn_context.py` — `prefetch_all` 调用点、`compose_user_api_content`、`api_content` sidecar
- `agent/conversation_compression.py` — 压缩与消息 flush（用于证伪「memory flush」）
- `tools/memory_tool.py` / `tools/memory_tool_store.py` — `memory` 工具 schema、`MemoryStore`、`flock`、drift 检测、`_MAX_CONSOLIDATION_FAILURES_PER_TURN`
- `tools/session_search_tool.py` — 四形状检索、cron 降权、`_READ_MAX_CONTENT`
- `persistence/sqlite/_schema_ddl.py`、`persistence/sqlite/conversation/_store/search.py` — `messages_fts` / `bm25()`

**官方文档（仓库内站点源文件）**

- `website/docs/user-guide/features/memory.md`
- `website/docs/user-guide/features/memory-providers.md`
- `website/docs/user-guide/features/honcho.md`
- `website/docs/developer-guide/memory-provider-plugin.md`
- `website/docs/developer-guide/session-storage.md`
- `plugin-catalog/honcho.yaml`

### 6.2 OpenClaw（`openclaw/openclaw` @ `main`, 2026-11-21）

**核心实现**

- `src/agents/memory-search.ts` — 检索/同步/排序配置默认值、per-agent DB 路径、chunking
- `extensions/memory-core/src/memory/hybrid.ts` — 关键词反饱和标定、contentScore、MMR 接入、结果选择
- `extensions/memory-core/src/memory/temporal-decay.ts` — 衰减公式与 evergreen 判定
- `extensions/memory-core/src/memory/mmr.ts` — MMR 实现
- `extensions/memory-core/src/memory/project-ranking.ts` — importance / project 乘子
- `extensions/memory-core/src/memory/keyword-query.ts` — `bm25RankToScore`
- `extensions/memory-core/src/memory/manager-search-orchestration.ts` — 候选放大与检索编排
- `extensions/memory-core/src/memory/manager-chunk-writer.ts` — provenance 列写入
- `extensions/memory-core/src/flush-plan.ts` — flush 计划与 prompt 模板
- `extensions/memory-core/openclaw.plugin.json` — slot/kind/tools 契约
- `extensions/active-memory/trigger-recall.ts` — trigger 注入阈值与打分
- `src/auto-reply/reply/memory-flush.ts` — 每压缩周期一次 flush
- `src/memory-host-sdk/dreaming.ts` — dreaming 默认值（deep 闸门）
- `src/state/openclaw-agent-storage-schema.ts` — `memory_index_chunks` / `memory_embedding_cache`
- `src/infra/database-engine/sqlite-search-schema.ts` — FTS 表名与 schema 校验
- `packages/memory-host-sdk/src/memory-entry-origins.ts` — `origin_class` CHECK 约束
- `src/memory/memory-artifact-provenance.ts` — workspace 文件 provenance
- `src/agents/bootstrap-files.ts`、`src/agents/bootstrap-budget.ts`、`src/agents/embedded-agent-helpers/bootstrap.ts`、`.../bootstrap-limits.ts` — bootstrap 注入与预算
- `src/plugins/memory-provider-*.ts`、`memory-backend*.ts` — provider 注册与打开

**官方文档**

- `docs/concepts/memory-architecture.md`
- `docs/concepts/memory.md`
- `docs/concepts/memory-builtin.md`
- `docs/concepts/memory-search.md`
- `docs/concepts/memory-provenance.md`
- `docs/concepts/dreaming.md`
- `docs/reference/memory-config.md`
- `docs/cli/memory.md`
- `docs/plugins/memory-lancedb.md`
- `docs/plugins/knowledge/memory-provider.md`

### 6.3 本仓库（用于第 4 节对齐）

- `docs/architecture.md`（§1 架构图、§3.3 召回流程、§4.1 注入边界）
- `docs/dev/research/opencode-v2-plugin-compat.md`（头部元信息与行文结构参照）
