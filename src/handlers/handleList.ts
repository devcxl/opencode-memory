import type { MemoryManager } from "../memory/MemoryManager.js";

/**
 * 列出内存文件的组织结构。
 * 无 period 时按月份分组展示概览（最多 6 个月），
 * 指定 period 时直接展示该月/年的详细条目列表，
 * 避免在概览中展开过多细节导致信息过载。
 *
 * @param params - period（可选，YYYY-MM 或 YYYY）
 * @param memoryManager - MemoryManager 实例
 * @returns 格式化文件列表字符串
 */
export function handleList(
  params: { period?: string },
  memoryManager: MemoryManager,
): string {
  const { period } = params;

  if (period) {
    const filesWithTimestamps = memoryManager.listFilesByPeriod(period);
    if (filesWithTimestamps.length === 0) {
      return `No daily logs found for period: ${period}`;
    }

    const content = filesWithTimestamps
      .map((f) => {
        const tsList =
          f.timestamps.length > 0
            ? f.timestamps.map((ts) => `    - ${ts}`).join("\n")
            : "    (no timestamps)";
        return `- ${f.name}:\n${tsList}`;
      })
      .join("\n");

    return `Daily logs for ${period} (${filesWithTimestamps.length} files):\n${content}`;
  }

  const grouped = memoryManager.listFilesGroupedByMonth();
  const parts: string[] = [];

  if (
    grouped.root.length > 0 &&
    grouped.root.some((f) => f.timestamps.length > 0)
  ) {
    const rootContent = grouped.root
      .filter((f) => f.timestamps.length > 0)
      .map((f) => {
        const count = f.timestamps.length;
        const recentTs = f.timestamps.slice(0, 3);
        const more = count > 3 ? `... and ${count - 3} more` : "";
        const tsList = recentTs.map((ts) => `    - ${ts}`).join("\n");
        return `- ${f.name} (${count} entries):\n${tsList}${more ? `\n    ${more}` : ""}`;
      })
      .join("\n");
    parts.push(`Root files:\n${rootContent}`);
  }

  if (grouped.monthly.length > 0) {
    const displayMonthly = grouped.monthly.slice(0, 6);
    const moreCount = grouped.monthly.length - 6;

    const monthlyContent = displayMonthly
      .map((m) => {
        const recentFiles = m.files.slice(0, 3);
        const moreFiles = m.files.length - 3;
        const filesList = recentFiles
          .map((f) => {
            const count = f.timestamps.length;
            return `    - ${f.name} (${count} entries)`;
          })
          .join("\n");
        const moreFilesText =
          moreFiles > 0 ? `\n    ... and ${moreFiles} more files` : "";
        return `- ${m.month} (${m.fileCount} files, ${m.entryCount} entries):\n${filesList}${moreFilesText}`;
      })
      .join("\n");

    const moreText = moreCount > 0 ? `\n... and ${moreCount} more months` : "";
    parts.push(`Daily logs by month:\n${monthlyContent}${moreText}`);
  }

  if (parts.length === 0) {
    return "No memory files found.";
  }

  parts.push(
    "\nUse memory_list({period: 'YYYY-MM'}) to see details for specific month.",
  );
  parts.push(
    "Use memory_list({period: 'YYYY'}) to see all daily logs for specific year.",
  );

  return parts.join("\n");
}
