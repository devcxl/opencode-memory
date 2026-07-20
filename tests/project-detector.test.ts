import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 这个测试文件不 mock detectProject，验证真实的三级 fallback 逻辑
const { detectProject } = await import("../src/utils/projectDetector.js");

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opencode-detector-"));
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function setupGitRepo(dir: string, remoteUrl?: string): void {
  git(["init"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["config", "user.email", "test@example.com"], dir);

  if (remoteUrl) {
    git(["remote", "add", "origin", remoteUrl], dir);
  }

  // 创建一个初始提交，确保 git rev-parse 能正常工作
  const testFile = path.join(dir, "README.md");
  fs.writeFileSync(testFile, "# Test", "utf-8");
  git(["add", "README.md"], dir);
  git(["commit", "-m", "initial"], dir);
}

// =============================================================================
// 三级 fallback 策略测试
// =============================================================================

test("detectProject with git remote returns owner/repo", () => {
  const dir = makeTempDir();
  try {
    setupGitRepo(dir, "https://github.com/test-user/test-repo.git");
    const result = detectProject(dir);
    expect(result).toBe("test-user/test-repo");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectProject with SSH remote returns owner/repo", () => {
  const dir = makeTempDir();
  try {
    setupGitRepo(dir, "git@github.com:test-user/ssh-repo.git");
    const result = detectProject(dir);
    expect(result).toBe("test-user/ssh-repo");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectProject without remote uses repo root basename via git rev-parse", () => {
  const dir = makeTempDir();
  try {
    const repoName = `test-repo-no-remote-${Date.now()}`;
    const repoDir = path.join(dir, repoName);
    fs.mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir); // 无 remote

    // 在子目录中运行检测，应取 repo root basename
    const subDir = path.join(repoDir, "src", "components");
    fs.mkdirSync(subDir, { recursive: true });
    const result = detectProject(subDir);

    // 应返回 repo root basename + 路径哈希
    expect(result).not.toBeNull();
    expect(result!).toStartWith(repoName);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectProject in non-git directory returns basename + hash", () => {
  const dir = makeTempDir();
  try {
    const projDir = path.join(dir, "my-script");
    fs.mkdirSync(projDir, { recursive: true });
    const result = detectProject(projDir);

    expect(result).not.toBeNull();
    // 格式: my-script.<8 hex chars>
    expect(result!).toMatch(/^my-script\.[0-9a-f]{8}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectProject in subdirectory returns repo root basename", () => {
  const dir = makeTempDir();
  try {
    const repoDir = path.join(dir, "deep-nested-repo");
    fs.mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);

    const subDir = path.join(repoDir, "a", "very", "deep", "path");
    fs.mkdirSync(subDir, { recursive: true });
    const result = detectProject(subDir);

    expect(result).not.toBeNull();
    expect(result!).toStartWith("deep-nested-repo");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// 排除目录测试
// =============================================================================

test("detectProject returns null for home directory", () => {
  const result = detectProject(os.homedir());
  expect(result).toBeNull();
});

test("detectProject returns null for dotfiles directory", () => {
  const dotDir = path.join(os.homedir(), ".test-dotfiles-dir");
  fs.mkdirSync(dotDir, { recursive: true });

  try {
    // 不在 dotfiles 中创建 git remote，以测试纯路径排除
    const result = detectProject(dotDir);
    expect(result).toBeNull();
  } finally {
    fs.rmSync(dotDir, { recursive: true, force: true });
  }
});

test("detectProject in ~/Projects/ subdirectory is NOT excluded", () => {
  const tmpBase = makeTempDir();
  const projectsDir = path.join(tmpBase, "Projects");
  const projDir = path.join(projectsDir, "my-app");
  fs.mkdirSync(projDir, { recursive: true });
  setupGitRepo(projDir, "https://github.com/user/my-app.git");

  try {
    const result = detectProject(projDir);
    expect(result).toBe("user/my-app");
    
    // 子目录也应正确检测
    const subDir = path.join(projDir, "src");
    fs.mkdirSync(subDir, { recursive: true });
    const subResult = detectProject(subDir);
    expect(subResult).toBe("user/my-app");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

// =============================================================================
// 去重与边界情况
// =============================================================================

test("detectProject produces different IDs for same-named dirs in different paths", () => {
  const dir1 = makeTempDir();
  const dir2 = makeTempDir();

  try {
    const proj1 = path.join(dir1, "my-project");
    const proj2 = path.join(dir2, "my-project");
    fs.mkdirSync(proj1, { recursive: true });
    fs.mkdirSync(proj2, { recursive: true });

    const id1 = detectProject(proj1);
    const id2 = detectProject(proj2);

    expect(id1).not.toBeNull();
    expect(id2).not.toBeNull();
    // 同名目录不同路径应产生不同 ID
    expect(id1).not.toBe(id2);
    // 但都应以 basename 开头
    expect(id1!).toStartWith("my-project.");
    expect(id2!).toStartWith("my-project.");
  } finally {
    fs.rmSync(dir1, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test("detectProject with git@ SSH format", () => {
  const dir = makeTempDir();
  try {
    setupGitRepo(dir, "git@github.com:company/product.git");
    const result = detectProject(dir);
    expect(result).toBe("company/product");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectProject with HTTPS without .git suffix", () => {
  const dir = makeTempDir();
  try {
    setupGitRepo(dir, "https://github.com/org/nosuffix");
    const result = detectProject(dir);
    expect(result).toBe("org/nosuffix");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
