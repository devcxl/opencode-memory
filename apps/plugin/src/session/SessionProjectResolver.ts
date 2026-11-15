import * as path from "node:path";
import type { Plugin } from "@opencode/plugin";
import { detectProject } from "../utils/projectDetector.js";

type PluginContext = Plugin.Context;

/**
 * 按 session 解析项目 ID。
 *
 * V2 的 server 是共享服务，`ctx.location` 只是插件加载位置，
 * 不能代表每个 session 所在的项目；必须读取 session 自己的 location。
 *
 * 同时保留基于 git 的 `detectProject()`，以维持现有
 * `projects/{owner}/{repo}` 记忆目录结构。
 */
export class SessionProjectResolver {
  private readonly cache = new Map<string, string | null>();

  constructor(private readonly ctx: PluginContext) {}

  /** 读取（并缓存）session 所属项目；失败时降级为全局 */
  async resolve(sessionID: string): Promise<string | null> {
    if (this.cache.has(sessionID)) {
      return this.cache.get(sessionID) ?? null;
    }

    try {
      const session = await this.ctx.session.get({ sessionID });
      const directory = session.subpath
        ? path.resolve(session.location.directory, session.subpath)
        : session.location.directory;
      const project = detectProject(directory);
      this.cache.set(sessionID, project);
      return project;
    } catch (error) {
      console.warn(
        `[opencode-memory] Failed to resolve project for session ${sessionID}:`,
        error instanceof Error ? error.message : error,
      );
      this.cache.set(sessionID, null);
      return null;
    }
  }

  /** 用事件自带的 location 直接登记，避免额外一次 session.get */
  setFromDirectory(
    sessionID: string,
    directory: string,
    subpath?: string,
  ): string | null {
    const target = subpath ? path.resolve(directory, subpath) : directory;
    const project = detectProject(target);
    this.cache.set(sessionID, project);
    return project;
  }

  /** session 删除时清理缓存 */
  delete(sessionID: string): void {
    this.cache.delete(sessionID);
  }

  /** 插件卸载时清理全部缓存 */
  clear(): void {
    this.cache.clear();
  }
}
