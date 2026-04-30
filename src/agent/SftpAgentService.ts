import type { ServerConfig } from '../config/schema';
import type { SftpEntry, SftpFileStat } from '../sftp/SftpTypes';
import type { TerminalContext, TerminalContextRegistry } from '../terminal/TerminalContext';
import type { SftpWriteAuthorizer } from './SftpWriteAuthorizer';

export interface AgentSftpSession {
  connect(): Promise<void>;
  realpath(path?: string): Promise<string>;
  listDirectory(path: string): Promise<SftpEntry[]>;
  stat(path: string): Promise<SftpFileStat>;
  readFile(path: string, maxBytes: number): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  mkdir(path: string): Promise<void>;
  createFile(path: string): Promise<void>;
  dispose(): void;
}

export interface SftpAgentServiceOptions {
  terminalContext: TerminalContextRegistry;
  createSession(context: TerminalContext): AgentSftpSession;
  authorizer: Pick<SftpWriteAuthorizer, 'requireWrite'>;
}

export interface SftpTargetInput {
  terminalId?: string;
  serverId?: string;
}

const DEFAULT_READ_BYTES = 64 * 1024;
const MAX_READ_BYTES = 256 * 1024;

export class SftpAgentService {
  private readonly sessions = new Map<string, Promise<AgentSftpSession>>();
  private readonly roots = new Map<string, string>();

  constructor(private readonly options: SftpAgentServiceOptions) {}

  async listDirectory(input: SftpTargetInput & { path?: string }) {
    const target = await this.resolveTarget(input);
    const session = await this.ensureSession(target.context);
    const path = await this.resolvePath(target.context.terminalId, session, input.path);
    return {
      terminalId: target.context.terminalId,
      serverId: target.context.server.id,
      path,
      entries: await session.listDirectory(path)
    };
  }

  async statPath(input: SftpTargetInput & { path: string }) {
    const target = await this.resolveTarget(input);
    const session = await this.ensureSession(target.context);
    const path = await this.resolvePath(target.context.terminalId, session, input.path);
    return {
      terminalId: target.context.terminalId,
      serverId: target.context.server.id,
      path,
      ...(await session.stat(path))
    };
  }

  async readFile(input: SftpTargetInput & { path: string; maxBytes?: number }) {
    const target = await this.resolveTarget(input);
    const session = await this.ensureSession(target.context);
    const path = await this.resolvePath(target.context.terminalId, session, input.path);
    const stat = await session.stat(path);
    const maxBytes = clampReadBytes(input.maxBytes);
    const buffer = (await session.readFile(path, Math.min(stat.size, maxBytes))).subarray(0, maxBytes);
    if (looksBinary(buffer)) {
      throw new Error('Remote file appears to be binary.');
    }
    return {
      terminalId: target.context.terminalId,
      serverId: target.context.server.id,
      path,
      content: buffer.toString('utf8'),
      truncated: stat.size > maxBytes,
      size: stat.size,
      modifiedAt: stat.modifiedAt
    };
  }

  async writeFile(input: SftpTargetInput & { path: string; content: string; overwrite?: boolean }) {
    const target = await this.resolveTarget(input);
    const session = await this.ensureSession(target.context);
    const path = await this.resolveWritablePath(target.context.terminalId, session, input.path);
    const exists = await pathExists(session, path);
    if (exists && !input.overwrite) {
      throw new Error('Remote file already exists. Pass overwrite: true to replace it.');
    }
    await this.options.authorizer.requireWrite(target.context.server, {
      operation: 'write_file',
      path,
      overwrite: Boolean(exists)
    });
    const content = Buffer.from(input.content, 'utf8');
    await session.writeFile(path, content);
    return {
      terminalId: target.context.terminalId,
      serverId: target.context.server.id,
      path,
      bytesWritten: content.length,
      overwritten: exists
    };
  }

  async createFile(input: SftpTargetInput & { path: string; content?: string }) {
    const target = await this.resolveTarget(input);
    const session = await this.ensureSession(target.context);
    const path = await this.resolveWritablePath(target.context.terminalId, session, input.path);
    if (await pathExists(session, path)) {
      throw new Error('Remote file already exists.');
    }
    await this.options.authorizer.requireWrite(target.context.server, {
      operation: 'create_file',
      path,
      overwrite: false
    });
    if (input.content === undefined) {
      await session.createFile(path);
    } else {
      await session.writeFile(path, Buffer.from(input.content, 'utf8'));
    }
    return { terminalId: target.context.terminalId, serverId: target.context.server.id, path };
  }

  async createDirectory(input: SftpTargetInput & { path: string }) {
    const target = await this.resolveTarget(input);
    const session = await this.ensureSession(target.context);
    const path = await this.resolveWritablePath(target.context.terminalId, session, input.path);
    await this.options.authorizer.requireWrite(target.context.server, {
      operation: 'create_directory',
      path,
      overwrite: false
    });
    await session.mkdir(path);
    return { terminalId: target.context.terminalId, serverId: target.context.server.id, path };
  }

  dispose(): void {
    for (const sessionPromise of this.sessions.values()) {
      void sessionPromise.then((session) => session.dispose(), () => undefined);
    }
    this.sessions.clear();
    this.roots.clear();
  }

  private async resolveTarget(input: SftpTargetInput): Promise<{ context: TerminalContext; server: ServerConfig }> {
    const context =
      this.options.terminalContext.getConnectedTerminalById(input.terminalId) ??
      this.options.terminalContext.getConnectedTerminalByServerId(input.serverId) ??
      (!input.terminalId && !input.serverId ? this.options.terminalContext.getConnectedTerminal() : undefined);
    if (!context) {
      throw new Error('No matching connected AT Terminal SSH session is available. Connect an AT Terminal session first.');
    }
    return { context, server: context.server };
  }

  private async ensureSession(context: TerminalContext): Promise<AgentSftpSession> {
    const existing = this.sessions.get(context.terminalId);
    if (existing) {
      return await existing;
    }
    const session = this.options.createSession(context);
    const promise = Promise.resolve()
      .then(async () => {
        await session.connect();
        return session;
      })
      .catch((error) => {
        session.dispose();
        this.sessions.delete(context.terminalId);
        throw error;
      });
    this.sessions.set(context.terminalId, promise);
    return await promise;
  }

  private async resolvePath(terminalId: string, session: AgentSftpSession, path: string | undefined): Promise<string> {
    const root = await this.rootFor(terminalId, session);
    if (!path || path === '.') {
      return root;
    }
    return path.startsWith('/') ? await session.realpath(path) : await session.realpath(`${root}/${path}`);
  }

  private async resolveWritablePath(terminalId: string, session: AgentSftpSession, path: string): Promise<string> {
    if (!path.trim()) {
      throw new Error('Remote path cannot be empty.');
    }
    const resolved = await this.resolvePath(terminalId, session, path);
    if (resolved === '/') {
      throw new Error('Remote root path cannot be modified.');
    }
    return resolved;
  }

  private async rootFor(terminalId: string, session: AgentSftpSession): Promise<string> {
    const existing = this.roots.get(terminalId);
    if (existing) {
      return existing;
    }
    const root = await session.realpath('.');
    this.roots.set(terminalId, root);
    return root;
  }
}

async function pathExists(session: AgentSftpSession, path: string): Promise<boolean> {
  try {
    await session.stat(path);
    return true;
  } catch {
    return false;
  }
}

function clampReadBytes(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) {
    return DEFAULT_READ_BYTES;
  }
  return Math.min(value, MAX_READ_BYTES);
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}
