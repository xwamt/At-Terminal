# Asset Directory Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve SSH asset group workflows by adding group-scoped server creation, editable group suggestions, and group-filtered jump host selection.

**Architecture:** Keep the current VS Code tree, `ServerFormPanel`, and saved `ServerConfig` model. The tree contributes a group context action, the form receives an optional initial group, and the webview filters jump host candidates client-side while still submitting only `group` and `jumpHostId`.

**Tech Stack:** TypeScript, VS Code extension APIs, webview HTML/CSS/DOM script, Vitest.

---

## File Map

- `package.json`, `package.base.json`, `package.mcp.json`: Add the group node context menu entry for `sshManager.addServer` in each extension manifest variant.
- `src/tree/TreeItems.ts`: Keep `GroupTreeItem` as the typed carrier for group names; no new tree node type is needed.
- `src/extension.ts`: Import `GroupTreeItem` and let `sshManager.addServer` accept an optional group item, normalize `Default` to an empty saved group through the form path, and keep edit/connect/delete behavior unchanged.
- `src/webview/ServerFormPanel.ts`: Add an optional `initialGroup` parameter to `ServerFormPanel.open`, derive group suggestions and selected jump host state, render editable group suggestions and two jump host selectors, and normalize `Default` group submissions to empty values.
- `webview/server-form/index.ts`: Drive the two jump host selectors, validation, payload normalization, and summary updates.
- `webview/server-form/index.css`: Add modest layout styling for the paired jump host controls while preserving the current VS Code visual style.
- `test/package.sftp.test.ts`: Add package contribution assertions for the group context action.
- `test/webview/ServerFormMarkup.test.ts`: Cover group suggestions, initial group rendering, jump host grouped markup, and saved jump host selection.
- `test/webview/ServerFormPanel.test.ts`: Cover `Default` group normalization in submit handling.
- `test/tree/ServerTreeProvider.test.ts`: Keep current group context assertions explicit.

---

### Task 1: Manifest Contribution For Group Add

**Files:**
- Modify: `test/package.sftp.test.ts`
- Modify: `package.json`
- Modify: `package.base.json`
- Modify: `package.mcp.json`

- [ ] **Step 1: Write the failing package contribution test**

In `test/package.sftp.test.ts`, extend the existing `view/item/context` assertion with an object for group nodes:

```ts
expect(pkg.contributes.menus['view/item/context']).toEqual(
  expect.arrayContaining([
    expect.objectContaining({
      command: 'sshManager.addServer',
      when: 'view == sshManager.servers && viewItem == group',
      group: 'management@1'
    }),
    expect.objectContaining({
      command: 'sshManager.sftp.edit',
      when: 'view == sshManager.sftpFiles && viewItem == sftpFile',
      group: 'open@1'
    }),
    expect.objectContaining({
      command: 'sshManager.sftp.newFile',
      when: 'view == sshManager.sftpFiles && (viewItem == sftpDirectory || viewItem == sftpFile)',
      group: 'management@1'
    })
  ])
);
```

- [ ] **Step 2: Run the focused package test and verify it fails**

Run:

```powershell
cmd /c npm run test -- test/package.sftp.test.ts
```

Expected: FAIL because there is no `sshManager.addServer` item context menu for `viewItem == group`.

- [ ] **Step 3: Add the group context menu entry to all manifests**

In each of `package.json`, `package.base.json`, and `package.mcp.json`, add this object near the top of `contributes.menus["view/item/context"]`, before the server-only entries:

```json
{
  "command": "sshManager.addServer",
  "when": "view == sshManager.servers && viewItem == group",
  "group": "management@1"
}
```

- [ ] **Step 4: Run the focused package test and verify it passes**

Run:

```powershell
cmd /c npm run test -- test/package.sftp.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```powershell
git add test/package.sftp.test.ts package.json package.base.json package.mcp.json
git commit -m "feat: add group server creation menu"
```

---

### Task 2: Group Item Command Plumbing

**Files:**
- Modify: `test/tree/ServerTreeProvider.test.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Write or strengthen the group tree item test**

In `test/tree/ServerTreeProvider.test.ts`, add this test inside the existing `describe('ServerTreeProvider', ...)` block:

```ts
it('marks group nodes with the group context value used by package menus', () => {
  const item = new GroupTreeItem('prod');

  expect(item.groupName).toBe('prod');
  expect(item.contextValue).toBe('group');
});
```

- [ ] **Step 2: Run the tree test**

Run:

```powershell
cmd /c npm run test -- test/tree/ServerTreeProvider.test.ts
```

Expected: PASS. This test documents the contract used by the new manifest contribution.

- [ ] **Step 3: Update the add command signature**

In `src/extension.ts`, change the tree item import:

```ts
import { GroupTreeItem, ServerTreeItem } from './tree/TreeItems';
```

Then replace the current add command registration:

```ts
vscode.commands.registerCommand('sshManager.addServer', () => {
  void ServerFormPanel.open(context, configManager, () => treeProvider.refresh(), undefined, hostKeyVerifier);
}),
```

with:

```ts
vscode.commands.registerCommand('sshManager.addServer', (item?: GroupTreeItem) => {
  const initialGroup = item instanceof GroupTreeItem ? item.groupName : undefined;
  void ServerFormPanel.open(context, configManager, () => treeProvider.refresh(), undefined, hostKeyVerifier, initialGroup);
}),
```

This will not typecheck until Task 3 updates `ServerFormPanel.open`.

- [ ] **Step 4: Commit Task 2 after Task 3 typecheck passes**

Do not commit this task alone if TypeScript is failing. Commit it together with Task 3 if needed:

```powershell
git add test/tree/ServerTreeProvider.test.ts src/extension.ts
git commit -m "feat: pass selected group to server form"
```

---

### Task 3: Server Form API And Group Normalization

**Files:**
- Modify: `test/webview/ServerFormPanel.test.ts`
- Modify: `src/webview/ServerFormPanel.ts`
- Possibly include: `src/extension.ts` from Task 2

- [ ] **Step 1: Write failing submit tests for `Default` normalization**

In `test/webview/ServerFormPanel.test.ts`, add these tests after the existing blank password edit test:

```ts
it('saves Default group submissions as an empty group', async () => {
  const saveServer = vi.fn();

  await handleServerFormMessage(
    {
      type: 'submit',
      payload: {
        label: 'Ungrouped',
        group: 'Default',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        authType: 'password',
        password: 'secret',
        keepAliveInterval: 30
      }
    },
    undefined,
    { saveServer } as never,
    vi.fn(),
    { dispose: vi.fn(), webview: { postMessage: vi.fn() } } as never
  );

  expect(saveServer).toHaveBeenCalledWith(expect.objectContaining({ group: undefined }), 'secret');
});

it('trims typed group submissions before saving', async () => {
  const saveServer = vi.fn();

  await handleServerFormMessage(
    {
      type: 'submit',
      payload: {
        label: 'Production',
        group: ' prod ',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        authType: 'password',
        password: 'secret',
        keepAliveInterval: 30
      }
    },
    undefined,
    { saveServer } as never,
    vi.fn(),
    { dispose: vi.fn(), webview: { postMessage: vi.fn() } } as never
  );

  expect(saveServer).toHaveBeenCalledWith(expect.objectContaining({ group: 'prod' }), 'secret');
});
```

- [ ] **Step 2: Run the focused panel test and verify it fails**

Run:

```powershell
cmd /c npm run test -- test/webview/ServerFormPanel.test.ts
```

Expected: FAIL because `Default` is currently saved literally.

- [ ] **Step 3: Update `ServerFormPanel.open` signature and submit normalization**

In `src/webview/ServerFormPanel.ts`, update `ServerFormPanel.open` to accept `initialGroup?: string` after `hostKeyVerifier?: HostKeyVerifier`:

```ts
static async open(
  context: vscode.ExtensionContext,
  configManager: ConfigManager,
  onSaved: () => void,
  existing?: ServerConfig,
  hostKeyVerifier?: HostKeyVerifier,
  initialGroup?: string
): Promise<void> {
```

Update the render call:

```ts
renderServerForm(existing, servers, initialGroup)
```

Add this helper near `optionalString`:

```ts
function optionalGroup(value: unknown): string | undefined {
  const group = optionalString(value);
  return group === 'Default' ? undefined : group;
}
```

In `serverFromPayload`, replace:

```ts
group: optionalString(payload.group),
```

with:

```ts
group: optionalGroup(payload.group),
```

- [ ] **Step 4: Run panel and typecheck tests**

Run:

```powershell
cmd /c npm run test -- test/webview/ServerFormPanel.test.ts
npm run typecheck
```

Expected: focused test PASS and typecheck PASS, including the Task 2 `ServerFormPanel.open` call.

- [ ] **Step 5: Commit Task 2 and Task 3 together if Task 2 was not committed**

```powershell
git add src/extension.ts src/webview/ServerFormPanel.ts test/tree/ServerTreeProvider.test.ts test/webview/ServerFormPanel.test.ts
git commit -m "feat: prefill server group from tree"
```

---

### Task 4: Editable Group Suggestions In Markup

**Files:**
- Modify: `test/webview/ServerFormMarkup.test.ts`
- Modify: `src/webview/ServerFormPanel.ts`

- [ ] **Step 1: Add markup tests for group suggestions and initial group**

In `test/webview/ServerFormMarkup.test.ts`, add this second server fixture near `jumpHost`:

```ts
const appServer: ServerConfig = {
  id: 'app-1',
  label: 'App CN',
  group: 'prod',
  host: 'app.example.com',
  port: 22,
  username: 'deploy',
  authType: 'password',
  keepAliveInterval: 30,
  encoding: 'utf-8',
  createdAt: 1,
  updatedAt: 1
};
```

Add these tests:

```ts
it('renders editable group suggestions from existing server groups', () => {
  const html = renderServerForm(undefined, [jumpHost, appServer]);

  expect(html).toContain('name="group"');
  expect(html).toContain('list="serverGroupSuggestions"');
  expect(html).toContain('<datalist id="serverGroupSuggestions">');
  expect(html).toContain('<option value="Default"></option>');
  expect(html).toContain('<option value="prod"></option>');
});

it('prefills the group when adding from a selected group node', () => {
  const html = renderServerForm(undefined, [jumpHost], 'prod');

  expect(html).toContain('name="group" value="prod"');
});

it('displays Default for a group-scoped add from the Default group', () => {
  const html = renderServerForm(undefined, [jumpHost], 'Default');

  expect(html).toContain('name="group" value="Default"');
});
```

- [ ] **Step 2: Run the markup test and verify it fails**

Run:

```powershell
cmd /c npm run test -- test/webview/ServerFormMarkup.test.ts
```

Expected: FAIL because the group input has no datalist and `renderServerForm` does not accept `initialGroup`.

- [ ] **Step 3: Implement group suggestions**

In `src/webview/ServerFormPanel.ts`, change the exported function signature:

```ts
export function renderServerForm(server?: ServerConfig, servers: ServerConfig[] = [], initialGroup?: string): string {
```

Inside it, after `agentCommandTrustSummary`, add:

```ts
const groupSuggestions = groupNames(servers);
const groupValue = server ? server.group ?? '' : initialGroup ?? '';
```

Change the group field markup from:

```html
<label class="field-stack">Group <input name="group" value="${escapeAttr(server?.group ?? '')}" placeholder="Default" autocomplete="off"></label>
```

to:

```html
<label class="field-stack">Group
  <input name="group" value="${escapeAttr(groupValue)}" placeholder="Default" autocomplete="off" list="serverGroupSuggestions">
  <datalist id="serverGroupSuggestions">
    ${groupSuggestions.map((group) => `<option value="${escapeAttr(group)}"></option>`).join('')}
  </datalist>
</label>
```

Add these helpers near `formatJumpHostOption`:

```ts
function groupNames(servers: ServerConfig[]): string[] {
  return Array.from(new Set(['Default', ...servers.map((server) => displayGroupName(server.group))])).sort((a, b) =>
    a.localeCompare(b)
  );
}

function displayGroupName(group: string | undefined): string {
  const trimmed = group?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'Default';
}
```

- [ ] **Step 4: Run the markup test**

Run:

```powershell
cmd /c npm run test -- test/webview/ServerFormMarkup.test.ts
```

Expected: PASS for group suggestion tests. Existing jump host tests may still expect old flat jump host markup and can remain passing until Task 5 changes them.

- [ ] **Step 5: Commit Task 4**

```powershell
git add src/webview/ServerFormPanel.ts test/webview/ServerFormMarkup.test.ts
git commit -m "feat: add editable server group suggestions"
```

---

### Task 5: Grouped Jump Host Markup

**Files:**
- Modify: `test/webview/ServerFormMarkup.test.ts`
- Modify: `src/webview/ServerFormPanel.ts`

- [ ] **Step 1: Replace flat jump host markup expectations**

Update the existing `renders jump host options in the connection panel` test to assert the new controls:

```ts
it('renders grouped jump host controls in the connection panel', () => {
  const html = renderServerForm(undefined, [jumpHost, appServer]);

  expect(html).toContain('name="jumpHostGroup"');
  expect(html).toContain('name="jumpHostId"');
  expect(html).toContain('Direct connection');
  expect(html).toContain('<option value="Default">Default</option>');
  expect(html).toContain('<option value="prod">prod</option>');
  expect(html).toContain('data-group="Default"');
  expect(html).toContain('Bastion CN - ops@bastion.example.com:22');
  expect(html).toContain('data-group="prod"');
  expect(html).toContain('App CN - deploy@app.example.com:22');
  expect(html).toContain('data-summary="route"');
});
```

Update the selected jump host test to expect both group and server selected:

```ts
expect(html).toContain('<option value="Default" selected>Default</option>');
expect(html).toContain('<option value="jump-1" data-group="Default" selected>');
expect(html).toContain('Route: via Bastion CN');
```

- [ ] **Step 2: Run the markup test and verify it fails**

Run:

```powershell
cmd /c npm run test -- test/webview/ServerFormMarkup.test.ts
```

Expected: FAIL because the form still renders one flat `jumpHostId` selector.

- [ ] **Step 3: Implement grouped jump host rendering**

In `renderServerForm`, replace the current `jumpHostOptions` and `selectedJumpHost` setup with:

```ts
const jumpHostOptions = servers.filter((candidate) => candidate.id !== server?.id);
const selectedJumpHost = jumpHostOptions.find((candidate) => candidate.id === server?.jumpHostId);
const selectedJumpHostGroup = selectedJumpHost ? displayGroupName(selectedJumpHost.group) : '';
const jumpHostGroups = groupNames(jumpHostOptions);
```

Replace the current `Jump Host` field markup with:

```html
<label class="field-stack">Jump Host Group
  <select name="jumpHostGroup">
    <option value="">Direct connection</option>
    ${jumpHostGroups
      .map((group) => {
        const selected = group === selectedJumpHostGroup ? ' selected' : '';
        return `<option value="${escapeAttr(group)}"${selected}>${escapeHtml(group)}</option>`;
      })
      .join('')}
  </select>
</label>
<label class="field-stack">Jump Host Server
  <select name="jumpHostId"${selectedJumpHost ? '' : ' disabled'}>
    <option value="">Select a server</option>
    ${jumpHostOptions
      .map((candidate) => {
        const group = displayGroupName(candidate.group);
        const selected = candidate.id === server?.jumpHostId ? ' selected' : '';
        return `<option value="${escapeAttr(candidate.id)}" data-group="${escapeAttr(group)}"${selected}>${escapeHtml(
          formatJumpHostOption(candidate)
        )}</option>`;
      })
      .join('')}
  </select>
</label>
```

- [ ] **Step 4: Run the markup test**

Run:

```powershell
cmd /c npm run test -- test/webview/ServerFormMarkup.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```powershell
git add src/webview/ServerFormPanel.ts test/webview/ServerFormMarkup.test.ts
git commit -m "feat: group jump host choices"
```

---

### Task 6: Webview Jump Host Filtering And Validation

**Files:**
- Modify: `webview/server-form/index.ts`
- Modify: `webview/server-form/index.css`
- Modify: `test/webview/ServerFormMarkup.test.ts`

- [ ] **Step 1: Add CSS contract assertions**

In `test/webview/ServerFormMarkup.test.ts`, extend the CSS test with:

```ts
expect(css).toContain('.jump-host-server-field');
```

This will fail until the class is added in CSS and markup.

- [ ] **Step 2: Run focused markup test and verify it fails**

Run:

```powershell
cmd /c npm run test -- test/webview/ServerFormMarkup.test.ts
```

Expected: FAIL because `.jump-host-server-field` is not present.

- [ ] **Step 3: Add jump host field class to markup**

In `src/webview/ServerFormPanel.ts`, change:

```html
<label class="field-stack">Jump Host Server
```

to:

```html
<label class="field-stack jump-host-server-field">Jump Host Server
```

- [ ] **Step 4: Implement filtering and validation in webview script**

In `webview/server-form/index.ts`, add this selector near the existing `jumpHost` constant:

```ts
const jumpHostGroup = document.querySelector<HTMLSelectElement>('select[name="jumpHostGroup"]');
const jumpHostOptions = jumpHost ? Array.from(jumpHost.querySelectorAll<HTMLOptionElement>('option[data-group]')) : [];
```

Add this function near `updateAuthFields`:

```ts
function updateJumpHostFields(): void {
  if (!jumpHost || !jumpHostGroup) {
    return;
  }

  const selectedGroup = jumpHostGroup.value;
  const isDirect = selectedGroup.length === 0;
  jumpHost.disabled = isDirect;

  for (const option of jumpHostOptions) {
    option.hidden = option.dataset.group !== selectedGroup;
  }

  const selectedOption = jumpHost.selectedOptions[0];
  if (isDirect || (selectedOption?.value && selectedOption.dataset.group !== selectedGroup)) {
    jumpHost.value = '';
  }
}
```

In `updateSummary`, keep `jumpHostLabel` as-is but rely on the filtered selector:

```ts
const jumpHostLabel = jumpHost?.selectedOptions[0]?.textContent?.trim() ?? 'Direct connection';
```

In `validatePayload`, before `return true;`, add:

```ts
if (jumpHostGroup?.value && !jumpHost?.value) {
  setSaving(false);
  setTesting(false);
  clearTestStatus();
  setError('Select a jump host server or choose Direct connection.');
  return false;
}
```

In the form input listener, call `updateJumpHostFields()` before `updateSummary()`:

```ts
form?.addEventListener('input', () => {
  clearTestStatus();
  updateJumpHostFields();
  updateSummary();
});
```

After `updateAuthFields();`, initialize jump host state:

```ts
updateJumpHostFields();
updateSummary();
```

Remove the older extra `updateSummary();` call if it would run twice.

- [ ] **Step 5: Add minimal CSS for the field**

In `webview/server-form/index.css`, add near the field styles:

```css
.jump-host-server-field select:disabled {
  opacity: 0.72;
}
```

- [ ] **Step 6: Run markup test and typecheck**

Run:

```powershell
cmd /c npm run test -- test/webview/ServerFormMarkup.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit Task 6**

```powershell
git add src/webview/ServerFormPanel.ts webview/server-form/index.ts webview/server-form/index.css test/webview/ServerFormMarkup.test.ts
git commit -m "feat: filter jump hosts by group"
```

---

### Task 7: Final Verification

**Files:**
- No planned source edits unless verification exposes a bug.

- [ ] **Step 1: Run focused regression tests**

Run:

```powershell
cmd /c npm run test -- test/package.sftp.test.ts test/tree/ServerTreeProvider.test.ts test/webview/ServerFormPanel.test.ts test/webview/ServerFormMarkup.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```powershell
cmd /c npm test
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Inspect final diff**

Run:

```powershell
git status --short
git log --oneline -5
```

Expected: clean working tree after all task commits, with the feature commits visible above the design commit.

---

## Self-Review Notes

Spec coverage:

- Editable group dropdown: Task 4.
- Group right-click `Add Server`: Tasks 1 and 2.
- Selected group prefill: Tasks 2, 3, and 4.
- `Default` saves empty: Task 3.
- Jump host group then server: Tasks 5 and 6.
- No `All groups`: Task 5 renders only direct plus concrete groups.
- Existing data model preserved: Tasks 3, 5, and 6 keep `group` and `jumpHostId`.

No placeholders remain. The plan intentionally avoids group management, drag-and-drop, bulk edit, and multi-hop changes because those are deferred in the approved spec.
