import * as fs from "node:fs";
import { MemoryManager } from "./MemoryManager.js";
import {
  BOOTSTRAP_TEMPLATE,
  IDENTITY_TEMPLATE,
  MEMORY_TEMPLATE,
  USER_TEMPLATE,
  isInitTemplateContent,
} from "./templates.js";
import { readFileSafe } from "../utils/fs.js";

/** 管理首次运行的引导流程，负责初始化状态判断和模板创建 */
export class BootstrapManager {
  constructor(private readonly memoryManager: MemoryManager) {}

  /** 判断是否处于首次引导流程中（BOOTSTRAP.md 存在） */
  isBootstrapNeeded(): boolean {
    return fs.existsSync(this.memoryManager.getBootstrapPath());
  }

  /**
   * 推断当前初始化状态：
   * - BOOTSTRAP.md 存在 → "bootstrapping"
   * - MEMORY / IDENTITY / USER 均存在且包含非模板内容 → "ready"
   * - 其余情况 → "uninitialized"
   */
  getInitState(): "uninitialized" | "bootstrapping" | "ready" {
    if (this.isBootstrapNeeded()) {
      return "bootstrapping";
    }

    const memoryContent = readFileSafe(this.memoryManager.getMemoryPath());
    if (!memoryContent?.trim() || isInitTemplateContent(memoryContent)) {
      return "uninitialized";
    }

    const identityContent = readFileSafe(this.memoryManager.getIdentityPath());
    const userContent = readFileSafe(this.memoryManager.getUserPath());

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

  /**
   * 创建初始模板文件（BOOTSTRAP.md / MEMORY.md / IDENTITY.md / USER.md）
   * 只在文件不存在时写入，不覆盖已有内容
   */
  async createInitTemplates(): Promise<void> {
    await this.memoryManager.ensureDirectories();

    const bootstrapPath = this.memoryManager.getBootstrapPath();
    const memoryPath = this.memoryManager.getMemoryPath();
    const identityPath = this.memoryManager.getIdentityPath();
    const userPath = this.memoryManager.getUserPath();

    if (!fs.existsSync(bootstrapPath)) {
      fs.writeFileSync(
        bootstrapPath,
        BOOTSTRAP_TEMPLATE(bootstrapPath),
        "utf-8",
      );
    }
    if (!fs.existsSync(memoryPath)) {
      fs.writeFileSync(memoryPath, MEMORY_TEMPLATE, "utf-8");
    }
    if (!fs.existsSync(identityPath)) {
      fs.writeFileSync(identityPath, IDENTITY_TEMPLATE, "utf-8");
    }
    if (!fs.existsSync(userPath)) {
      fs.writeFileSync(userPath, USER_TEMPLATE, "utf-8");
    }
  }
}
