import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client, type ClientChannel, type ConnectConfig, type FileEntryWithStats, type SFTPWrapper } from 'ssh2';
import type { ServerConfig } from '../config/schema';
import { quotePosixShellPath, safePreviewName } from './RemotePath';
import type { TransferProgress } from './TransferService';
import type { PasswordSource, SftpEntry, SftpEntryType, SftpFileStat } from './SftpTypes';

export async function buildSftpConnectConfig(server: ServerConfig, passwords: PasswordSource): Promise<ConnectConfig> {
  const base: ConnectConfig = {
    host: server.host,
    port: server.port,
    username: server.username,
    keepaliveInterval: server.keepAliveInterval * 1000
  };

  if (server.authType === 'password') {
    const password = await passwords.getPassword(server.id);
    if (!password) {
      throw new Error('Missing password. Edit the server configuration and enter a password.');
    }
    return { ...base, password };
  }

  if (!server.privateKeyPath) {
    throw new Error('Missing private key path.');
  }

  return {
    ...base,
    privateKey: await readFile(server.privateKeyPath, 'utf8')
  };
}

export class SftpSession {
  private client: Client | undefined;
  private sftp: SFTPWrapper | undefined;

  constructor(
    private readonly server: ServerConfig,
    private readonly passwords: PasswordSource
  ) {}

  async connect(): Promise<void> {
    const client = new Client();
    this.client = client;
    const config = await buildSftpConnectConfig(this.server, this.passwords);

    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
      client.connect(config);
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
    const sftp = this.requireSftp();
    const attrs = await new Promise<{ size: number; mtime: number }>((resolve, reject) => {
      sftp.stat(path, (error, stat) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stat);
      });
    });
    return {
      size: attrs.size,
      modifiedAt: attrs.mtime
    };
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

  async deleteDirectory(path: string): Promise<void> {
    const sftp = this.requireSftp();
    await new Promise<void>((resolve, reject) => {
      sftp.rmdir(path, (error) => (error ? reject(error) : resolve()));
    });
  }

  async uploadFile(localPath: string, remotePath: string, progress?: TransferProgress): Promise<void> {
    const sftp = this.requireSftp();
    try {
      await this.fastPut(sftp, localPath, remotePath, progress);
    } catch (error) {
      if (!isPermissionDeniedError(error)) {
        throw error;
      }
      await this.uploadFileWithSudo(localPath, remotePath, progress, error);
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
      await removeRemoteTempFile(sftp, tempPath);
      throw new Error(
        `SFTP upload to ${remotePath} failed with permission denied, and sudo fallback failed: ${errorMessage(sudoError)}. Original error: ${errorMessage(permissionError)}`
      );
    }
  }

  private async execSudoOverwrite(tempPath: string, remotePath: string): Promise<void> {
    const client = this.requireClient();
    const script = `set -e; cat ${quotePosixShellPath(tempPath)} > ${quotePosixShellPath(remotePath)}; rm -f ${quotePosixShellPath(tempPath)}`;
    const command = `sudo -n sh -c ${quotePosixShellPath(script)}`;
    await new Promise<string>((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        collectExecResult(stream, resolve, reject);
      });
    });
  }

  async downloadFile(remotePath: string, localPath: string, progress?: TransferProgress): Promise<void> {
    const sftp = this.requireSftp();
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

  async readFile(path: string, maxBytes: number): Promise<Buffer> {
    const sftp = this.requireSftp();
    const handle = await new Promise<Buffer>((resolve, reject) => {
      sftp.open(path, 'r', (error, fileHandle) => (error ? reject(error) : resolve(fileHandle)));
    });
    try {
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < maxBytes) {
        const length = Math.min(32_768, maxBytes - offset);
        const buffer = Buffer.alloc(length);
        const bytesRead = await new Promise<number>((resolve, reject) => {
          sftp.read(handle, buffer, 0, length, offset, (error, read) => (error ? reject(error) : resolve(read)));
        });
        if (bytesRead <= 0) {
          break;
        }
        chunks.push(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      return Buffer.concat(chunks);
    } finally {
      await new Promise<void>((resolve, reject) => {
        sftp.close(handle, (error) => (error ? reject(error) : resolve()));
      });
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
      const tempPath = `/tmp/at-terminal-write-${randomUUID()}-${safePreviewName(path)}`;
      try {
        await writeBuffer(sftp, tempPath, content);
        await this.execSudoOverwrite(tempPath, path);
      } catch (sudoError) {
        await removeRemoteTempFile(sftp, tempPath);
        throw new Error(
          `SFTP write to ${path} failed with permission denied, and sudo fallback failed: ${errorMessage(sudoError)}. Original error: ${errorMessage(error)}`
        );
      }
    }
  }

  dispose(): void {
    this.sftp = undefined;
    this.client?.end();
    this.client = undefined;
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

async function writeBuffer(sftp: SFTPWrapper, path: string, content: Buffer): Promise<void> {
  const handle = await new Promise<Buffer>((resolve, reject) => {
    sftp.open(path, 'w', (error, fileHandle) => (error ? reject(error) : resolve(fileHandle)));
  });
  try {
    let offset = 0;
    while (offset < content.byteLength) {
      const length = Math.min(32_768, content.byteLength - offset);
      await new Promise<void>((resolve, reject) => {
        sftp.write(handle, content, offset, length, offset, (error?: Error | null) =>
          error ? reject(error) : resolve()
        );
      });
      offset += length;
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      sftp.close(handle, (error) => (error ? reject(error) : resolve()));
    });
  }
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
