interface ProjectScopedArgs {
  action?: string;
  target?: string;
  project?: string;
}

export function applyDefaultProject<T extends ProjectScopedArgs>(
  args: T,
  projectId: string | null,
): T {
  if (
    (args.action !== "read" && args.action !== "write") ||
    args.target !== "memory" ||
    args.project !== undefined ||
    !projectId
  ) {
    return args;
  }

  return { ...args, project: projectId };
}
