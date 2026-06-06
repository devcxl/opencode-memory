import type { MemoryManager } from "../memory/MemoryManager.js";

/**
 * 在内存文件中进行语义搜索，返回按相关性评分排序的结果。
 * scope 控制搜索范围：project 限定当前项目，global 只搜全局，all 搜索全部。
 *
 * @param params - query、max_results、period、scope
 * @param memoryManager - MemoryManager 实例
 * @param projectId - 当前项目 ID（project scope 必需）
 * @returns 格式化搜索结果字符串
 */
export async function handleSearch(
  params: {
    query?: string;
    max_results?: number;
    period?: string;
    scope?: string;
  },
  memoryManager: MemoryManager,
  projectId: string | null,
): Promise<string> {
  const { query, max_results, period, scope } = params;

  if (!query) {
    return "Error: query is required for search action.";
  }

  const effectiveProjectId =
    scope === "project" ? projectId : scope === "global" ? null : projectId;

  try {
    const results = await memoryManager.semanticSearch(
      query,
      max_results ?? 20,
      period,
      scope === "project" ? projectId : effectiveProjectId,
    );

    if (scope === "project" && !projectId) {
      return "No current project detected. Use --scope all or --scope global instead.";
    }

    if (results.length === 0) {
      const periodMsg = period ? ` (filtered by period: ${period})` : "";
      return `No results for "${query}"${periodMsg}.`;
    }

    const output = results
      .map((r) => {
        const ts = r.timestamp ? `[${r.timestamp}]` : "[no timestamp]";
        const heading = r.heading ? ` (${r.heading})` : "";
        return `${ts} ${r.filePath}${heading}:${r.score.toFixed(4)}: ${r.text.slice(0, 200)}`;
      })
      .join("\n\n");

    const periodMsg = period ? ` (filtered by period: ${period})` : "";
    return `Found ${results.length} results${periodMsg}:\n\n${output}`;
  } catch (error) {
    throw error;
  }
}
