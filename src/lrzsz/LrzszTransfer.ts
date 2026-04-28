import * as vscode from 'vscode';
import type { LrzszTransferStart } from './LrzszDetector';

export class LrzszTransfer {
  async start(start: LrzszTransferStart): Promise<void> {
    await vscode.window.showInformationMessage(
      `lrzsz ${start.direction} detected. Waiting for protocol adapter validation.`
    );
  }
}
