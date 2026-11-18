export const SSH_REMOTE_STATE_ENTRY_TYPE = "pi-ssh-remote-state";

export interface SshRemoteState {
  connected: boolean;
  command: string;
  cwd: string;
  routeRemoteTools?: boolean;
  forwards?: string[];
}

interface CustomEntryLike {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}

/**
 * Extract the latest `pi-ssh-remote-state` custom entry from session entries.
 * Returns `null` when no valid SSH remote state is recorded.
 */
export function readSshRemoteState(entries: unknown[]): SshRemoteState | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as CustomEntryLike | null | undefined;
    if (!entry || entry.type !== "custom" || entry.customType !== SSH_REMOTE_STATE_ENTRY_TYPE) {
      continue;
    }
    const data = entry.data as Record<string, unknown> | null | undefined;
    if (!data || typeof data !== "object") continue;
    const command = typeof data.command === "string" ? data.command.trim() : "";
    const cwd = typeof data.cwd === "string" ? data.cwd.trim() : "";
    const connected = Boolean(data.connected);
    if (!command || !cwd) {
      if (!connected) return null;
      continue;
    }
    const forwards = Array.isArray(data.forwards)
      ? data.forwards.filter((item): item is string => typeof item === "string")
      : undefined;
    return {
      connected,
      command,
      cwd: normalizePosixPath(cwd),
      ...(typeof data.routeRemoteTools === "boolean" ? { routeRemoteTools: data.routeRemoteTools } : {}),
      ...(forwards ? { forwards } : {}),
    };
  }
  return null;
}

export function normalizePosixPath(input: string): string {
  const parts = input.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return `/${stack.join("/")}`;
}

/**
 * Verify that `targetPath` is an absolute POSIX path inside (or equal to) `rootCwd`.
 * Rejects relative paths and `..` traversal segments in the raw input.
 */
export function isRemotePathAllowed(targetPath: string, rootCwd: string): boolean {
  if (!targetPath.startsWith("/") || !rootCwd.startsWith("/")) return false;
  if (targetPath.split("/").includes("..")) return false;
  const normalizedTarget = normalizePosixPath(targetPath);
  const normalizedRoot = normalizePosixPath(rootCwd);
  if (normalizedRoot === "/") return true;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

/**
 * Derive a short display label (e.g. `syu01` or `root@host`) from an `ssh ...` command.
 */
export function formatSshRemoteLabel(command: string): string {
  const tokens = command.trim().split(/\s+/);
  const takesArg = new Set(["-p", "-l", "-i", "-J", "-o", "-F", "-b", "-c", "-D", "-E", "-e", "-I", "-L", "-m", "-O", "-Q", "-R", "-S", "-W", "-w"]);
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (takesArg.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    return token;
  }
  return "remote";
}
