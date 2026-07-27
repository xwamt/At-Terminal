import * as vscode from 'vscode';
import type { ServerConfig } from '../config/schema';

export interface TerminalContext {
  terminalId: string;
  server: ServerConfig;
  connected: boolean;
  write(data: string): void;
}

export interface TerminalSummary {
  terminalId: string;
  serverId: string;
  label: string;
  host: string;
  port: number;
  username: string;
  connected: boolean;
  focused: boolean;
  default: boolean;
}

export interface TerminalContextSnapshot {
  focusedTerminal?: TerminalSummary;
  defaultConnectedTerminal?: TerminalSummary;
  connectedTerminals: TerminalSummary[];
  knownTerminals: TerminalSummary[];
}

export class TerminalContextRegistry {
  private readonly onDidChangeActiveContextEmitter = new vscode.EventEmitter<TerminalContext | undefined>();
  private readonly onDidChangeContextEmitter = new vscode.EventEmitter<TerminalContext>();
  private readonly onDidRemoveContextEmitter = new vscode.EventEmitter<string>();
  readonly onDidChangeActiveContext = this.onDidChangeActiveContextEmitter.event;
  readonly onDidChangeContext = this.onDidChangeContextEmitter.event;
  readonly onDidRemoveContext = this.onDidRemoveContextEmitter.event;

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

  getConnectedTerminalById(terminalId: string | undefined): TerminalContext | undefined {
    if (!terminalId) {
      return undefined;
    }
    const context = this.contexts.get(terminalId);
    return context?.connected ? context : undefined;
  }

  getConnectedTerminalByServerId(serverId: string | undefined): TerminalContext | undefined {
    if (!serverId) {
      return undefined;
    }
    return Array.from(this.contexts.values())
      .reverse()
      .find((context) => context.connected && context.server.id === serverId);
  }

  getSnapshot(): TerminalContextSnapshot {
    const defaultConnected = this.getConnectedTerminal();
    const knownTerminals = Array.from(this.contexts.values()).map((context) =>
      this.toSummary(context, defaultConnected)
    );
    return {
      focusedTerminal: this.active ? this.toSummary(this.active, defaultConnected) : undefined,
      defaultConnectedTerminal: defaultConnected ? this.toSummary(defaultConnected, defaultConnected) : undefined,
      connectedTerminals: knownTerminals.filter((terminal) => terminal.connected),
      knownTerminals
    };
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
      this.onDidChangeContextEmitter.fire(context);
      return;
    }
    this.active = context;
    this.onDidChangeContextEmitter.fire(context);
    this.onDidChangeActiveContextEmitter.fire(context);
  }

  markConnected(terminalId: string): void {
    this.updateConnectionState(terminalId, true);
  }

  markDisconnected(terminalId: string): void {
    this.updateConnectionState(terminalId, false);
  }

  clearIfActive(terminalId: string): void {
    const deleted = this.contexts.delete(terminalId);
    if (deleted) {
      this.onDidRemoveContextEmitter.fire(terminalId);
    }
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
    const existing = this.contexts.get(terminalId);
    if (!existing) {
      return;
    }
    const updated = { ...existing, connected };
    this.contexts.set(terminalId, updated);
    if (connected) {
      this.lastConnectedTerminalId = terminalId;
    } else if (this.lastConnectedTerminalId === terminalId) {
      this.lastConnectedTerminalId = this.findMostRecentConnected()?.terminalId;
    }
    this.onDidChangeContextEmitter.fire(updated);
    if (this.active?.terminalId !== terminalId) {
      return;
    }
    this.active = updated;
    this.onDidChangeActiveContextEmitter.fire(updated);
  }

  private findMostRecentConnected(): TerminalContext | undefined {
    return Array.from(this.contexts.values())
      .reverse()
      .find((context) => context.connected);
  }

  private toSummary(context: TerminalContext, defaultConnected: TerminalContext | undefined): TerminalSummary {
    return {
      terminalId: context.terminalId,
      serverId: context.server.id,
      label: context.server.label,
      host: context.server.host,
      port: context.server.port,
      username: context.server.username,
      connected: context.connected,
      focused: this.active?.terminalId === context.terminalId,
      default: defaultConnected?.terminalId === context.terminalId
    };
  }
}
