import * as vscode from 'vscode';
import type { ServerTreeItem } from '../tree/TreeItems';
import { formatError } from '../utils/errors';
import { t } from '../i18n/t';
import type { CommandContext } from './commandContext';
import type { ActivePortForward } from '../ssh/PortForwardManager';
import { pickServer } from '../extension/serverHelpers';

export function refreshPortForwardStatusBar(
  statusBar: vscode.StatusBarItem,
  active: Array<{ localPort: number; serverLabel: string; remoteHost: string; remotePort: number }>
): void {
  if (active.length === 0) {
    statusBar.hide();
    return;
  }
  statusBar.text = t('$(plug) AT Forwards: {count}', { count: active.length });
  statusBar.tooltip = active
    .map(
      (forward) =>
        `127.0.0.1:${forward.localPort} -> ${forward.serverLabel}:${forward.remoteHost}:${forward.remotePort}`
    )
    .join('\n');
  statusBar.command = 'sshManager.managePortForwards';
  statusBar.show();
}

export function registerPortForwardCommands(ctx: CommandContext): vscode.Disposable[] {
  const { configManager, portForwardManager } = ctx;
  return [
    vscode.commands.registerCommand('sshManager.forwardLocalPort', async (item?: ServerTreeItem) => {
      const server = item?.server ?? (await pickServer(configManager));
      if (!server) {
        return;
      }
      const existing = portForwardManager.list(server.id);
      if (existing.length > 0) {
        const addLabel = t('Add New Forward');
        const picked = await vscode.window.showQuickPick(
          [
            { label: `$(add) ${addLabel}`, action: 'add' as const },
            ...existing.map((forward) => ({
              label: `127.0.0.1:${forward.localPort}`,
              description: `${forward.remoteHost}:${forward.remotePort}`,
              detail: t('Active forward for {label}; pick it to stop or copy the address.', {
                label: server.label
              }),
              action: 'existing' as const,
              forward
            }))
          ],
          { placeHolder: t('Local port forwards for {label}', { label: server.label }) }
        );
        if (!picked) {
          return;
        }
        if (picked.action === 'existing') {
          await managePortForward(portForwardManager, picked.forward);
          return;
        }
      }

      const remoteHost =
        (await vscode.window.showInputBox({
          prompt: t('Remote host to forward to'),
          value: '127.0.0.1'
        })) ?? '';
      const remotePortText = await vscode.window.showInputBox({
        prompt: t('Remote port to forward to'),
        value: '3306'
      });
      if (!remoteHost.trim() || !remotePortText) {
        return;
      }
      const remotePort = Number(remotePortText);
      if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
        void vscode.window.showErrorMessage(t('Remote port must be an integer between 1 and 65535.'));
        return;
      }
      const localPortText = await vscode.window.showInputBox({
        prompt: t('Local port (0 picks an ephemeral port)'),
        value: '0'
      });
      if (localPortText === undefined) {
        return;
      }
      const localPort = Number(localPortText);
      if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535) {
        void vscode.window.showErrorMessage(t('Local port must be an integer between 0 and 65535.'));
        return;
      }
      try {
        const forward = await portForwardManager.add(server, {
          remoteHost: remoteHost.trim(),
          remotePort,
          localPort
        });
        void vscode.window.showInformationMessage(
          t('Forwarding localhost:{localPort} to {host}:{remotePort} on {label}.', {
            localPort: forward.localPort,
            host: forward.remoteHost,
            remotePort: forward.remotePort,
            label: server.label
          })
        );
      } catch (error) {
        void vscode.window.showErrorMessage(formatError(error));
      }
    }),
    vscode.commands.registerCommand('sshManager.managePortForwards', async () => {
      const active = portForwardManager.list();
      if (active.length === 0) {
        void vscode.window.showInformationMessage(t('No active local port forwards.'));
        return;
      }
      const picked = await vscode.window.showQuickPick(
        active.map((forward) => ({
          label: `127.0.0.1:${forward.localPort}`,
          description: `${forward.serverLabel}:${forward.remoteHost}:${forward.remotePort}`,
          detail: t('Started {time}', { time: new Date(forward.startedAt).toLocaleString() }),
          forward
        })),
        { placeHolder: t('Manage local port forwards') }
      );
      if (picked) {
        await managePortForward(portForwardManager, picked.forward);
      }
    })
  ];
}

async function managePortForward(
  manager: CommandContext['portForwardManager'],
  forward: ActivePortForward
): Promise<void> {
  const copyLabel = t('Copy Address');
  const stopLabel = t('Stop Forward');
  const action = await vscode.window.showQuickPick([copyLabel, stopLabel], {
    placeHolder: `127.0.0.1:${forward.localPort} -> ${forward.serverLabel}:${forward.remoteHost}:${forward.remotePort}`
  });
  if (action === copyLabel) {
    await vscode.env.clipboard.writeText(`127.0.0.1:${forward.localPort}`);
    return;
  }
  if (action === stopLabel) {
    await manager.stop(forward.id);
    void vscode.window.showInformationMessage(
      t('Stopped local port forward 127.0.0.1:{localPort}.', { localPort: forward.localPort })
    );
  }
}
