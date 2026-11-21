import * as crypto from "node:crypto";
import type { Plugin } from "@opencode/plugin";
import type { MemoryManager } from "../memory/MemoryManager.js";
import type { SessionContextCache } from "../session/SessionContextCache.js";
import type { SessionProjectResolver } from "../session/SessionProjectResolver.js";
import type { SessionStateStore } from "../session/SessionStateStore.js";

type PluginContext = Plugin.Context;

const DEFAULT_FLUSH_TIMEOUT_MS = 8000;
const MAX_DIGEST_CHARS = 6000;
const MIN_DIGEST_CHARS = 120;
const NO_MEMORY_SENTINEL = "NO_MEMORY";

export interface CompactionFlushDependencies {
  memoryManager: MemoryManager;
  projects: SessionProjectResolver;
  sessionStates: SessionStateStore;
  contextCache: SessionContextCache;
  enabled?: boolean;
  timeoutMs?: number;
}

interface TextLikePart {
  type?: string;
  text?: string;
}

interface MessageLike {
  role?: string;
  content?: string | ReadonlyArray<TextLikePart>;
}

/**
 * 从即将压缩的消息列表中提取用户与助手的纯文本对话摘要，
 * 跳过冗长的 tool-result / reasoning / media，并从尾部截断至 maxChars。
 */
export function extractConversationDigest(
  messages: ReadonlyArray<MessageLike>,
  maxChars: number = MAX_DIGEST_CHARS,
): string {
  const turns: string[] = [];

  for (const msg of messages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;

    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content.trim();
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter(
          (part) => part?.type === "text" && typeof part.text === "string",
        )
        .map((part) => part.text!.trim())
        .filter(Boolean)
        .join("\n");
    }

    if (text) {
      turns.push(`[${msg.role}]: ${text}`);
    }
  }

  if (turns.length === 0) return "";

  const selected: string[] = [];
  let total = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (total + turn.length > maxChars && selected.length > 0) {
      break;
    }
    selected.unshift(turn);
    total += turn.length + 2;
  }

  return selected.join("\n\n").slice(-maxChars);
}

function computeDigestSignature(digest: string, messageCount: number): string {
  const hash = crypto
    .createHash("sha256")
    .update(digest)
    .digest("hex")
    .slice(0, 16);
  return `${messageCount}:${hash}`;
}

async function generateWithTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Compaction flush timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([task, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 注册 OpenCode V2 `compaction` 钩子：
 * 1. 始终使会话注入快照缓存失效；
 * 2. 在历史压缩前将尚未落盘的关键决策/偏好/排错结论自动追加到 daily 日志；
 * 3. 超时或任何异常静默降级，绝不阻塞压缩主流程。
 */
export async function registerCompactionFlush(
  ctx: PluginContext,
  deps: CompactionFlushDependencies,
): Promise<void> {
  const {
    memoryManager,
    projects,
    sessionStates,
    contextCache,
    enabled = true,
    timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
  } = deps;
  const inFlight = new Set<string>();

  await ctx.session.hook("compaction", async (event) => {
    contextCache.invalidate(event.sessionID);

    if (!enabled) return;
    if (inFlight.has(event.sessionID)) return;

    const digest = extractConversationDigest(
      (event.messages ?? []) as ReadonlyArray<MessageLike>,
    );
    if (digest.length < MIN_DIGEST_CHARS) return;

    const signature = computeDigestSignature(
      digest,
      event.messages?.length ?? 0,
    );
    if (sessionStates.hasCompactionFlushed(event.sessionID, signature)) {
      return;
    }

    const generateText = ctx.experimental?.generate?.text;
    if (typeof generateText !== "function") return;

    inFlight.add(event.sessionID);
    const controller = new AbortController();

    try {
      const prompt = [
        "You are preserving durable engineering notes before the conversation context is compacted.",
        "Review the conversation excerpt below and extract ONLY high-signal facts worth remembering in a daily engineering log:",
        "- Architectural decisions, conventions, or trade-offs agreed on",
        "- Root causes and fixes for non-trivial bugs",
        "- Explicit user preferences or environment constraints",
        "",
        "Rules:",
        "- Output 1 to 5 concise Markdown bullet points (`- ...`).",
        `- If there is nothing worth persisting, output exactly \`${NO_MEMORY_SENTINEL}\`.`,
        "- Do not include greetings, raw logs, or filler.",
        "",
        "Conversation excerpt:",
        digest,
      ].join("\n");

      const response = await generateWithTimeout(
        generateText(
          { prompt, model: event.model },
          { signal: controller.signal },
        ),
        timeoutMs,
        controller,
      );

      sessionStates.markCompactionFlushed(event.sessionID, signature);

      const extracted = (response?.text ?? "").trim();
      if (!extracted || extracted === NO_MEMORY_SENTINEL) {
        return;
      }

      const projectId = await projects.resolve(event.sessionID);
      await memoryManager.ensureDirectories();
      if (projectId) {
        memoryManager.ensureProjectDirs(projectId);
      }

      const { filePath } = memoryManager.getPathForTarget(
        "daily",
        undefined,
        projectId,
      );
      await memoryManager.appendFile(
        filePath,
        `## Compaction Flush\n${extracted}`,
        { origin: "agent" },
      );

      event.system.push({
        type: "text",
        text: "Note: Key decisions and findings from this turn sequence have been persisted to daily memory logs; summarize concisely without repeating raw log details.",
      });
    } catch {
      // Failure never blocks compaction
    } finally {
      inFlight.delete(event.sessionID);
    }
  });
}
