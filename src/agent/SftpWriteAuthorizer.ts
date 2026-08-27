import * as vscode from 'vscode';
import type { ServerConfig } from '../config/schema';
import { t } from '../i18n/t';
import { dirname } from '../sftp/RemotePath';
import { shouldAutoApproveSftpWrite } from './agentCommandTrust';
import { isSensitiveRemotePath, isWithinRemoteDirectory, normalizeRemoteDirectory } from './remoteWritePolicy';

export type SftpWriteScope = 'once' | 'directory' | 'session';

export interface SftpWriteRequest {
  operation: 'write_file' | 'create_file' | 'create_directory' | 'rename' | 'delete_file';
  path: string;
  overwrite: boolean;
  /** `realpath('.')` of the SFTP session, i.e. the directory the user actually opened. */
  workspaceRoot: string;
}

export interface SftpWriteConfirmation {
  server: ServerConfig;
  request: SftpWriteRequest;
  parentDirectory: string;
  workspaceRoot: string;
  outsideWorkspace: boolean;
  sensitive: boolean;
  allowedScopes: readonly SftpWriteScope[];
  stage: 'primary' | 'sensitive-double-check';
}

export type ConfirmSftpWrite = (confirmation: SftpWriteConfirmation) => Promise<SftpWriteScope | undefined>;

export const DIRECTORY_GRANT_TTL_MS = 15 * 60 * 1000;

export interface SftpWriteAuthorizerOptions {
  confirm?: ConfirmSftpWrite;
  now?: () => number;
}

/**
 * Decides whether an agent-initiated SFTP write may proceed.
 *
 * A grant is keyed on `(serverId, parent directory)` and carries an expiry. Nothing is keyed
 * on the server alone: the caller may be an agent following injected instructions, and under
 * that threat model "the user allowed one write to this box" cannot mean "this box is now
 * writable". Sensitive paths never produce a grant at all.
 */
export class SftpWriteAuthorizer {
  /** grant key -> expiry timestamp; Infinity for session-lifetime grants. */
  private readonly grants = new Map<string, number>();
  private readonly confirm: ConfirmSftpWrite;
  private readonly now: () => number;

  constructor(options: SftpWriteAuthorizerOptions = {}) {
    this.confirm = options.confirm ?? confirmWithVscode;
    this.now = options.now ?? Date.now;
  }

  async requireWrite(server: ServerConfig, request: SftpWriteRequest): Promise<void> {
    if (shouldAutoApproveSftpWrite(server)) {
      return;
    }
    const parentDirectory = normalizeRemoteDirectory(dirname(request.path));
    const sensitive = isSensitiveRemotePath(request.path);
    const outsideWorkspace = !isWithinRemoteDirectory(request.workspaceRoot, request.path);
    const grantKey = `${server.id}\n${parentDirectory}`;

    if (!sensitive && this.hasLiveGrant(grantKey)) {
      return;
    }

    const allowedScopes = resolveAllowedScopes(sensitive, outsideWorkspace);
    const base = {
      server,
      request,
      parentDirectory,
      workspaceRoot: normalizeRemoteDirectory(request.workspaceRoot),
      outsideWorkspace,
      sensitive
    };

    const scope = await this.confirm({ ...base, allowedScopes, stage: 'primary' });
    if (!scope || !allowedScopes.includes(scope)) {
      throw new Error('SFTP write was cancelled.');
    }

    if (sensitive) {
      const confirmed = await this.confirm({
        ...base,
        allowedScopes: ['once'],
        stage: 'sensitive-double-check'
      });
      if (confirmed !== 'once') {
        throw new Error('SFTP write was cancelled.');
      }
      return;
    }

    if (scope === 'directory') {
      this.grants.set(grantKey, this.now() + DIRECTORY_GRANT_TTL_MS);
    } else if (scope === 'session') {
      this.grants.set(grantKey, Number.POSITIVE_INFINITY);
    }
  }

  /**
   * Deletion is never auto-approved and never remembered: full trust covers write
   * prompts but not deletes, and no directory or session grant may ever cover a
   * delete. Every call asks the user; sensitive paths ask twice.
   */
  async requireDelete(server: ServerConfig, request: SftpWriteRequest): Promise<void> {
    const parentDirectory = normalizeRemoteDirectory(dirname(request.path));
    const sensitive = isSensitiveRemotePath(request.path);
    const outsideWorkspace = !isWithinRemoteDirectory(request.workspaceRoot, request.path);
    const base = {
      server,
      request,
      parentDirectory,
      workspaceRoot: normalizeRemoteDirectory(request.workspaceRoot),
      outsideWorkspace,
      sensitive
    };

    const scope = await this.confirm({ ...base, allowedScopes: ['once'], stage: 'primary' });
    if (scope !== 'once') {
      throw new Error('SFTP delete was cancelled.');
    }
    if (sensitive) {
      const confirmed = await this.confirm({
        ...base,
        allowedScopes: ['once'],
        stage: 'sensitive-double-check'
      });
      if (confirmed !== 'once') {
        throw new Error('SFTP delete was cancelled.');
      }
    }
  }

  private hasLiveGrant(grantKey: string): boolean {
    const expiresAt = this.grants.get(grantKey);
    if (expiresAt === undefined) {
      return false;
    }
    if (expiresAt <= this.now()) {
      this.grants.delete(grantKey);
      return false;
    }
    return true;
  }
}

function resolveAllowedScopes(sensitive: boolean, outsideWorkspace: boolean): readonly SftpWriteScope[] {
  if (sensitive) {
    return ['once'];
  }
  // A grant that never expires is only on offer inside the directory the user opened.
  return outsideWorkspace ? ['once', 'directory'] : ['once', 'directory', 'session'];
}

const SCOPE_LABELS: Record<SftpWriteScope, string> = {
  once: 'Allow Once',
  directory: 'Allow This Folder For 15 Minutes',
  session: 'Allow This Folder For The Session'
};

const SENSITIVE_ACKNOWLEDGEMENT = 'Write It Anyway, Once';

async function confirmWithVscode(confirmation: SftpWriteConfirmation): Promise<SftpWriteScope | undefined> {
  const isDelete = confirmation.request.operation === 'delete_file';
  if (confirmation.stage === 'sensitive-double-check') {
    const acknowledgement = isDelete ? t('Delete It Anyway, Once') : SENSITIVE_ACKNOWLEDGEMENT;
    const answer = await vscode.window.showWarningMessage(
      isDelete ? formatSensitiveDeleteDoubleCheck(confirmation) : formatSensitiveDoubleCheck(confirmation),
      { modal: true },
      acknowledgement
    );
    return answer === acknowledgement ? 'once' : undefined;
  }

  if (isDelete) {
    const deleteOnce = t('Delete Once');
    const answer = await vscode.window.showWarningMessage(formatDeletePrompt(confirmation), { modal: true }, deleteOnce);
    return answer === deleteOnce ? 'once' : undefined;
  }

  // The first item is the focused default, so the least-privilege answer is the one Enter picks.
  const items = confirmation.allowedScopes.map((scope) => SCOPE_LABELS[scope]);
  const answer = await vscode.window.showWarningMessage(formatWritePrompt(confirmation), { modal: true }, ...items);
  return confirmation.allowedScopes.find((scope) => SCOPE_LABELS[scope] === answer);
}

function formatWritePrompt(confirmation: SftpWriteConfirmation): string {
  const { server, request } = confirmation;
  const warnings = [
    confirmation.outsideWorkspace
      ? `WARNING: outside the working directory ${confirmation.workspaceRoot} that this session was opened in.`
      : undefined,
    confirmation.sensitive
      ? 'WARNING: sensitive system path (SSH keys, service units, cron, or system configuration).'
      : undefined
  ].filter((warning): warning is string => warning !== undefined);

  return [
    `Allow AT Terminal agent SFTP write on ${server.label} (${server.host})?`,
    '',
    `Operation: ${request.operation}`,
    `Path: ${request.path}`,
    `Folder: ${confirmation.parentDirectory}`,
    `Overwrite: ${request.overwrite ? 'yes' : 'no'}`,
    ...(warnings.length > 0 ? ['', ...warnings] : []),
    '',
    'Allowing a folder covers later writes to that folder only, never the whole server.'
  ].join('\n');
}

function formatSensitiveDoubleCheck(confirmation: SftpWriteConfirmation): string {
  return [
    `${confirmation.request.path} is a sensitive system path on ${confirmation.server.host}.`,
    '',
    'Writing here can grant persistent access: authorized keys, sudo rules, cron entries and',
    'service units all survive the session and run without you.',
    '',
    'Confirm once more to allow this single write. This answer is never remembered.'
  ].join('\n');
}

function formatDeletePrompt(confirmation: SftpWriteConfirmation): string {
  const { server, request } = confirmation;
  const warnings = [
    confirmation.outsideWorkspace
      ? t('WARNING: outside the working directory {root} that this session was opened in.', {
          root: confirmation.workspaceRoot
        })
      : undefined,
    confirmation.sensitive
      ? t('WARNING: sensitive system path (SSH keys, service units, cron, or system configuration).')
      : undefined
  ].filter((warning): warning is string => warning !== undefined);

  return [
    t('Allow AT Terminal agent to delete a remote file on {label} ({host})?', {
      label: server.label,
      host: server.host
    }),
    '',
    t('Path: {path}', { path: request.path }),
    t('Folder: {folder}', { folder: confirmation.parentDirectory }),
    ...(warnings.length > 0 ? ['', ...warnings] : []),
    '',
    t('Deleting always asks, even on fully trusted servers, and this answer is never remembered.')
  ].join('\n');
}

function formatSensitiveDeleteDoubleCheck(confirmation: SftpWriteConfirmation): string {
  return [
    t('{path} is a sensitive system path on {host}.', {
      path: confirmation.request.path,
      host: confirmation.server.host
    }),
    '',
    t('Deleting here can break logins, services, or scheduled jobs on the server.'),
    '',
    t('Confirm once more to allow this single delete. This answer is never remembered.')
  ].join('\n');
}
