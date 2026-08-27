import { randomUUID } from 'node:crypto';
import { mkdir as mkdirLocal, readdir as readdirLocal, stat as statLocal } from 'node:fs/promises';
import { join as joinLocalPath } from 'node:path';
import { Client, type ClientChannel, type FileEntryWithStats, type SFTPWrapper, type Stats } from 'ssh2';
import type { ServerConfig } from '../config/schema';
import { buildSshConnectionHandle, type HostKeyVerifier, type SshConnectionHandle } from '../ssh/SshConnectionConfig';
import { runWithConcurrency } from './concurrency';
import { joinRemotePath, quotePosixShellPath, safePreviewName } from './RemotePath';
import { SftpConflictError } from './SftpErrors';
import type { TransferProgress } from './TransferService';
import type { PasswordSource, SftpEntry, SftpEntryType, SftpFileStat } from './SftpTypes';

const SFTP_WRITE_STEP_TIMEOUT_MS = 55_000;
const REMOTE_TEMP_CLEANUP_TIMEOUT_MS = 2_000;
/** How many files a recursive directory transfer keeps in flight. */
export const DIRECTORY_TRANSFER_CONCURRENCY = 4;
/** Chunk size for streamed reads/writes over the SFTP channel. */
export const SFTP_CHUNK_BYTES = 32_768;
/**
 * How many 32KiB read/write requests stay in flight per file. Sequential request/response
 * spends a full round trip per chunk; a sliding window this deep hides most of the latency
 * on high-RTT links without flooding the channel.
 */
export const SFTP_PIPELINE_DEPTH = 8;

export interface SftpUploadOptions {
  /**
   * Replace an existing remote entry instead of raising {@link SftpConflictError}.
   * Uploads never overwrite silently by default.
   */
  overwrite?: boolean;
}

export interface SftpSessionOptions {
  /**
   * Retry a permission-denied write through `sudo -n`. Only user-driven UI flows may enable
   * this: the escalation turns "the agent may write where the login user can" into "the agent
   * may write anywhere", and it does so without a second prompt.
   */
  allowSudoFallback: boolean;
}

export class SftpSession {
  private client: Client | undefined;
  private sftp: SFTPWrapper | undefined;
  private connectionHandle: SshConnectionHandle | undefined;

  constructor(
    private readonly server: ServerConfig,
    private readonly passwords: PasswordSource,
    private readonly hostKeyVerifier: HostKeyVerifier,
    private readonly options: SftpSessionOptions
  ) {}

  async connect(): Promise<void> {
    const client = new Client();
    this.client = client;
    const handle = await buildSshConnectionHandle(this.server, this.passwords, this.hostKeyVerifier);
    this.connectionHandle = handle;

    try {
      await new Promise<void>((resolve, reject) => {
        client.once('ready', resolve);
        client.once('error', reject);
        client.connect(handle.config);
      });

      this.sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((error, sftp) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(sftp);
        });
      });
    } catch (error) {
      client.end();
      handle.dispose();
      this.connectionHandle = undefined;
      throw error;
    }
  }

  isConnected(): boolean {
    return Boolean(this.client && this.sftp);
  }

  async realpath(path = '.'): Promise<string> {
    const sftp = this.requireSftp();
    return await new Promise<string>((resolve, reject) => {
      sftp.realpath(path, (error, resolved) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(resolved);
      });
    });
  }

  async listDirectory(path: string): Promise<SftpEntry[]> {
    const entries = await this.readEntries(path);
    // Resolve what each symlink points at so the tree can keep symlinked directories
    // expandable. stat() follows links server-side; a dangling link keeps targetType
    // undefined and is treated as a plain file.
    const symlinks = entries.filter((entry) => entry.type === 'symlink');
    await runWithConcurrency(symlinks, DIRECTORY_TRANSFER_CONCURRENCY, async (entry) => {
      const stats = await this.statOrUndefined(entry.path);
      if (stats) {
        entry.targetType = isDirectoryStats(stats) ? 'directory' : 'file';
        // The readdir row carries the link's own attributes; the target's size and mtime are
        // what the tree shows and what a download transfers.
        entry.size = stats.size;
        entry.modifiedAt = stats.mtime;
      }
    });
    return entries;
  }

  private async readEntries(path: string): Promise<SftpEntry[]> {
    const sftp = this.requireSftp();
    const rows = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
      sftp.readdir(path, (error, list) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(list);
      });
    });

    return rows.map((row) => ({
      name: row.filename,
      path: appendRemoteChild(path, row.filename),
      type: entryType(row),
      size: row.attrs.size,
      modifiedAt: row.attrs.mtime
    }));
  }

  async stat(path: string): Promise<SftpFileStat> {
    const attrs = await this.statRaw(path);
    return {
      size: attrs.size,
      modifiedAt: attrs.mtime
    };
  }

  private async statRaw(path: string): Promise<Stats> {
    const sftp = this.requireSftp();
    return await new Promise<Stats>((resolve, reject) => {
      sftp.stat(path, (error, stat) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stat);
      });
    });
  }

  /**
   * stat that treats every failure as "not there". Conflict checks must not turn a
   * permission-restricted stat into a hard error: the subsequent write surfaces the real
   * problem with a far better message.
   */
  private async statOrUndefined(path: string): Promise<Stats | undefined> {
    try {
      return await this.statRaw(path);
    } catch {
      return undefined;
    }
  }

  async mkdir(path: string): Promise<void> {
    const sftp = this.requireSftp();
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(path, (error) => (error ? reject(error) : resolve()));
    });
  }

  async createFile(path: string): Promise<void> {
    const sftp = this.requireSftp();
    try {
      await createEmptyFile(sftp, path);
    } catch (error) {
      if (!isPermissionDeniedError(error)) {
        throw error;
      }
      await this.writeFile(path, Buffer.alloc(0));
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const sftp = this.requireSftp();
    await new Promise<void>((resolve, reject) => {
      sftp.rename(oldPath, newPath, (error) => (error ? reject(error) : resolve()));
    });
  }

  async deleteFile(path: string): Promise<void> {
    const sftp = this.requireSftp();
    await new Promise<void>((resolve, reject) => {
      sftp.unlink(path, (error) => (error ? reject(error) : resolve()));
    });
  }

  /**
   * Recursive delete: children first (symlinks are unlinked, never followed), then the
   * directory itself. Non-empty directories therefore no longer fail with a bare rmdir error.
   */
  async deleteDirectory(path: string): Promise<void> {
    const entries = await this.readEntries(path);
    for (const entry of entries) {
      if (entry.type === 'directory') {
        await this.deleteDirectory(entry.path);
      } else {
        await this.deleteFile(entry.path);
      }
    }
    await this.rmdir(path);
  }

  /**
   * Dry run for {@link deleteDirectory}: how many filesystem entries the delete would remove,
   * including the directory itself (an empty directory counts 1). The UI uses this for the
   * "N entries" confirmation before a recursive delete.
   */
  async countDeletableEntries(path: string): Promise<number> {
    const entries = await this.readEntries(path);
    let count = 1;
    for (const entry of entries) {
      count += entry.type === 'directory' ? await this.countDeletableEntries(entry.path) : 1;
    }
    return count;
  }

  private async rmdir(path: string): Promise<void> {
    const sftp = this.requireSftp();
    await new Promise<void>((resolve, reject) => {
      sftp.rmdir(path, (error) => (error ? reject(error) : resolve()));
    });
  }

  async uploadFile(
    localPath: string,
    remotePath: string,
    progress?: TransferProgress,
    options?: SftpUploadOptions
  ): Promise<void> {
    const sftp = this.requireSftp();
    if (!options?.overwrite && (await this.statOrUndefined(remotePath))) {
      throw new SftpConflictError(remotePath);
    }
    try {
      await this.fastPut(sftp, localPath, remotePath, progress);
    } catch (error) {
      if (!isPermissionDeniedError(error)) {
        throw error;
      }
      if (!this.options.allowSudoFallback) {
        throw new Error(escalationDisabledMessage('upload', remotePath, error));
      }
      await this.uploadFileWithSudo(localPath, remotePath, progress, error);
    }
  }

  /**
   * Recursively uploads a local directory. Remote directories are created parents-first, then
   * files transfer with {@link DIRECTORY_TRANSFER_CONCURRENCY} in flight; `progress` receives
   * byte totals aggregated across the whole tree. Local symlinks and special files are
   * skipped. Uploading over an existing remote directory raises {@link SftpConflictError}
   * unless `overwrite` is set; a denied write fails outright (no per-file sudo fallback).
   */
  async uploadDirectory(
    localDir: string,
    remoteDir: string,
    progress?: TransferProgress,
    options?: SftpUploadOptions
  ): Promise<void> {
    const sftp = this.requireSftp();
    if (!options?.overwrite && (await this.statOrUndefined(remoteDir))) {
      throw new SftpConflictError(remoteDir);
    }
    const plan = await walkLocalDirectory(localDir);
    await this.ensureRemoteDirectory(remoteDir);
    for (const relativeDir of plan.directories) {
      await this.ensureRemoteDirectory(joinRemotePath(remoteDir, relativeDir));
    }
    const totalBytes = plan.files.reduce((sum, file) => sum + file.size, 0);
    const aggregate = createAggregatedProgress(totalBytes, progress);
    await runWithConcurrency(plan.files, DIRECTORY_TRANSFER_CONCURRENCY, async (file) => {
      const item = aggregate.beginItem(file.size);
      await this.fastPut(sftp, file.localPath, joinRemotePath(remoteDir, file.relativePath), item.progress);
      item.complete();
    });
  }

  /**
   * Recursively downloads a remote directory. Files transfer with
   * {@link DIRECTORY_TRANSFER_CONCURRENCY} in flight and `progress` aggregates bytes across
   * the tree. Symlinks to files are followed (downloaded as their target); symlinked
   * directories are not descended into, because a link at an ancestor would recurse forever.
   */
  async downloadDirectory(remoteDir: string, localDir: string, progress?: TransferProgress): Promise<void> {
    const sftp = this.requireSftp();
    await mkdirLocal(localDir, { recursive: true });
    const files: Array<{ remotePath: string; localPath: string; size: number }> = [];
    const queue: Array<{ remote: string; local: string }> = [{ remote: remoteDir, local: localDir }];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const entries = await this.listDirectory(current.remote);
      for (const entry of entries) {
        const localPath = joinLocalPath(current.local, entry.name);
        if (entry.type === 'directory') {
          await mkdirLocal(localPath, { recursive: true });
          queue.push({ remote: entry.path, local: localPath });
        } else if (entry.type === 'file' || entry.targetType === 'file') {
          files.push({ remotePath: entry.path, localPath, size: entry.size ?? 0 });
        }
      }
    }
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const aggregate = createAggregatedProgress(totalBytes, progress);
    await runWithConcurrency(files, DIRECTORY_TRANSFER_CONCURRENCY, async (file) => {
      const item = aggregate.beginItem(file.size);
      await this.fastGet(sftp, file.remotePath, file.localPath, item.progress);
      item.complete();
    });
  }

  private async ensureRemoteDirectory(path: string): Promise<void> {
    try {
      await this.mkdir(path);
    } catch (error) {
      // Overwriting into an existing tree makes "already exists" expected; anything that is
      // not an existing directory keeps the original mkdir error.
      const stats = await this.statOrUndefined(path);
      if (!stats || !isDirectoryStats(stats)) {
        throw error;
      }
    }
  }

  private async fastPut(
    sftp: SFTPWrapper,
    localPath: string,
    remotePath: string,
    progress?: TransferProgress
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(
        localPath,
        remotePath,
        {
          step: (transferredBytes, _chunkBytes, totalBytes) =>
            progress?.report({ transferredBytes, totalBytes })
        },
        (error) => (error ? reject(error) : resolve())
      );
    });
  }

  private async uploadFileWithSudo(
    localPath: string,
    remotePath: string,
    progress: TransferProgress | undefined,
    permissionError: unknown
  ): Promise<void> {
    const sftp = this.requireSftp();
    const tempPath = `/tmp/at-terminal-upload-${randomUUID()}-${safePreviewName(remotePath)}`;
    try {
      await this.fastPut(sftp, localPath, tempPath, progress);
      await this.execSudoOverwrite(tempPath, remotePath);
    } catch (sudoError) {
      await tryRemoveRemoteTempFile(sftp, tempPath);
      throw new Error(
        `SFTP upload to ${remotePath} failed with permission denied, and sudo fallback failed: ${errorMessage(sudoError)}. Original error: ${errorMessage(permissionError)}`
      );
    }
  }

  private async execSudoOverwrite(tempPath: string, remotePath: string): Promise<void> {
    const client = this.requireClient();
    const script = `set -e; cat ${quotePosixShellPath(tempPath)} > ${quotePosixShellPath(remotePath)}; rm -f ${quotePosixShellPath(tempPath)}`;
    const command = `sudo -n sh -c ${quotePosixShellPath(script)}`;
    await withTimeout(
      new Promise<string>((resolve, reject) => {
        client.exec(command, (error, stream) => {
          if (error) {
            reject(error);
            return;
          }
          collectExecResult(stream, resolve, reject);
        });
      }),
      SFTP_WRITE_STEP_TIMEOUT_MS,
      `SFTP sudo fallback timed out after ${SFTP_WRITE_STEP_TIMEOUT_MS}ms while writing ${remotePath}.`
    );
  }

  async downloadFile(remotePath: string, localPath: string, progress?: TransferProgress): Promise<void> {
    const sftp = this.requireSftp();
    await this.fastGet(sftp, remotePath, localPath, progress);
  }

  private async fastGet(
    sftp: SFTPWrapper,
    remotePath: string,
    localPath: string,
    progress?: TransferProgress
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      sftp.fastGet(
        remotePath,
        localPath,
        {
          step: (transferredBytes, _chunkBytes, totalBytes) =>
            progress?.report({ transferredBytes, totalBytes })
        },
        (error) => (error ? reject(error) : resolve())
      );
    });
  }

  /**
   * Reads up to `maxBytes` starting at `offset`; a negative offset counts back from the end
   * of the file (tail). Chunks are requested through a sliding window of
   * {@link SFTP_PIPELINE_DEPTH} in-flight 32KiB reads so throughput is no longer bounded by
   * one round trip per chunk.
   */
  async readFile(path: string, maxBytes: number, offset = 0): Promise<Buffer> {
    const sftp = this.requireSftp();
    const handle = await new Promise<Buffer>((resolve, reject) => {
      sftp.open(path, 'r', (error, fileHandle) => (error ? reject(error) : resolve(fileHandle)));
    });
    try {
      const size = await fstatSize(sftp, handle);
      const start = offset >= 0 ? offset : Math.max(0, size + offset);
      const end = Math.min(size, start + Math.max(0, maxBytes));
      if (end <= start) {
        return Buffer.alloc(0);
      }
      const result = Buffer.alloc(end - start);
      const chunks: Array<{ position: number; length: number }> = [];
      for (let position = start; position < end; position += SFTP_CHUNK_BYTES) {
        chunks.push({ position, length: Math.min(SFTP_CHUNK_BYTES, end - position) });
      }
      // The file can shrink between fstat and the reads; the shortest read marks where the
      // remaining bytes stop being trustworthy.
      let shortReadEnd = end;
      await runWithConcurrency(chunks, SFTP_PIPELINE_DEPTH, async (chunk) => {
        let filled = 0;
        while (filled < chunk.length) {
          const bytesRead = await new Promise<number>((resolve, reject) => {
            sftp.read(
              handle,
              result,
              chunk.position - start + filled,
              chunk.length - filled,
              chunk.position + filled,
              (error, read) => (error ? reject(error) : resolve(read))
            );
          });
          if (bytesRead <= 0) {
            shortReadEnd = Math.min(shortReadEnd, chunk.position + filled);
            return;
          }
          filled += bytesRead;
        }
      });
      return shortReadEnd >= end ? result : result.subarray(0, Math.max(0, shortReadEnd - start));
    } finally {
      await closeRemoteHandle(sftp, handle).catch(() => undefined);
    }
  }

  async writeFile(path: string, content: Buffer): Promise<void> {
    const sftp = this.requireSftp();
    try {
      await writeBuffer(sftp, path, content);
    } catch (error) {
      if (!isPermissionDeniedError(error)) {
        throw error;
      }
      if (!this.options.allowSudoFallback) {
        throw new Error(escalationDisabledMessage('write', path, error));
      }
      const tempPath = `/tmp/at-terminal-write-${randomUUID()}-${safePreviewName(path)}`;
      try {
        await writeBuffer(sftp, tempPath, content);
        await this.execSudoOverwrite(tempPath, path);
      } catch (sudoError) {
        await tryRemoveRemoteTempFile(sftp, tempPath);
        throw new Error(
          `SFTP write to ${path} failed with permission denied, and sudo fallback failed: ${errorMessage(sudoError)}. Original error: ${errorMessage(error)}`
        );
      }
    }
  }

  dispose(): void {
    this.sftp = undefined;
    this.client?.end();
    this.connectionHandle?.dispose();
    this.client = undefined;
    this.connectionHandle = undefined;
  }

  private requireSftp(): SFTPWrapper {
    if (!this.sftp) {
      throw new Error('SFTP connection is not available.');
    }
    return this.sftp;
  }

  private requireClient(): Client {
    if (!this.client) {
      throw new Error('SSH connection is not available.');
    }
    return this.client;
  }
}

function collectExecResult(
  stream: ClientChannel,
  resolve: (stderr: string) => void,
  reject: (error: Error) => void
): void {
  const stderrChunks: Buffer[] = [];
  stream.stderr.on('data', (data: Buffer) => stderrChunks.push(data));
  stream.once('error', reject);
  stream.once('close', (code: number | null) => {
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    if (code && code !== 0) {
      reject(new Error(stderr.trim() || `sudo fallback exited with code ${code}`));
      return;
    }
    resolve(stderr);
  });
}

function escalationDisabledMessage(operation: 'write' | 'upload', remotePath: string, error: unknown): string {
  return (
    `SFTP ${operation} to ${remotePath} failed with permission denied. ` +
    'Privilege escalation is disabled for agent SFTP sessions. ' +
    `Use the AT Terminal SFTP view if this really has to be written as root. Original error: ${errorMessage(error)}`
  );
}

function isPermissionDeniedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === 3 || (typeof candidate.message === 'string' && /permission denied|eacces/i.test(candidate.message));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? message : String(error);
  }
  return String(error);
}

async function removeRemoteTempFile(sftp: SFTPWrapper, tempPath: string): Promise<void> {
  await new Promise<void>((resolve) => {
    sftp.unlink(tempPath, () => resolve());
  });
}

async function tryRemoveRemoteTempFile(sftp: SFTPWrapper, tempPath: string): Promise<void> {
  await withTimeout(
    removeRemoteTempFile(sftp, tempPath),
    REMOTE_TEMP_CLEANUP_TIMEOUT_MS,
    `Timed out removing remote temp file ${tempPath}.`
  ).catch(() => undefined);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function writeBuffer(sftp: SFTPWrapper, path: string, content: Buffer): Promise<void> {
  const handle = await withTimeout(
    new Promise<Buffer>((resolve, reject) => {
      sftp.open(path, 'w', (error, fileHandle) => (error ? reject(error) : resolve(fileHandle)));
    }),
    SFTP_WRITE_STEP_TIMEOUT_MS,
    `SFTP open timed out after ${SFTP_WRITE_STEP_TIMEOUT_MS}ms while writing ${path}.`
  );
  let failed = false;
  try {
    const chunks: Array<{ position: number; length: number }> = [];
    for (let position = 0; position < content.byteLength; position += SFTP_CHUNK_BYTES) {
      chunks.push({ position, length: Math.min(SFTP_CHUNK_BYTES, content.byteLength - position) });
    }
    // Chunks land at fixed, non-overlapping offsets, so completing them out of order through
    // the sliding window is safe.
    await runWithConcurrency(chunks, SFTP_PIPELINE_DEPTH, async (chunk) => {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          sftp.write(handle, content, chunk.position, chunk.length, chunk.position, (error?: Error | null) =>
            error ? reject(error) : resolve()
          );
        }),
        SFTP_WRITE_STEP_TIMEOUT_MS,
        `SFTP write timed out after ${SFTP_WRITE_STEP_TIMEOUT_MS}ms while writing ${path} at offset ${chunk.position}.`
      );
    });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (failed) {
      void closeRemoteHandle(sftp, handle).catch(() => undefined);
    } else {
      await withTimeout(
        closeRemoteHandle(sftp, handle),
        SFTP_WRITE_STEP_TIMEOUT_MS,
        `SFTP close timed out after ${SFTP_WRITE_STEP_TIMEOUT_MS}ms while writing ${path}.`
      );
    }
  }
}

async function closeRemoteHandle(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.close(handle, (error) => (error ? reject(error) : resolve()));
  });
}

async function createEmptyFile(sftp: SFTPWrapper, path: string): Promise<void> {
  const handle = await new Promise<Buffer>((resolve, reject) => {
    sftp.open(path, 'wx', (error, fileHandle) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(fileHandle);
    });
  });
  await new Promise<void>((resolve, reject) => {
    sftp.close(handle, (error) => (error ? reject(error) : resolve()));
  });
}

function appendRemoteChild(parent: string, child: string): string {
  const normalizedParent = parent === '/' ? '' : parent.replace(/\/+$/, '');
  return `${normalizedParent}/${child}`;
}

function entryType(row: FileEntryWithStats): SftpEntryType {
  if (row.attrs.isDirectory()) {
    return 'directory';
  }
  if (row.attrs.isSymbolicLink()) {
    return 'symlink';
  }
  return 'file';
}

function isDirectoryStats(stats: Stats): boolean {
  return typeof stats.isDirectory === 'function' && stats.isDirectory();
}

async function fstatSize(sftp: SFTPWrapper, handle: Buffer): Promise<number> {
  const stats = await new Promise<Stats>((resolve, reject) => {
    sftp.fstat(handle, (error, result) => (error ? reject(error) : resolve(result)));
  });
  return stats.size;
}

interface LocalDirectoryPlan {
  /** Relative directory paths using '/' separators, parents before children. */
  directories: string[];
  files: Array<{ localPath: string; relativePath: string; size: number }>;
}

/**
 * Breadth-first walk so parent directories always precede their children in the plan.
 * Symlinks and special files are skipped: following local links could recurse forever and
 * SFTP uploads of device nodes make no sense.
 */
async function walkLocalDirectory(localDir: string): Promise<LocalDirectoryPlan> {
  const directories: string[] = [];
  const files: LocalDirectoryPlan['files'] = [];
  const queue: Array<{ local: string; relative: string }> = [{ local: localDir, relative: '' }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = await readdirLocal(current.local, { withFileTypes: true });
    for (const entry of entries) {
      const localPath = joinLocalPath(current.local, entry.name);
      const relativePath = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        directories.push(relativePath);
        queue.push({ local: localPath, relative: relativePath });
      } else if (entry.isFile()) {
        const { size } = await statLocal(localPath);
        files.push({ localPath, relativePath, size });
      }
    }
  }
  return { directories, files };
}

interface AggregatedProgressItem {
  progress: TransferProgress;
  complete(): void;
}

/**
 * Folds the per-file progress of concurrent transfers into one report against the tree's
 * total byte count, so the UI shows a single moving percentage instead of four interleaved
 * counters.
 */
function createAggregatedProgress(totalBytes: number, target?: TransferProgress) {
  let completedBytes = 0;
  const inFlightBytes = new Map<object, number>();
  const report = () => {
    if (!target) {
      return;
    }
    let transferredBytes = completedBytes;
    for (const bytes of inFlightBytes.values()) {
      transferredBytes += bytes;
    }
    target.report({ transferredBytes, totalBytes });
  };
  return {
    beginItem(sizeBytes: number): AggregatedProgressItem {
      const key = {};
      inFlightBytes.set(key, 0);
      return {
        progress: {
          report: ({ transferredBytes }) => {
            inFlightBytes.set(key, Math.min(transferredBytes, sizeBytes));
            report();
          }
        },
        complete() {
          inFlightBytes.delete(key);
          completedBytes += sizeBytes;
          report();
        }
      };
    }
  };
}
