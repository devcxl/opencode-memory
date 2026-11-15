import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * 在临时 HOME 下运行测试回调，隔离真实 `~/.config/opencode` 配置与 memory 目录。
 *
 * @param run 回调参数为该临时 HOME 下的 memory 目录路径
 */
export async function withTempHome(
  run: (memoryDir: string) => Promise<void>,
): Promise<void> {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "opm-test-home-"));
  const previousHome = process.env.HOME;

  process.env.HOME = homeDir;

  try {
    await run(path.join(homeDir, ".config", "opencode", "memory"));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}
