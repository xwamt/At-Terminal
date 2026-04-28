import * as vscode from 'vscode';
import type { ServerConfig } from '../config/schema';

export interface TerminalContext {
  terminalId: string;
  server: ServerConfig;
  connected: boolean;
  write(data: string): void;
}

export class TerminalContextRegistry {
  private readonly onDidChangeActiveContextEmitter = new vscode.EventEmitter<TerminalContext | undefined>();
  readonly onDidChangeActiveContext = this.onDidChangeActiveContextEmitter.event;

  private active: TerminalContext | undefined;

  getActive(): TerminalContext | undefined {
    return this.active;
  }

  setActive(context: TerminalContext): void {
    this.active = context;
    this.onDidChangeActiveContextEmitter.fire(context);
  }

  markConnected(terminalId: string): void {
    this.updateConnectionState(terminalId, true);
  }

  markDisconnected(terminalId: string): void {
    this.updateConnectionState(terminalId, false);
  }

  clearIfActive(terminalId: string): void {
    if (this.active?.terminalId !== terminalId) {
      return;
    }
    this.active = undefined;
    this.onDidChangeActiveContextEmitter.fire(undefined);
  }

  private updateConnectionState(terminalId: string, connected: boolean): void {
    if (this.active?.terminalId !== terminalId) {
      return;
    }
    this.active = { ...this.active, connected };
    this.onDidChangeActiveContextEmitter.fire(this.active);
  }
}
