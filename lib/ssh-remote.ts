import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { posix as posixPath } from "node:path";
import SSHConfig, { glob as matchesSshHost } from "ssh-config";
import ssh2, { type Client as SshClient, type ClientChannel, type ConnectConfig, type FileEntryWithStats, type SFTPWrapper } from "ssh2";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";
import type { TextPreviewChunk } from "./text-preview";

const { Client, utils: ssh2Utils } = ssh2;

const SSH_HANDSHAKE_TIMEOUT_MS = 20_000;
const SSH_IDLE_TTL_MS = 5 * 60 * 1000;
const MAX_PRIVATE_KEY_BYTES = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;

export interface ParsedSsh {
  host: string;
  port: number;
  username: string;
  identityFile?: string;
  identityFiles: string[];
  agent?: string;
  jumps: Omit<ParsedSsh, "jumps">[];
  label: string;
  command: string;
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escape = false;
  for (const ch of command.trim()) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escape = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) words.push(current);
  return words;
}

function isHomeRelativePath(filePath: string): boolean {
  return filePath === "~" || filePath.startsWith("~/");
}

function loadSshConfig(): SSHConfig {
  const configPath = join(homedir(), ".ssh", "config");
  if (!existsSync(configPath)) return new SSHConfig();
  return SSHConfig.parse(readFileSync(configPath, "utf8"));
}

function sshHostOptions(config: SSHConfig, alias: string): Record<string, string | string[]> {
  const applicable = new SSHConfig();
  for (const line of config) {
    if (line.type !== SSHConfig.DIRECTIVE) continue;
    if (/^Match$/i.test(line.param)) {
      throw new Error("SSH config Match sections are not supported");
    }
    if (/^Host$/i.test(line.param) && "config" in line) {
      const patterns = typeof line.value === "string"
        ? line.value
        : line.value.map((part) => part.val);
      if (matchesSshHost(patterns, alias)) applicable.push(...line.config);
    } else {
      applicable.push(line);
    }
  }
  const options = applicable.compute(alias, { ignoreCase: true, matchExec: false });
  if (options.include !== undefined) {
    throw new Error(`SSH config include is not supported for ${alias}`);
  }
  for (const option of ["proxycommand", "canonicalizehostname"]) {
    const value = options[option];
    if (value !== undefined && value !== "none" && value !== "no") {
      throw new Error(`SSH config ${option} is not supported for ${alias}`);
    }
  }
  return options;
}

function expandSshPath(filePath: string, tokens: Record<string, string>): string {
  const expanded = filePath.replace(/%./g, (token) => {
    const value = tokens[token[1]!];
    if (value === undefined) throw new Error(`Unsupported SSH config token ${token}`);
    return value;
  });
  if (isHomeRelativePath(expanded)) return join(homedir(), expanded.slice(2));
  if (expanded.startsWith("~")) throw new Error(`Unsupported SSH home path: ${expanded}`);
  return resolve(homedir(), expanded);
}

function resolveSshHost(
  config: SSHConfig,
  alias: string,
  command: string,
  overrides: { port?: number; username?: string; identityFile?: string; proxyJump?: string } = {},
  ancestors: string[] = [],
): ParsedSsh {
  const options = sshHostOptions(config, alias);
  const localUser = process.env.USER || process.env.USERNAME || "root";
  const username = overrides.username ?? String(options.user ?? localUser);
  const host = String(options.hostname ?? alias).replace(/%h/g, alias);
  const port = overrides.port ?? Number(options.port ?? 22);
  if (!host || !username || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid SSH host, username or port");
  }
  const routeId = `${username}@${alias}:${port}`;
  if (ancestors.includes(routeId)) {
    throw new Error(`Cyclic SSH ProxyJump: ${[...ancestors, routeId].join(" -> ")}`);
  }
  const tokens = { "%": "%", d: homedir(), h: host, n: alias, p: String(port), r: username, u: localUser };
  const configuredKeys = options.identityfile as string[] | undefined;
  const identityFiles = [...new Set(
    (overrides.identityFile
      ? [overrides.identityFile]
      : configuredKeys ?? ["~/.ssh/id_ed25519", "~/.ssh/id_ecdsa", "~/.ssh/id_rsa"])
      .filter((item) => item !== "none")
      .map((item) => expandSshPath(item, tokens)),
  )];
  const identityAgent = options.identityagent;
  const agent = overrides.identityFile || options.identitiesonly === "yes" || identityAgent === "none"
    ? undefined
    : identityAgent && identityAgent !== "SSH_AUTH_SOCK"
      ? expandSshPath(String(identityAgent), tokens)
      : process.env.SSH_AUTH_SOCK;
  const proxyJump = overrides.proxyJump ?? options.proxyjump;
  const jumps = proxyJump && proxyJump !== "none"
    ? String(proxyJump).split(",").flatMap((value) => {
        const match = value.trim().match(/^(?:([^@\s,]+)@)?(\[[^\]\s]+\]|[^:@\s,]+)(?::(\d+))?$/);
        if (!match) throw new Error(`Invalid SSH jump host: ${value}`);
        const hop = resolveSshHost(
          config,
          match[2]!.replace(/^\[|\]$/g, ""),
          `ssh ${value}`,
          {
            username: match[1],
            port: match[3] === undefined ? undefined : Number(match[3]),
          },
          [...ancestors, routeId],
        );
        const { jumps: preceding, ...destination } = hop;
        return [...preceding, destination];
      })
    : [];

  return {
    host,
    port,
    username,
    ...(overrides.identityFile ? { identityFile: identityFiles[0] } : {}),
    identityFiles,
    ...(agent ? { agent } : {}),
    jumps,
    label: `${username}@${host}:${port}`,
    command,
  };
}

export function parseSshCommand(command: string): ParsedSsh {
  const args = shellWords(command);
  if (args[0] !== "ssh") {
    throw new Error("Command must start with ssh");
  }
  let port: number | undefined;
  let username: string | undefined;
  let identityFile: string | undefined;
  let target: string | undefined;
  let proxyJump: string | undefined;

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "-p") {
      port = Number(args[++i]);
      continue;
    }
    if (arg === "-l") {
      username = args[++i];
      continue;
    }
    if (arg === "-i") {
      identityFile = args[++i];
      continue;
    }
    if (arg === "-J") {
      proxyJump = args[++i];
      continue;
    }
    if (arg === "-o") {
      const option = args[++i] ?? "";
      const match = option.match(/^ProxyJump=(.+)$/i);
      if (match) proxyJump = match[1];
      continue;
    }
    if (arg.startsWith("-")) continue;
    target = arg;
    break;
  }

  if (!target) throw new Error("Missing SSH host in command");
  const targetMatch = target.match(/^(?:([^@\s]+)@)?(\[[^\]\s]+\]|[^:@\s]+)$/);
  if (!targetMatch) throw new Error(`Unsupported SSH target: ${target}`);

  const config = loadSshConfig();
  return resolveSshHost(config, targetMatch[2]!.replace(/^\[|\]$/g, ""), command, {
    port,
    username: username ?? targetMatch[1],
    identityFile,
    proxyJump,
  });
}

function loadKnownHosts(): Record<string, string> {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const knownHostsPath = join(agentDir, "ssh-remote-known-hosts.json");
  if (!existsSync(knownHostsPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(knownHostsPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function hostKeyId(host: string, port: number): string {
  return `${host}:${port}`;
}

function readPrivateKeyBuffer(filePath: string): Buffer | null {
  if (!existsSync(filePath)) return null;
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_PRIVATE_KEY_BYTES) return null;
  try {
    const keyData = readFileSync(filePath);
    const parsed = ssh2Utils.parseKey(keyData);
    if (parsed instanceof Error) return null;
    return keyData;
  } catch {
    return null;
  }
}

function connectHop(
  hop: Omit<ParsedSsh, "jumps">,
  knownHosts: Record<string, string>,
  sock?: ClientChannel,
): Promise<SshClient> {
  const expectedFingerprint = knownHosts[hostKeyId(hop.host, hop.port)];
  const authCandidates: Partial<Pick<ConnectConfig, "agent" | "privateKey">>[] = [];

  if (hop.identityFile) {
    const keyData = readPrivateKeyBuffer(hop.identityFile);
    if (!keyData) {
      return Promise.reject(new Error(`SSH identity file unavailable or encrypted: ${hop.identityFile}`));
    }
    authCandidates.push({ privateKey: keyData });
  } else {
    if (hop.agent) authCandidates.push({ agent: hop.agent });
    for (const filePath of hop.identityFiles) {
      const keyData = readPrivateKeyBuffer(filePath);
      if (keyData) authCandidates.push({ privateKey: keyData });
    }
  }

  if (authCandidates.length === 0) {
    return Promise.reject(new Error(`No non-interactive SSH credentials available for ${hop.label}`));
  }

  const tryAuth = (auth: Partial<Pick<ConnectConfig, "agent" | "privateKey">>, stream?: ClientChannel): Promise<SshClient> =>
    new Promise((resolvePromise, rejectPromise) => {
      const client = new Client();
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.destroy();
        rejectPromise(err);
      };
      const timer = setTimeout(() => fail(new Error(`SSH connection to ${hop.label} timed out`)), SSH_HANDSHAKE_TIMEOUT_MS);

      client.once("ready", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(client);
      });
      client.on("error", (err) => fail(err));
      client.once("close", () => fail(new Error(`SSH connection closed before ready (${hop.label})`)));

      const options: ConnectConfig = {
        ...(stream ? { sock: stream } : {}),
        host: hop.host,
        port: hop.port,
        username: hop.username,
        ...auth,
        readyTimeout: SSH_HANDSHAKE_TIMEOUT_MS,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
        hostHash: "sha256",
        hostVerifier: (hash: string) => {
          if (!expectedFingerprint) return false;
          return hash === expectedFingerprint;
        },
      };

      try {
        client.connect(options);
      } catch (err) {
        fail(err as Error);
      }
    });

  return (async () => {
    if (!expectedFingerprint) {
      throw new Error(`SSH host ${hostKeyId(hop.host, hop.port)} is not in pi-ssh-remote known hosts`);
    }
    let lastError: Error = new Error(`SSH authentication failed for ${hop.label}`);
    for (let i = 0; i < authCandidates.length; i += 1) {
      if (i > 0 && sock) {
        throw lastError;
      }
      try {
        return await tryAuth(authCandidates[i]!, i === 0 ? sock : undefined);
      } catch (err) {
        const failure = err as Error & { level?: string };
        lastError = failure;
        if (failure.level !== "client-authentication" && failure.level !== "agent") {
          throw failure;
        }
      }
    }
    throw lastError;
  })();
}

function forwardOut(client: SshClient, target: Omit<ParsedSsh, "jumps">): Promise<ClientChannel> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`SSH jump forwarding to ${target.label} timed out`)), SSH_HANDSHAKE_TIMEOUT_MS);
    client.forwardOut("127.0.0.1", 0, target.host, target.port, (err, stream) => {
      clearTimeout(timer);
      if (err) rejectPromise(err);
      else resolvePromise(stream);
    });
  });
}

async function openSshClient(command: string): Promise<{ client: SshClient; jumps: SshClient[] }> {
  const parsed = parseSshCommand(command);
  const knownHosts = loadKnownHosts();
  const jumpClients: SshClient[] = [];
  let sock: ClientChannel | undefined;

  try {
    for (const hop of parsed.jumps) {
      const jumpClient = await connectHop(hop, knownHosts, sock);
      jumpClients.push(jumpClient);
      const nextTarget = parsed.jumps[jumpClients.length] ?? parsed;
      sock = await forwardOut(jumpClient, nextTarget);
    }
    const client = await connectHop(parsed, knownHosts, sock);
    return { client, jumps: jumpClients };
  } catch (err) {
    sock?.destroy();
    for (const jc of jumpClients) jc.end();
    throw err;
  }
}

function openSftp(client: SshClient): Promise<SFTPWrapper> {
  return new Promise((resolvePromise, rejectPromise) => {
    client.sftp((err, sftp) => {
      if (err) rejectPromise(err);
      else resolvePromise(sftp);
    });
  });
}

interface PoolEntry {
  client: SshClient;
  jumps: SshClient[];
  sftp: SFTPWrapper;
  idleTimer?: ReturnType<typeof setTimeout>;
  ready: boolean;
}

class SshRemotePool {
  private entries = new Map<string, PoolEntry>();
  private connecting = new Map<string, Promise<PoolEntry>>();

  private dispose(key: string): void {
    const existing = this.entries.get(key);
    if (!existing) return;
    this.entries.delete(key);
    if (existing.idleTimer) clearTimeout(existing.idleTimer);
    existing.ready = false;
    try { existing.sftp.end(); } catch { /* ignore */ }
    try { existing.client.end(); } catch { /* ignore */ }
    for (const jump of existing.jumps) {
      try { jump.end(); } catch { /* ignore */ }
    }
  }

  private touch(key: string, entry: PoolEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      this.dispose(key);
    }, SSH_IDLE_TTL_MS);
    entry.idleTimer.unref?.();
  }

  private async getEntry(command: string): Promise<PoolEntry> {
    const key = command.trim();
    const existing = this.entries.get(key);
    if (existing?.ready) {
      this.touch(key, existing);
      return existing;
    }
    const inflight = this.connecting.get(key);
    if (inflight) return inflight;

    const promise = (async () => {
      const { client, jumps } = await openSshClient(key);
      const sftp = await openSftp(client);
      const entry: PoolEntry = { client, jumps, sftp, ready: true };
      const cleanup = () => this.dispose(key);
      client.once("close", cleanup);
      client.once("error", cleanup);
      sftp.once("close", cleanup);
      sftp.once("error", cleanup);
      this.entries.set(key, entry);
      this.touch(key, entry);
      return entry;
    })();

    this.connecting.set(key, promise);
    try {
      return await promise;
    } finally {
      this.connecting.delete(key);
    }
  }

  async withSftp<T>(command: string, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const key = command.trim();
    const entry = await this.getEntry(key);
    try {
      this.touch(key, entry);
      return await fn(entry.sftp);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/not connected|channel closed|socket closed|destroyed/i.test(message)) {
        this.dispose(key);
      }
      throw err;
    }
  }
}

declare global {
  var __piWebSshPool: SshRemotePool | undefined;
}

function getPool(): SshRemotePool {
  if (!globalThis.__piWebSshPool) {
    globalThis.__piWebSshPool = new SshRemotePool();
  }
  return globalThis.__piWebSshPool;
}

export async function withRemoteSftp<T>(command: string, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  return getPool().withSftp(command, fn);
}

export interface RemoteStat {
  size: number;
  mtimeMs: number;
  mtime: Date;
  isFile: boolean;
  isDirectory: boolean;
}

export function sftpStat(sftp: SFTPWrapper, filePath: string): Promise<RemoteStat> {
  return new Promise((resolvePromise, rejectPromise) => {
    sftp.stat(filePath, (err, stats) => {
      if (err) {
        rejectPromise(err);
        return;
      }
      resolvePromise({
        size: stats.size ?? 0,
        mtimeMs: (stats.mtime ?? 0) * 1000,
        mtime: new Date((stats.mtime ?? 0) * 1000),
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
      });
    });
  });
}

export function sftpReaddir(sftp: SFTPWrapper, dirPath: string): Promise<FileEntryWithStats[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    sftp.readdir(dirPath, (err, list) => {
      if (err) rejectPromise(err);
      else resolvePromise(list ?? []);
    });
  });
}

export function sftpReadRange(
  sftp: SFTPWrapper,
  filePath: string,
  start: number,
  length: number,
): Promise<Buffer> {
  if (length <= 0) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    const stream = sftp.createReadStream(filePath, {
      start,
      end: start + length - 1,
    });
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.once("error", rejectPromise);
    stream.once("end", () => resolvePromise(Buffer.concat(chunks)));
  });
}

export function sftpReadFileBuffer(
  sftp: SFTPWrapper,
  filePath: string,
  maxBytes?: number,
): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const stream = sftp.createReadStream(filePath);
    stream.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (maxBytes !== undefined && total > maxBytes) {
        stream.destroy(new Error(`Remote file exceeds limit (${maxBytes} bytes)`));
        return;
      }
      chunks.push(chunk);
    });
    stream.once("error", rejectPromise);
    stream.once("end", () => resolvePromise(Buffer.concat(chunks)));
  });
}

function utf8SequenceLength(byte: number): number {
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 1;
}

function looksBinary(buffer: Buffer, length: number): boolean {
  if (length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))) {
    return false;
  }
  return buffer.subarray(0, Math.min(length, BINARY_SNIFF_BYTES)).includes(0);
}

export async function readRemoteTextPreviewChunk(
  sftp: SFTPWrapper,
  filePath: string,
  fileSize: number,
  offset: number,
): Promise<TextPreviewChunk> {
  if (fileSize === 0 || offset >= fileSize) {
    return { content: "", nextOffset: fileSize, truncated: false, binary: false };
  }
  const length = Math.min(TEXT_PREVIEW_MAX_BYTES + 1, fileSize - offset);
  const header = offset === 0 ? null : await sftpReadRange(sftp, filePath, 0, Math.min(2, fileSize));
  const buffer = await sftpReadRange(sftp, filePath, offset, length);
  const bytesRead = buffer.length;
  const bomBytes = header ?? buffer;

  if (offset === 0 && looksBinary(buffer, bytesRead)) {
    return { content: "", nextOffset: 0, truncated: false, binary: true };
  }

  let end = Math.min(bytesRead, TEXT_PREVIEW_MAX_BYTES);
  const utf16 = bomBytes.length >= 2 && bomBytes[0] === 0xff && bomBytes[1] === 0xfe
    ? "utf-16le"
    : bomBytes.length >= 2 && bomBytes[0] === 0xfe && bomBytes[1] === 0xff
      ? "utf-16be"
      : null;

  if (utf16 && offset + end < fileSize) {
    end -= end % 2;
    if (end >= 2) {
      const last = utf16 === "utf-16le" ? buffer.readUInt16LE(end - 2) : buffer.readUInt16BE(end - 2);
      if (last >= 0xd800 && last <= 0xdbff) end -= 2;
    }
  } else if (!utf16 && offset + end < fileSize) {
    let i = end;
    while (i > 0 && (buffer[i - 1]! & 0xc0) === 0x80) i -= 1;
    if (i > 0 && i < end) {
      const lead = buffer[i - 1]!;
      const expected = utf8SequenceLength(lead);
      if (i - 1 + expected > end) end = i - 1;
    }
  }

  const slice = buffer.subarray(0, end);
  let content: string;
  if (utf16 === "utf-16le") {
    content = slice.toString("utf16le");
  } else if (utf16 === "utf-16be") {
    const swapped = Buffer.from(slice);
    swapped.swap16();
    content = swapped.toString("utf16le");
  } else {
    content = slice.toString("utf8");
  }
  if (offset === 0 && content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }

  const nextOffset = offset + end;
  return {
    content,
    nextOffset,
    truncated: nextOffset < fileSize,
    binary: false,
  };
}

export function isSftpDirectoryEntry(entry: FileEntryWithStats): boolean | null {
  const mode = entry.attrs?.mode ?? 0;
  const typeBits = mode & 0o170000;
  if (typeBits === 0o040000) return true;
  if (typeBits === 0o100000) return false;
  if (typeBits === 0o120000) return null; // symlink: needs stat fallback
  return entry.longname?.startsWith("d") ? true : entry.longname?.startsWith("-") ? false : null;
}

export function joinRemotePosixPath(dirPath: string, name: string): string {
  return posixPath.join(dirPath, name);
}
