import * as vscode from 'vscode';
import {
  ensureAtSeriesConfigForCurrentIde,
  uninstallAtSeriesConfigForCurrentIde
} from '../mcp/McpConfigInstaller';
import { syncPackagedHub } from '../mcp/hubSync';
import { showErrorWithActions, showTimedNotification } from '../utils/notifications';
import { formatError } from '../utils/errors';
import { t } from '../i18n/t';

export interface McpCommandHostEnvironment {
  appName: string;
  appRoot: string;
  uriScheme: string;
  extensionPath: string;
}

export interface RegisterMcpCommandsOptions {
  context: vscode.ExtensionContext;
  hostEnv: McpCommandHostEnvironment;
  currentWorkspaceFolder(): string | undefined;
}

/** Registers the MCP install/uninstall commands. Activation of the bridge itself lives in `activateMcp`. */
export function registerMcpCommands(options: RegisterMcpCommandsOptions): vscode.Disposable[] {
  const { context, hostEnv, currentWorkspaceFolder } = options;
  return [
    vscode.commands.registerCommand('sshManager.installMcpConfig', async () => {
      try {
        await syncPackagedHub(context, { force: true });
      } catch (error) {
        const repairAction = t('Repair');
        void showErrorWithActions(
          t('AT Series hub sync failed: {message}. MCP may not start until Repair succeeds.', {
            message: formatError(error)
          }),
          repairAction
        ).then((choice) => {
          if (choice === repairAction) {
            void vscode.commands.executeCommand('sshManager.installMcpConfig');
          }
        });
        return;
      }
      const result = await ensureAtSeriesConfigForCurrentIde({
        ...hostEnv,
        workspaceFolder: currentWorkspaceFolder()
      });
      if (result) {
        showTimedNotification(
          result.updated
            ? t('AT Series MCP config installed/repaired.')
            : t('AT Series MCP config is already up to date.')
        );
        return;
      }
      void vscode.window.showWarningMessage(
        t('No supported IDE MCP config target was detected. Open a workspace to install Continue config.')
      );
    }),
    vscode.commands.registerCommand('sshManager.uninstallAtSeriesMcpConfig', async () => {
      const result = await uninstallAtSeriesConfigForCurrentIde({
        ...hostEnv,
        workspaceFolder: currentWorkspaceFolder()
      });
      if (result?.removed) {
        showTimedNotification(t('AT Series MCP config uninstalled.'));
        return;
      }
      if (result) {
        showTimedNotification(t('AT Series MCP config was not present.'));
        return;
      }
      void vscode.window.showWarningMessage(
        t('No supported IDE MCP config target was detected. Open a workspace to uninstall Continue config.')
      );
    })
  ];
}
