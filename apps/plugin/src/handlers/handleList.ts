import type { MemoryManager } from "../memory/MemoryManager.js";
import type { MonthGroup, SearchScope } from "../types.js";
import { validateScope } from "../utils/validation.js";

function formatRootSection(
  root: Array<{ name: string; timestamps: string[] }>,
): string | null {
  const withEntries = root.filter((f) => f.timestamps.length > 0);
  if (withEntries.length === 0) return null;

  const rootContent = withEntries
    .map((f) => {
      const count = f.timestamps.length;
      const recentTs = f.timestamps.slice(0, 3);
      const more = count > 3 ? `... and ${count - 3} more` : "";
      const tsList = recentTs.map((ts) => `    - ${ts}`).join("\n");
      return `- ${f.name} (${count} entries):\n${tsList}${more ? `\n    ${more}` : ""}`;
    })
    .join("\n");
  return `Root files:\n${rootContent}`;
}

function formatMonthlySection(monthly: MonthGroup[]): string | null {
  if (monthly.length === 0) return null;

  const displayMonthly = monthly.slice(0, 6);
  const moreCount = monthly.length - 6;

  const monthlyContent = displayMonthly
    .map((m) => {
      const recentFiles = m.files.slice(0, 3);
      const moreFiles = m.files.length - 3;
      const filesList = recentFiles
        .map((f) => `    - ${f.name} (${f.timestamps.length} entries)`)
        .join("\n");
      const moreFilesText =
        moreFiles > 0 ? `\n    ... and ${moreFiles} more files` : "";
      return `- ${m.month} (${m.fileCount} files, ${m.entryCount} entries):\n${filesList}${moreFilesText}`;
    })
    .join("\n");

  const moreText = moreCount > 0 ? `\n... and ${moreCount} more months` : "";
  return `Daily logs by month:\n${monthlyContent}${moreText}`;
}

/**
 * 列出内存文件的组织结构（感知项目与全局作用域）。
 */
export async function handleList(
  params: { period?: string; project?: string; scope?: string },
  memoryManager: MemoryManager,
): Promise<string> {
  const { period, project, scope } = params;
  if (scope) {
    validateScope(scope);
  }
  const listScope = (scope ?? "all") as SearchScope;
  const effectiveProject = listScope === "global" ? null : (project ?? null);

  if (period) {
    const filesWithTimestamps = await memoryManager.listFilesByPeriod(
      period,
      effectiveProject,
      listScope,
    );
    const scopePrefix = effectiveProject
      ? listScope === "project"
        ? `[scope: project/${effectiveProject}] `
        : `[scope: all (project/${effectiveProject} + global)] `
      : "";

    if (filesWithTimestamps.length === 0) {
      return `${scopePrefix}No daily logs found for period: ${period}`;
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

    return `${scopePrefix}Daily logs for ${period} (${filesWithTimestamps.length} files):\n${content}`;
  }

  const grouped = await memoryManager.listFilesGroupedByMonth(
    effectiveProject,
    listScope,
  );
  const sections: string[] = [];

  if (grouped.project) {
    const projParts: string[] = [];
    const projRoot = formatRootSection(grouped.project.root);
    if (projRoot) projParts.push(projRoot);
    const projMonthly = formatMonthlySection(grouped.project.monthly);
    if (projMonthly) projParts.push(projMonthly);

    if (projParts.length > 0) {
      sections.push(
        `[scope: project/${grouped.project.projectId}]\n${projParts.join("\n\n")}`,
      );
    } else {
      sections.push(
        `[scope: project/${grouped.project.projectId}]\n(no memory files yet)`,
      );
    }
  }

  if (listScope !== "project" || !effectiveProject) {
    const globalParts: string[] = [];
    const globalRoot = formatRootSection(grouped.root);
    if (globalRoot) globalParts.push(globalRoot);
    const globalMonthly = formatMonthlySection(grouped.monthly);
    if (globalMonthly) globalParts.push(globalMonthly);

    if (globalParts.length > 0) {
      const body = globalParts.join("\n\n");
      sections.push(grouped.project ? `[scope: global]\n${body}` : body);
    }
  }

  if (sections.length === 0) {
    return "No memory files found yet.";
  }

  return sections.join("\n\n");
}
