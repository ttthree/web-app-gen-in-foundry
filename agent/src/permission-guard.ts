import path from "node:path";

export type PermissionRequestLike = {
  kind: string;
  fileName?: string;
  path?: string;
  fullCommandText?: string;
  command?: string;
};

export type PermissionDecision = { kind: "approve-once" } | { kind: "reject"; feedback?: string };

const allowedCommandPrefixes = ["mkdir", "ls", "find", "zip", "node", "cat", "test"];
const deniedCommandPattern = /\b(?:npm|pnpm|yarn|bun|curl|wget|nc|python(?:3)?\s+-m\s+http\.server|vite|next|serve|http-server|docker|az|gh)\b|\b(?:env|printenv)\b|\$HOME|~\/|\.ssh|\.npmrc|\.gitconfig/i;

export function createGuardedPermissionHandler(options: { workspacePath: string; skillsPath?: string }) {
  const workspacePath = path.resolve(options.workspacePath);
  const outputPath = path.resolve(workspacePath, "output");
  const skillsPath = options.skillsPath ? path.resolve(options.skillsPath) : undefined;

  return async function guardedPermissionHandler(request: PermissionRequestLike): Promise<PermissionDecision> {
    switch (request.kind) {
      case "read": {
        const targetPath = resolveRequestPath(request, workspacePath);
        if (isInside(targetPath, workspacePath) || (skillsPath && isInside(targetPath, skillsPath))) return { kind: "approve-once" };
        return deny("read outside workspace or skills directory");
      }
      case "write": {
        const targetPath = resolveRequestPath(request, workspacePath);
        if (isInside(targetPath, outputPath)) return { kind: "approve-once" };
        return deny("write outside output directory");
      }
      case "shell": {
        const commandText = request.fullCommandText ?? request.command ?? "";
        if (isAllowedShellCommand(commandText)) return { kind: "approve-once" };
        return deny("shell command is not allowed by static-app policy");
      }
      case "url":
      case "memory":
        return deny(`${request.kind} permission is disabled for generated apps`);
      default:
        return deny(`permission kind ${request.kind} is not allowed by default`);
    }
  };
}

export function isAllowedShellCommand(commandText: string): boolean {
  const trimmed = commandText.trim();
  if (!trimmed || deniedCommandPattern.test(trimmed)) return false;
  const executable = trimmed.split(/\s+/)[0] ?? "";
  return allowedCommandPrefixes.includes(executable);
}

function resolveRequestPath(request: PermissionRequestLike, workspacePath: string): string {
  const requestedPath = request.fileName ?? request.path ?? ".";
  return path.resolve(workspacePath, requestedPath);
}

function isInside(targetPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function deny(reason: string): PermissionDecision {
  return { kind: "reject", feedback: reason };
}
