import * as vscode from 'vscode';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import type { HostKeyStore } from '../ssh/HostKeyStore';
import { showTimedNotification } from '../utils/notifications';
import { t } from '../i18n/t';

/**
 * A changed host key blocks the connection by default. Instead of a dead end, the
 * persistent error offers explicit ways out: inspect the stored fingerprint, trust the
 * new key, or forget the stored key so the next connection goes through the normal
 * first-use trust prompt. Nothing is ever trusted automatically.
 */
export async function promptChangedHostKey(
  host: string,
  port: number,
  fingerprint: string,
  hostKeyStore: Pick<HostKeyStore, 'trust' | 'forget' | 'getTrusted'>
): Promise<boolean> {
  const viewAction = t('View Fingerprint');
  const trustAction = t('Trust New Key');
  const forgetAction = t('Forget and Reconnect');
  for (;;) {
    const choice = await vscode.window.showErrorMessage(
      t('Host key for {host}:{port} changed. The connection stays blocked until you trust the new key or forget the stored one. New fingerprint: {fingerprint}', {
        host,
        port,
        fingerprint
      }),
      viewAction,
      trustAction,
      forgetAction
    );
    if (choice === viewAction) {
      const trusted = hostKeyStore.getTrusted(host, port);
      await vscode.window.showInformationMessage(
        trusted
          ? t('Stored fingerprint for {host}:{port}: {fingerprint}', {
              host,
              port,
              fingerprint: trusted.fingerprint
            })
          : t('No trusted host key is stored for {host}:{port}. The next connection will ask to trust the fingerprint.', {
              host,
              port
            })
      );
      continue;
    }
    if (choice === trustAction) {
      await hostKeyStore.trust(host, port, fingerprint);
      return true;
    }
    if (choice === forgetAction) {
      await hostKeyStore.forget(host, port);
      showTimedNotification(
        t('Forgot the host key for {host}:{port}. The next connection will ask to trust the fingerprint again.', {
          host,
          port
        })
      );
      return false;
    }
    return false;
  }
}

export function createHostKeyVerifier(hostKeyStore: HostKeyStore): {
  verify(host: string, port: number, fingerprint: string): Promise<boolean>;
} {
  return {
    async verify(host: string, port: number, fingerprint: string): Promise<boolean> {
      const status = await hostKeyStore.check(host, port, fingerprint);
      if (status === 'trusted') {
        return true;
      }
      if (status === 'changed') {
        return promptChangedHostKey(host, port, fingerprint, hostKeyStore);
      }
      const trustAction = t('Trust and Connect');
      const answer = await vscode.window.showWarningMessage(
        t('Trust SSH host {host}:{port}? Fingerprint: {fingerprint}', { host, port, fingerprint }),
        { modal: true },
        trustAction
      );
      if (answer === trustAction) {
        await hostKeyStore.trust(host, port, fingerprint);
        return true;
      }
      return false;
    }
  };
}

export async function pickServer(
  configManager: Pick<ConfigManager, 'listServers'>
): Promise<ServerConfig | undefined> {
  const servers = await configManager.listServers();
  if (servers.length === 0) {
    void vscode.window.showInformationMessage(
      t('No SSH servers configured yet. Run "SSH: Add Server" to create one.')
    );
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    servers.map((server) => ({
      label: server.label,
      description: `${server.username}@${server.host}:${server.port}`,
      server
    })),
    { placeHolder: t('Select an SSH server') }
  );
  return picked?.server;
}

export type ServerConnectionState = 'connected' | 'disconnected';

/**
 * Reduces terminal summaries to one state per server: any connected terminal wins;
 * known-but-disconnected terminals mark the server as disconnected; servers without a
 * terminal stay absent so the tree keeps their neutral icon.
 */
export function serverConnectionStates(
  terminals: ReadonlyArray<{ serverId: string; connected: boolean }>
): Map<string, ServerConnectionState> {
  const states = new Map<string, ServerConnectionState>();
  for (const terminal of terminals) {
    if (terminal.connected) {
      states.set(terminal.serverId, 'connected');
    } else if (!states.has(terminal.serverId)) {
      states.set(terminal.serverId, 'disconnected');
    }
  }
  return states;
}

export function formatJumpHostDeleteBlockMessage(server: ServerConfig, references: ServerConfig[]): string {
  return t('Cannot delete "{label}" because it is used as a jump host by: {references}', {
    label: server.label,
    references: references.map((reference) => reference.label).join(', ')
  });
}

export const deleteServerAndTrust = {
  formatBlockMessage: formatJumpHostDeleteBlockMessage,
  async remove(
    server: ServerConfig,
    dependencies: {
      configManager: Pick<ConfigManager, 'deleteServer'>;
      hostKeyStore: Pick<HostKeyStore, 'forget'>;
    }
  ): Promise<void> {
    await dependencies.configManager.deleteServer(server.id);
    await dependencies.hostKeyStore.forget(server.host, server.port);
  }
};
