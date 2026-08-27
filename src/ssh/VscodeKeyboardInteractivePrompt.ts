import * as vscode from 'vscode';
import { t } from '../i18n/t';
import type { KeyboardInteractivePrompt } from './KeyboardInteractive';

/**
 * Default InputBox implementation of {@link KeyboardInteractivePrompt} for user-driven
 * flows (terminal, connection test). Background paths must not use it: they pass no
 * prompt at all, so attachKeyboardInteractive fails their connection with a clear
 * error instead of popping UI nobody is watching.
 */
export function createVscodeKeyboardInteractivePrompt(): KeyboardInteractivePrompt {
  return async (request) => {
    const responses: string[] = [];
    for (const field of request.prompts) {
      const detail = [request.instructions.trim(), field.prompt.trim()].filter(Boolean).join(' ');
      const response = await vscode.window.showInputBox({
        title: request.name.trim() || t('Keyboard-interactive authentication'),
        prompt: detail || t('Authentication response'),
        password: !field.echo,
        ignoreFocusOut: true
      });
      if (response === undefined) {
        return undefined;
      }
      responses.push(response);
    }
    return responses;
  };
}
