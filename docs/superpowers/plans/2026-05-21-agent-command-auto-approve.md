# Agent Command Auto Approve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-server switch that lets trusted servers run non-destructive MCP `run_remote_command` calls without the current per-command confirmation dialog.

**Architecture:** Store the setting on `ServerConfig` as optional `agentCommandAutoApprove?: boolean`, defaulting to false when omitted. The server form owns rendering and persistence of the switch, while `AgentToolService.runRemoteCommand` is the only execution path that uses the setting. Dangerous-command detection remains the existing local heuristic and still forces confirmation.

**Tech Stack:** TypeScript, VS Code extension APIs, Zod, Vitest, webview DOM script, existing `AgentToolService` and `ServerFormPanel` modules.

---

## File Structure

- Modify `src/config/schema.ts`: add optional boolean field to the strict `ServerConfig` schema.
- Modify `test/config/schema.test.ts`: add schema tests for missing, true, false, and unknown-field behavior.
- Modify `src/webview/ServerFormPanel.ts`: parse `agentCommandAutoApprove` from form payload and render the switch plus summary state.
- Modify `webview/server-form/index.ts`: wire live summary updates for the switch.
- Modify `webview/server-form/index.css`: style the switch using existing VS Code variable patterns.
- Modify `test/webview/ServerFormMarkup.test.ts`: assert markup and summary rendering.
- Modify `test/webview/ServerFormPanel.test.ts`: assert submitted payload persists the boolean.
- Modify `src/agent/AgentToolService.ts`: include the flag in `listServers` output and skip confirmation for trusted non-destructive commands.
- Modify `test/agent/AgentToolService.test.ts`: assert service-level command behavior.
- Modify `test/agent/AgentTools.test.ts`: update tool JSON output expectations.
- Modify `README.md` and `skills/at-terminal-mcp/SKILL.md`: document the trust switch and its limits.

## Task 1: Schema Support

**Files:**
- Modify: `test/config/schema.test.ts`
- Modify: `src/config/schema.ts`

- [ ] **Step 1: Add failing schema tests**

Append these tests inside the existing `describe('server config schema', () => { ... })` block in `test/config/schema.test.ts`:

```ts
  it('accepts agent command auto approval when enabled', () => {
    const parsed = parseServerConfig({
      id: 'server-7',
      label: 'Trusted Commands',
      host: 'trusted.example.com',
      port: 22,
      username: 'deploy',
      authType: 'password',
      agentCommandAutoApprove: true,
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 2
    });

    expect(parsed.agentCommandAutoApprove).toBe(true);
  });

  it('accepts agent command auto approval when disabled', () => {
    const parsed = parseServerConfig({
      id: 'server-8',
      label: 'Manual Commands',
      host: 'manual.example.com',
      port: 22,
      username: 'deploy',
      authType: 'password',
      agentCommandAutoApprove: false,
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 2
    });

    expect(parsed.agentCommandAutoApprove).toBe(false);
  });

  it('keeps agent command auto approval optional for existing configs', () => {
    const parsed = parseServerConfig({
      id: 'server-9',
      label: 'Existing',
      host: 'existing.example.com',
      port: 22,
      username: 'deploy',
      authType: 'password',
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 2
    });

    expect(parsed.agentCommandAutoApprove).toBeUndefined();
  });

  it('still rejects unrelated unknown fields', () => {
    expect(() =>
      parseServerConfig({
        id: 'server-10',
        label: 'Unknown Field',
        host: 'unknown.example.com',
        port: 22,
        username: 'deploy',
        authType: 'password',
        agentCommandAutoApprove: true,
        agentTrustEverything: true,
        keepAliveInterval: 30,
        encoding: 'utf-8',
        createdAt: 1,
        updatedAt: 2
      })
    ).toThrow();
  });
```

- [ ] **Step 2: Run schema tests and verify failure**

Run:

```bash
npm test -- test/config/schema.test.ts
```

Expected: the first two new tests fail because `agentCommandAutoApprove` is not allowed by the strict schema.

- [ ] **Step 3: Add the schema field**

In `src/config/schema.ts`, add the optional boolean immediately after `jumpHostId`:

```ts
    jumpHostId: z.string().min(1).optional(),
    agentCommandAutoApprove: z.boolean().optional(),
    keepAliveInterval: z.number().int().min(0),
```

- [ ] **Step 4: Run schema tests and verify pass**

Run:

```bash
npm test -- test/config/schema.test.ts
```

Expected: all tests in `test/config/schema.test.ts` pass.

- [ ] **Step 5: Commit schema support**

Run:

```bash
git add src/config/schema.ts test/config/schema.test.ts
git commit -m "feat: add agent command trust config field"
```

## Task 2: Server Form Persistence And UI

**Files:**
- Modify: `test/webview/ServerFormPanel.test.ts`
- Modify: `test/webview/ServerFormMarkup.test.ts`
- Modify: `src/webview/ServerFormPanel.ts`
- Modify: `webview/server-form/index.ts`
- Modify: `webview/server-form/index.css`

- [ ] **Step 1: Add failing form persistence test**

Append this test inside `describe('ServerFormPanel message handling', () => { ... })` in `test/webview/ServerFormPanel.test.ts`:

```ts
  it('persists agent command auto approval from the form payload', async () => {
    const saveServer = vi.fn();

    await handleServerFormMessage(
      {
        type: 'submit',
        payload: {
          label: 'Production',
          group: 'prod',
          host: 'example.com',
          port: 22,
          username: 'deploy',
          authType: 'password',
          password: 'secret',
          agentCommandAutoApprove: 'on',
          keepAliveInterval: 30
        }
      },
      undefined,
      { saveServer } as never,
      vi.fn(),
      { dispose: vi.fn(), webview: { postMessage: vi.fn() } } as never
    );

    expect(saveServer).toHaveBeenCalledWith(expect.objectContaining({ agentCommandAutoApprove: true }), 'secret');
  });
```

- [ ] **Step 2: Add failing markup tests**

Append these tests inside `describe('ServerFormPanel markup', () => { ... })` in `test/webview/ServerFormMarkup.test.ts`:

```ts
  it('renders the agent command trust switch off by default', () => {
    const html = renderServerForm();

    expect(html).toContain('name="agentCommandAutoApprove"');
    expect(html).toContain('Trust agent remote commands');
    expect(html).toContain('Run non-destructive MCP remote commands without asking each time.');
    expect(html).toContain('Agent commands: manual approval');
    expect(html).not.toMatch(/name="agentCommandAutoApprove"[^>]*checked/);
  });

  it('renders the agent command trust switch checked for trusted servers', () => {
    const html = renderServerForm({
      id: 'server-1',
      label: 'Production',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      authType: 'password',
      agentCommandAutoApprove: true,
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 2
    });

    expect(html).toMatch(/name="agentCommandAutoApprove"[^>]*checked/);
    expect(html).toContain('Agent commands: trusted for non-destructive commands');
  });
```

- [ ] **Step 3: Run form tests and verify failure**

Run:

```bash
npm test -- test/webview/ServerFormPanel.test.ts test/webview/ServerFormMarkup.test.ts
```

Expected: new tests fail because the field is not parsed or rendered yet.

- [ ] **Step 4: Parse the form field**

In `src/webview/ServerFormPanel.ts`, add the field in `serverFromPayload` immediately after `jumpHostId`:

```ts
    jumpHostId: optionalString(payload.jumpHostId),
    agentCommandAutoApprove: payload.agentCommandAutoApprove === 'on' || payload.agentCommandAutoApprove === true,
    keepAliveInterval: Number(payload.keepAliveInterval ?? 30),
```

- [ ] **Step 5: Add summary target in the webview script**

In `webview/server-form/index.ts`, add this constant after `summaryRoute`:

```ts
const summaryAgentCommands = document.querySelector<HTMLElement>('[data-summary="agentCommands"]');
```

Then add this helper after `selectedAuth()`:

```ts
function agentCommandAutoApproveEnabled(): boolean {
  const input = document.querySelector<HTMLInputElement>('input[name="agentCommandAutoApprove"]');
  return input?.checked === true;
}
```

Then add this block at the end of `updateSummary()`:

```ts
  if (summaryAgentCommands) {
    summaryAgentCommands.textContent = agentCommandAutoApproveEnabled()
      ? 'Agent commands: trusted for non-destructive commands'
      : 'Agent commands: manual approval';
  }
```

- [ ] **Step 6: Render the switch and summary line**

In `src/webview/ServerFormPanel.ts`, add this constant near the existing `selectedJumpHost` constant:

```ts
  const agentCommandTrustSummary = server?.agentCommandAutoApprove
    ? 'Agent commands: trusted for non-destructive commands'
    : 'Agent commands: manual approval';
```

In the Connection panel field grid, after the Jump Host label block, insert:

```html
          <label class="field-stack field-wide trust-toggle-row">
            <span class="trust-toggle-copy">
              <span class="trust-toggle-title">Trust agent remote commands</span>
              <span class="field-help">Run non-destructive MCP remote commands without asking each time.</span>
            </span>
            <input name="agentCommandAutoApprove" type="checkbox"${server?.agentCommandAutoApprove ? ' checked' : ''}>
          </label>
```

In the summary block, after the route summary line, insert:

```html
          <div class="summary-line" data-summary="agentCommands">${agentCommandTrustSummary}</div>
```

- [ ] **Step 7: Style the switch row**

Append this CSS to `webview/server-form/index.css`:

```css
.trust-toggle-row {
  align-items: center;
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 6px;
  display: flex;
  flex-direction: row;
  gap: 12px;
  justify-content: space-between;
  padding: 10px 12px;
}

.trust-toggle-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.trust-toggle-title {
  color: var(--vscode-foreground);
  font-weight: 600;
}

.trust-toggle-row input[type='checkbox'] {
  flex: 0 0 auto;
}
```

- [ ] **Step 8: Run form tests and verify pass**

Run:

```bash
npm test -- test/webview/ServerFormPanel.test.ts test/webview/ServerFormMarkup.test.ts
```

Expected: all tests in both files pass.

- [ ] **Step 9: Commit form changes**

Run:

```bash
git add src/webview/ServerFormPanel.ts webview/server-form/index.ts webview/server-form/index.css test/webview/ServerFormPanel.test.ts test/webview/ServerFormMarkup.test.ts
git commit -m "feat: add agent command trust switch"
```

## Task 3: Agent Command Execution Behavior

**Files:**
- Modify: `test/agent/AgentToolService.test.ts`
- Modify: `test/agent/AgentTools.test.ts`
- Modify: `src/agent/AgentToolService.ts`

- [ ] **Step 1: Add service-level failing tests**

Append these tests inside `describe('AgentToolService', () => { ... })` in `test/agent/AgentToolService.test.ts`:

```ts
  it('skips command confirmation for trusted non-destructive remote commands', async () => {
    const trusted = { ...server(), agentCommandAutoApprove: true };
    const execute = vi.fn(async () => ({
      serverId: 'server-1',
      serverLabel: 'Production',
      host: 'server-1.example.com',
      command: 'uptime',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      durationMs: 1,
      timedOut: false,
      truncated: false
    }));
    const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage');
    const service = new AgentToolService({
      configManager: { getServer: async () => trusted, listServers: async () => [trusted] } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute } as unknown as RemoteCommandExecutor
    });

    await service.runRemoteCommand({ serverId: 'server-1', command: 'uptime' });

    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(trusted, {
      command: 'uptime',
      cwd: undefined,
      timeoutMs: undefined,
      maxOutputBytes: undefined
    });
  });

  it('still confirms destructive commands for trusted servers', async () => {
    const trusted = { ...server(), agentCommandAutoApprove: true };
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Run Command' as never);
    const execute = vi.fn(async () => ({
      serverId: 'server-1',
      serverLabel: 'Production',
      host: 'server-1.example.com',
      command: 'rm -rf /tmp/app',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1,
      timedOut: false,
      truncated: false
    }));
    const service = new AgentToolService({
      configManager: { getServer: async () => trusted, listServers: async () => [trusted] } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute } as unknown as RemoteCommandExecutor
    });

    await service.runRemoteCommand({ serverId: 'server-1', command: 'rm -rf /tmp/app' });

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'Run remote command on Production (server-1.example.com)?\n\nrm -rf /tmp/app\n\nWarning: this command appears destructive.',
      { modal: true },
      'Run Command'
    );
    expect(execute).toHaveBeenCalled();
  });

  it('cancels destructive commands for trusted servers when the user declines', async () => {
    const trusted = { ...server(), agentCommandAutoApprove: true };
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    const execute = vi.fn();
    const service = new AgentToolService({
      configManager: { getServer: async () => trusted, listServers: async () => [trusted] } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute } as unknown as RemoteCommandExecutor
    });

    await expect(service.runRemoteCommand({ serverId: 'server-1', command: 'rm -rf /tmp/app' })).rejects.toThrow(
      'Remote command was cancelled.'
    );
    expect(execute).not.toHaveBeenCalled();
  });
```

Add this import near the top of `test/agent/AgentToolService.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
```

Replace the existing Vitest import with the line above, then add this before `describe('AgentToolService', () => {`:

```ts
beforeEach(() => {
  vi.restoreAllMocks();
});
```

- [ ] **Step 2: Update failing tool-output expectation**

In `test/agent/AgentTools.test.ts`, update the expected server object in `lists servers without exposing credentials` to include:

```ts
          agentCommandAutoApprove: false
```

Then change the fixture `server` helper return object to include:

```ts
    agentCommandAutoApprove: false,
```

Add a separate test in `test/agent/AgentTools.test.ts` after `lists servers without exposing credentials`:

```ts
  it('lists agent command trust state without exposing credentials', async () => {
    registerTestAgentTools({
      configManager: { listServers: async () => [{ ...server(), agentCommandAutoApprove: true }] } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute: vi.fn() } as never
    });

    const result = await registeredTool('list_ssh_servers').invoke({
      input: {}
    });

    expect(JSON.parse(text(result))).toMatchObject({
      servers: [
        {
          id: 'server-1',
          agentCommandAutoApprove: true
        }
      ]
    });
  });
```

- [ ] **Step 3: Run agent tests and verify failure**

Run:

```bash
npm test -- test/agent/AgentToolService.test.ts test/agent/AgentTools.test.ts
```

Expected: new auto-approval tests fail because `AgentToolService` always confirms and `listServers` does not return the new field.

- [ ] **Step 4: Return trust state from listServers**

In `src/agent/AgentToolService.ts`, add `agentCommandAutoApprove` to the mapped server object:

```ts
        agentCommandAutoApprove: server.agentCommandAutoApprove === true
```

The mapped object should keep all existing fields and add this boolean without exposing credentials.

- [ ] **Step 5: Gate the confirmation dialog**

In `src/agent/AgentToolService.ts`, replace the confirmation block in `runRemoteCommand` with:

```ts
    const warning = isObviouslyDestructive(command) ? '\n\nWarning: this command appears destructive.' : '';
    const needsConfirmation = server.agentCommandAutoApprove !== true || Boolean(warning);
    if (needsConfirmation) {
      const answer = await vscode.window.showWarningMessage(
        `Run remote command on ${server.label} (${server.host})?\n\n${command}${warning}`,
        { modal: true },
        'Run Command'
      );
      if (answer !== 'Run Command') {
        throw new Error('Remote command was cancelled.');
      }
    }
```

Leave the subsequent `executor.execute(...)` call unchanged.

- [ ] **Step 6: Run agent tests and verify pass**

Run:

```bash
npm test -- test/agent/AgentToolService.test.ts test/agent/AgentTools.test.ts
```

Expected: all tests in both files pass.

- [ ] **Step 7: Commit agent behavior**

Run:

```bash
git add src/agent/AgentToolService.ts test/agent/AgentToolService.test.ts test/agent/AgentTools.test.ts
git commit -m "feat: auto approve trusted agent commands"
```

## Task 4: Documentation And Full Verification

**Files:**
- Modify: `README.md`
- Modify: `skills/at-terminal-mcp/SKILL.md`

- [ ] **Step 1: Update README behavior docs**

In `README.md`, update the safety bullet that currently says `run_remote_command` asks for confirmation before every command. Replace it with:

```md
- `run_remote_command` asks for confirmation before commands unless the target server has `Trust agent remote commands` enabled. Dangerous-looking commands still ask for confirmation.
```

Add this adjacent note in both the Chinese and English MCP safety sections if both language sections contain the old confirmation text:

```md
The server trust switch affects only `run_remote_command`. It does not bypass SFTP write authorization or SSH host key trust.
```

- [ ] **Step 2: Update agent skill docs**

In `skills/at-terminal-mcp/SKILL.md`, replace any instruction that says to always wait for the command confirmation dialog with:

```md
For `run_remote_command`, wait for the AT Terminal confirmation dialog unless the selected server is configured with `Trust agent remote commands`. Destructive-looking commands still require confirmation. SFTP write tools still require AT Terminal write authorization.
```

- [ ] **Step 3: Run targeted docs tests**

Run:

```bash
npm test -- test/docs/McpDocs.test.ts test/docs/AtTerminalMcpSkill.test.ts
```

Expected: documentation tests pass. If a test asserts the old exact phrase, update the assertion to match the new trust-switch behavior without removing the safety coverage.

- [ ] **Step 4: Run full verification**

Run:

```bash
npm run typecheck
npm test
npm run build:mcp
```

Expected:

- `npm run typecheck` exits 0.
- `npm test` exits 0.
- `npm run build:mcp` exits 0.

- [ ] **Step 5: Review final diff**

Run:

```bash
git diff --stat
git diff -- src/config/schema.ts src/webview/ServerFormPanel.ts webview/server-form/index.ts src/agent/AgentToolService.ts README.md skills/at-terminal-mcp/SKILL.md
```

Expected: the diff only covers the planned schema, form, agent behavior, tests, and docs changes.

- [ ] **Step 6: Commit docs and final verification changes**

Run:

```bash
git add README.md skills/at-terminal-mcp/SKILL.md
git commit -m "docs: describe agent command trust switch"
```

If any test-only expectation updates were needed in Step 3, include those test files in the same docs commit.

## Self-Review

Spec coverage:

- Per-server boolean setting is covered by Task 1.
- Server add/edit UI, default off, edit-state rendering, payload persistence, and summary display are covered by Task 2.
- `run_remote_command` auto approval and destructive-command confirmation are covered by Task 3.
- `list_ssh_servers` trust-state output is covered by Task 3.
- README and skill safety documentation are covered by Task 4.
- SFTP write authorization and host key behavior remain untouched by design; Task 4 full tests guard broad regressions.

Placeholder scan:

- No `TBD`, `TODO`, or unspecified implementation steps are intentionally left in this plan.

Type consistency:

- The field name is consistently `agentCommandAutoApprove`.
- The setting is optional in stored `ServerConfig` and normalized to explicit booleans where returned by `listServers`.
