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
  private readonly contexts = new Map<string, TerminalContext>();
  private lastConnectedTerminalId: string | undefined;

  getActive(): TerminalContext | undefined {
    return this.active;
  }

  getConnectedTerminal(): TerminalContext | undefined {
    if (this.active?.connected) {
      return this.active;
    }
    const lastConnected = this.lastConnectedTerminalId
      ? this.contexts.get(this.lastConnectedTerminalId)
      : undefined;
    if (lastConnected?.connected) {
      return lastConnected;
    }
    return this.findMostRecentConnected();
  }

  setActive(context: TerminalContext): void {
    this.contexts.set(context.terminalId, context);
    if (context.connected) {
      this.lastConnectedTerminalId = context.terminalId;
    } else if (this.lastConnectedTerminalId === context.terminalId) {
      this.lastConnectedTerminalId = this.findMostRecentConnected()?.terminalId;
    }
    if (
      this.active?.terminalId === context.terminalId &&
      this.active.connected === context.connected &&
      this.active.server.id === context.server.id
    ) {
      this.active = context;
      return;
    }
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
    this.contexts.delete(terminalId);
    if (this.lastConnectedTerminalId === terminalId) {
      this.lastConnectedTerminalId = this.findMostRecentConnected()?.terminalId;
    }
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
    this.contexts.set(terminalId, this.active);
    if (connected) {
      this.lastConnectedTerminalId = terminalId;
    } else if (this.lastConnectedTerminalId === terminalId) {
      this.lastConnectedTerminalId = this.findMostRecentConnected()?.terminalId;
    }
    this.onDidChangeActiveContextEmitter.fire(this.active);
  }

  private findMostRecentConnected(): TerminalContext | undefined {
    return Array.from(this.contexts.values())
      .reverse()
      .find((context) => context.connected);
  }
}
