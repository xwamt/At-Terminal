import { readFile } from 'node:fs/promises';
import { Client, type ConnectConfig, type FileEntryWithStats, type SFTPWrapper } from 'ssh2';
import type { ServerConfig } from '../config/schema';
import type { PasswordSource, SftpEntry, SftpEntryType } from './SftpTypes';

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

  async mkdir(path: string): Promise<void> {
    const sftp = this.requireSftp();
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(path, (error) => (error ? reject(error) : resolve()));
    });
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

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const sftp = this.requireSftp();
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, (error) => (error ? reject(error) : resolve()));
    });
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    const sftp = this.requireSftp();
    await new Promise<void>((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, (error) => (error ? reject(error) : resolve()));
    });
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
