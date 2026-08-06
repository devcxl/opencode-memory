import * as path from "node:path";
import * as fs from "node:fs";
import { isInitTemplateContent } from "./templates.js";
import { readFileSafe } from "../utils/fs.js";
import type { MemoryMode } from "../providers/factory.js";

/** 检查 memory 系统的初始化状态，区分未初始化/引导中/就绪三种状态 */
export class StateChecker {
  private mode: MemoryMode;

  constructor(
    private memoryDir: string,
    mode: MemoryMode = "local",
  ) {
    this.mode = mode;
  }

  /** 检查 MEMORY.md 是否存在，作为系统是否初始化的基本标志 */
  isInitialized(): boolean {
    if (this.mode === "remote") return true;
    return fs.existsSync(path.join(this.memoryDir, "MEMORY.md"));
  }

  /** 检查 BOOTSTRAP.md 是否存在，判断是否处于引导流程中 */
  needsBootstrap(): boolean {
    if (this.mode === "remote") return false;
    return fs.existsSync(path.join(this.memoryDir, "BOOTSTRAP.md"));
  }

  /**
   * 推断当前初始化状态。
   *
   * 状态转移逻辑：
   * ├─ remote 模式 → 始终返回 "ready"（远程 Worker 自行管理状态）
   * ├─ BOOTSTRAP.md 存在 → "bootstrapping"（无论其他文件内容如何）
   * ├─ MEMORY.md 不存在 → "uninitialized"
   * ├─ MEMORY.md 为空或仍为模板 → "uninitialized"
   * ├─ IDENTITY.md + USER.md 内容已填写（非模板）→ "ready"
   * └─ 以上都不满足 → "uninitialized"
   *
   * 区分"uninitialized"和"bootstrapping"是为了让 AI 能选择
   * 不同的交互策略：引导阶段需要问答式对话，未初始化可能只是
   * 文件被意外删除。
   */
  getInitState(): "uninitialized" | "bootstrapping" | "ready" {
    if (this.mode === "remote") return "ready";

    const memoryPath = path.join(this.memoryDir, "MEMORY.md");
    const bootstrapPath = path.join(this.memoryDir, "BOOTSTRAP.md");
    const identityPath = path.join(this.memoryDir, "IDENTITY.md");
    const userPath = path.join(this.memoryDir, "USER.md");

    // 引导文件优先级最高 ── 存在即引导中
    if (fs.existsSync(bootstrapPath)) {
      return "bootstrapping";
    }

    // MEMORY.md 是系统初始化的核心标志
    if (!fs.existsSync(memoryPath)) {
      return "uninitialized";
    }

    const memoryContent = this.readContent(memoryPath);
    if (!memoryContent?.trim() || isInitTemplateContent(memoryContent)) {
      return "uninitialized";
    }

    // 所有核心文件存在且内容非模板 → 就绪
    const identityContent = this.readContent(identityPath);
    const userContent = this.readContent(userPath);

    if (
      identityContent?.trim() &&
      userContent?.trim() &&
      !isInitTemplateContent(identityContent) &&
      !isInitTemplateContent(userContent)
    ) {
      return "ready";
    }

    return "uninitialized";
  }

  /** 安全读取文件内容，文件不存在返回 null */
  private readContent(filePath: string): string | null {
    return readFileSafe(filePath);
  }
}
