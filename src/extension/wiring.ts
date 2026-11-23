import type * as vscode from 'vscode';
import type { SftpManager } from '../sftp/SftpManager';
import { shouldRefreshOnContextChange, type SftpTreeSource } from '../tree/SftpTreeProvider';
import type { TerminalContextRegistry } from '../terminal/TerminalContext';

export interface SftpContextWiringOptions {
  terminalContext: Pick<
    TerminalContextRegistry,
    'onDidChangeActiveContext' | 'onDidChangeContext' | 'onDidRemoveContext'
  >;
  sftpManager: Pick<
    SftpManager,
    'setTerminalContext' | 'syncTerminalContext' | 'removeTerminalContext' | 'getActiveViewDescriptor'
  >;
  refreshSftpTree(): void;
  /** Servers-tree repaint and MCP capability push; runs on every context change or removal. */
  onTerminalsChanged(): void;
  onTerminalRemoved?(terminalId: string): void;
}

/**
 * Keeps the SFTP view in lockstep with the terminal registry. Exported so regression tests
 * exercise the exact production wiring instead of a copy.
 *
 * Every registry mutation fires `onDidChangeContext`, so the SFTP state is synced there —
 * including for the focused terminal. `TerminalContext.setActive` skips
 * `onDidChangeActiveContext` when it considers the republished context unchanged, so an
 * active-event-only sync can miss a connect and leave the tree on the
 * "No active SSH terminal" placeholder while the terminal is live.
 */
export function registerSftpContextWiring(options: SftpContextWiringOptions): void {
  const { terminalContext, sftpManager } = options;
  const refreshSftpTreeIfViewChanged = (sync: () => void): void => {
    const previousView = sftpManager.getActiveViewDescriptor();
    sync();
    if (shouldRefreshOnContextChange(previousView, sftpManager.getActiveViewDescriptor())) {
      options.refreshSftpTree();
    }
  };
  terminalContext.onDidChangeActiveContext((activeContext) => {
    refreshSftpTreeIfViewChanged(() => sftpManager.setTerminalContext(activeContext));
  });
  terminalContext.onDidChangeContext((changedContext) => {
    // A terminal that disconnects without being closed (idle timeout, network drop,
    // sshManager.disconnect) still owns a cached Agent SFTP SSH session keyed by its
    // terminalId. Drop it here; onDidRemoveContext only fires when the tab closes.
    if (!changedContext.connected) {
      options.onTerminalRemoved?.(changedContext.terminalId);
    }
    refreshSftpTreeIfViewChanged(() => sftpManager.syncTerminalContext(changedContext));
    options.onTerminalsChanged();
  });
  terminalContext.onDidRemoveContext((terminalId) => {
    // The registry clears the active context after this event, so the descriptor must be
    // compared here: by the time onDidChangeActiveContext(undefined) runs the removal has
    // already emptied the view state on both sides of that comparison.
    refreshSftpTreeIfViewChanged(() => sftpManager.removeTerminalContext(terminalId));
    options.onTerminalRemoved?.(terminalId);
    options.onTerminalsChanged();
  });
}

/** The registry views the SFTP tree may re-read directly; what MCP tools already read. */
export type SftpTerminalRegistrySource = Pick<TerminalContextRegistry, 'getConnectedTerminal' | 'getActive'>;

/**
 * SFTP state is a copy of the terminal registry maintained by event listeners; a missed
 * event leaves the copy on "No active SSH terminal" while the registry — the source of
 * truth MCP tools read — has a live connection. Re-syncing on the placeholder path makes
 * every tree read self-healing instead of trusting that no event was ever dropped.
 */
export function adoptRegistryTerminalIfSftpInactive(
  terminalContext: SftpTerminalRegistrySource,
  sftpManager: Pick<SftpManager, 'getState' | 'setTerminalContext'>
): void {
  if (sftpManager.getState().kind !== 'none') {
    return;
  }
  const live = terminalContext.getConnectedTerminal() ?? terminalContext.getActive();
  if (live) {
    sftpManager.setTerminalContext(live);
  }
}

/** Tree source used by `activate()`: every getChildren re-checks the registry first. */
export function createRegistryBackedSftpTreeSource(
  terminalContext: SftpTerminalRegistrySource,
  sftpManager: Pick<SftpManager, 'getState' | 'setTerminalContext' | 'listDirectory'>
): SftpTreeSource {
  return {
    getState: () => {
      adoptRegistryTerminalIfSftpInactive(terminalContext, sftpManager);
      return sftpManager.getState();
    },
    listDirectory: (path) => sftpManager.listDirectory(path)
  };
}

export interface RefreshSftpFilesViewOptions {
  terminalContext: SftpTerminalRegistrySource;
  sftpManager: Pick<SftpManager, 'setTerminalContext' | 'invalidateAllListings'>;
  refreshSftpTree(): void;
}

/**
 * Handler for `sshManager.sftp.refresh`. Refresh must heal, not just repaint: it re-reads
 * the live registry into the SFTP manager before invalidating listings, so a connected
 * terminal plus Refresh can never keep showing the "No active SSH terminal" placeholder
 * even when every context event was missed.
 */
export function refreshSftpFilesView(options: RefreshSftpFilesViewOptions): void {
  const live = options.terminalContext.getConnectedTerminal() ?? options.terminalContext.getActive();
  if (live) {
    options.sftpManager.setTerminalContext(live);
  }
  options.sftpManager.invalidateAllListings();
  options.refreshSftpTree();
}
