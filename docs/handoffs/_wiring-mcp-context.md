# Wiring — MCP context freshness (fix-mcp)

Snippet the integrator must apply to `src/extension.ts` (owned by the tree-reload agent).
Everything below compiles against the fix-mcp versions of `src/mcp/BridgeServer.ts`,
`src/agent/AgentToolService.ts`, and `src/webview/TerminalPanel.ts`.

## Background

`BridgeServer` publishes `capabilities.connectedTargets` to the `~/.at-series` registry
only at `start()` and on a 30-second heartbeat. Hub election reads that count, so for up
to 30s after a user connects (or disconnects) an SSH terminal in the IDE, routing can
behave as if the bridge has 0 connected terminals. `BridgeServer` now exposes a public
`refreshCapabilities(): Promise<void>` that heartbeats the current connected count
immediately. It is a safe no-op before `start()` and after `dispose()`.

## `extension.ts`: refresh bridge capabilities on terminal context changes

In the existing `terminalContext.onDidChangeContext` and `onDidRemoveContext` handlers,
also refresh the bridge registry record:

```ts
terminalContext.onDidChangeContext((changedContext) => {
  if (terminalContext.getActive()?.terminalId !== changedContext.terminalId) {
    sftpManager.syncTerminalContext(changedContext);
  }
  // Connection state feeds the Servers tree icon/description.
  treeProvider.refresh();
  // Connect/disconnect must reach the ~/.at-series registry immediately, not on the
  // next 30s heartbeat, or hub routing sees 0 connected terminals.
  void bridgeServer?.refreshCapabilities();
});
terminalContext.onDidRemoveContext((terminalId) => {
  sftpManager.removeTerminalContext(terminalId);
  sftpAgentService?.disposeTerminal(terminalId);
  treeProvider.refresh();
  void bridgeServer?.refreshCapabilities();
});
```

Note: `let bridgeServer: BridgeServer | undefined;` is declared after these handler
registrations today. The closures only read it at event time, so this works as-is; do
not capture the value eagerly.

## Behavior notes for the integrator

- `TerminalPanel` now calls `publishContext()` (instead of `markConnected` /
  `markDisconnected`) after every connect state change, so `onDidChangeContext` fires —
  and the snippet above heartbeats — on connect, reconnect, disconnect, idle disconnect,
  and remote-initiated disconnect. No `extension.ts` change is needed for that part.
- `AgentToolService.listServers()` now also returns servers that have a live connected
  UI terminal even when **Allow background connections** is off, with a `connected`
  boolean on each returned server. No wiring change needed.
