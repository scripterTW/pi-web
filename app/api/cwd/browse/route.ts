import { posix as posixPath } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  createDirectory,
  getBrowseStartDirectory,
  getParentDirectory,
  listDirectories,
  listWindowsDrives,
  resolveDirectory,
  shouldShowWindowsDrivePicker,
} from "@/lib/directory-browser";
import { getRpcSession } from "@/lib/rpc-manager";
import { openSessionManager, resolveSessionPath } from "@/lib/session-reader";
import { isSftpDirectoryEntry, joinRemotePosixPath, sftpReaddir, sftpStat, withRemoteSftp } from "@/lib/ssh-remote";
import { normalizePosixPath, readSshRemoteState } from "@/lib/ssh-remote-state";

async function resolveSessionSshRemote(sessionId: string | null) {
  if (!sessionId) return null;
  const rpc = getRpcSession(sessionId);
  const liveRpc = rpc?.isAlive() ? rpc : undefined;
  const resolvedPath = liveRpc ? null : await resolveSessionPath(sessionId);
  if (!liveRpc && !resolvedPath) return null;
  const sm = liveRpc?.inner.sessionManager ?? openSessionManager(resolvedPath!);
  return readSshRemoteState(sm.getEntries() as unknown[]);
}

// GET /api/cwd/browse?path=...：列出文件系统中的可讀子目錄（支援 source=remote）。
export async function GET(request: NextRequest) {
  try {
    const source = request.nextUrl.searchParams.get("source");
    const sessionId = request.nextUrl.searchParams.get("sessionId");
    const requested = request.nextUrl.searchParams.get("path")?.trim();

    if (source === "remote") {
      const sshRemote = await resolveSessionSshRemote(sessionId);
      if (!sshRemote || !sshRemote.connected) {
        return NextResponse.json({ error: "No active SSH remote connection for this session" }, { status: 403 });
      }
      const candidate = normalizePosixPath(requested || sshRemote.cwd || "/");
      if (!candidate.startsWith("/")) {
        return NextResponse.json({ error: "Invalid remote path" }, { status: 400 });
      }
      try {
        const result = await withRemoteSftp(sshRemote.command, async (sftp) => {
          const st = await sftpStat(sftp, candidate);
          if (!st.isDirectory) {
            return { error: "Path is not a directory", status: 400 as const };
          }
          const entries = await sftpReaddir(sftp, candidate);
          const dirChecks = await Promise.all(
            entries
              .filter((entry) => entry.filename !== "." && entry.filename !== ".." && !entry.filename.startsWith("."))
              .map(async (entry) => {
                const fullPath = joinRemotePosixPath(candidate, entry.filename);
                const direct = isSftpDirectoryEntry(entry);
                const isDir = direct === null
                  ? await sftpStat(sftp, fullPath).then((s) => s.isDirectory).catch(() => false)
                  : direct;
                return { name: entry.filename, path: fullPath, isDir };
              }),
          );
          const directories = dirChecks
            .filter((item) => item.isDir)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(({ name, path }) => ({ name, path }));
          const parentPath = candidate === "/" ? null : posixPath.dirname(candidate);
          return {
            path: candidate,
            parentPath,
            directories,
          };
        });
        if ("error" in result) {
          return NextResponse.json({ error: result.error }, { status: result.status });
        }
        return NextResponse.json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = /no such file|enoent/i.test(message) ? 404 : 500;
        return NextResponse.json({ error: message }, { status });
      }
    }

    if (shouldShowWindowsDrivePicker(requested)) {
      return NextResponse.json({
        path: "",
        parentPath: null,
        drives: await listWindowsDrives(),
        directories: [],
      });
    }

    const candidate = getBrowseStartDirectory(requested);

    let resolved: string;
    try {
      resolved = await resolveDirectory(candidate);
    } catch {
      return NextResponse.json({ error: "Directory does not exist" }, { status: 404 });
    }

    const directoryStat = await stat(resolved);
    if (!directoryStat.isDirectory()) {
      return NextResponse.json({ error: "Path is not a directory" }, { status: 400 });
    }

    const directories = await listDirectories(resolved);

    return NextResponse.json({
      path: resolved,
      parentPath: getParentDirectory(resolved),
      directories,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/cwd/browse  body: { path: string, name: string }
// Creates one direct child of the currently browsed directory.
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await request.json() as { path?: unknown; name?: unknown };
    const parentPath = typeof body.path === "string" ? body.path.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";

    if (!parentPath) {
      return NextResponse.json({ error: "Parent path is required" }, { status: 400 });
    }
    if (!name) {
      return NextResponse.json({ error: "Directory name is required" }, { status: 400 });
    }

    const createdPath = await createDirectory(parentPath, name);
    return NextResponse.json({ success: true, path: createdPath });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
    if (code === "EEXIST") {
      return NextResponse.json({ error: "A file or directory with this name already exists" }, { status: 409 });
    }
    if (code === "ENOENT") {
      return NextResponse.json({ error: "Parent directory does not exist" }, { status: 404 });
    }
    if (code === "EACCES" || code === "EPERM") {
      return NextResponse.json({ error: "Permission denied" }, { status: 403 });
    }
    if (code === "EINVAL" || code === "ENAMETOOLONG") {
      return NextResponse.json({ error: "Directory name is invalid" }, { status: 400 });
    }
    if (error instanceof Error && (
      error.message === "Directory name must be a single folder name"
      || error.message === "Parent path is not a directory"
    )) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
