# Server Management UI Refresh Design

Date: 2026-04-28
Status: Approved for implementation planning

## Goal

Modernize the SSH server management UI without changing the extension's core architecture. The refresh should make adding and editing servers feel clearer, safer, and more VS Code-native, especially for private key authentication.

The selected direction is a lightweight enhancement of the existing single-page server form. It keeps the current Add/Edit Server webview and server tree model, but improves visual hierarchy, authentication selection, file picking, submit feedback, validation, and server list metadata.

## Scope

Included:

- Keep the server add/edit experience as a single webview form.
- Reorganize the form into clearer sections: connection details, authentication, and summary/save.
- Replace the authentication dropdown with two selectable mode cards: Password and Private Key.
- Add a Browse action for private key selection that opens a native VS Code file picker.
- Fill the selected private key path back into the webview form.
- Show a live connection summary such as `username@host:port` and the selected authentication method.
- Add concise authentication guidance text for password and private key modes.
- Add submit loading and disabled states.
- Improve inline error placement and wording.
- Preserve the existing password when editing a server and leaving the password field blank.
- Improve server tree item icon, description, and tooltip information.

Deferred:

- Full server management console with an embedded server list and details pane.
- Multi-step wizard navigation.
- SSH config import.
- SSH agent support.
- Private key passphrase storage or prompt flow.
- Connection testing from inside the form.
- Bulk server management.

## User Experience

### Add/Edit Server Form

The form remains a single page because the existing data model is compact and the current implementation already uses one webview for Add and Edit. The page should read as a small management surface instead of a raw vertical form.

The form layout will have three areas:

- Connection: label, group, host, port, username, and keepalive.
- Authentication: two selectable cards for Password and Private Key.
- Summary & Save: live connection summary, inline error area, and submit action.

The connection section should prioritize scanning. Host and username remain required. Port defaults to `22`; keepalive defaults to `30`.

### Authentication Cards

The current `select` control for authentication will be replaced with two card-like controls. Each card has a title, short description, selected state, and keyboard-accessible behavior.

Password mode shows a password input. In edit mode, leaving the password blank means "keep the existing saved password." The UI should make that explicit without exposing whether a stored secret exists.

Private Key mode shows:

- A read-only or visually file-like path field.
- A Browse button.
- Short helper text explaining that only the local path is saved and the key contents are read only when connecting.

The user can still paste or type a path if the implementation keeps the input editable, but the primary path should be Browse.

### Private Key File Picker

Clicking Browse posts a message from the webview to the extension host. The extension host calls `vscode.window.showOpenDialog` with:

- `canSelectFiles: true`
- `canSelectFolders: false`
- `canSelectMany: false`
- a title such as "Select SSH private key"

If the user selects a file, the extension host posts the selected filesystem path back to the webview. If the user cancels, the form is unchanged and no error is shown.

The selected path is submitted as the existing `privateKeyPath` field, so the persisted data model does not need to change.

### Summary and Save State

The form should show a small live summary built from current field values:

```text
username@host:port
Authentication: Password | Private Key
Group: Default | <group>
```

During submit, the save button is disabled and enters a loading state. This prevents duplicate submits and gives clear feedback if saving takes noticeable time.

If saving succeeds, the existing behavior remains: refresh the server tree and close the panel.

If saving fails, the form stays open, the button returns to normal, and the error is shown inline.

## Extension Host Messaging

The webview currently sends a `submit` message. The refresh adds a second message type:

```ts
{ type: 'selectPrivateKey' }
```

The extension host responds with one of:

```ts
{ type: 'privateKeySelected', payload: { path: string } }
{ type: 'privateKeySelectionCancelled' }
{ type: 'error', payload: string }
```

The submit message remains the source of truth for saving server configuration.

## Data and Security

The existing `ServerConfig` shape remains unchanged. Private key authentication still persists only `privateKeyPath`.

Passwords remain in VS Code `SecretStorage`, not in `ServerConfig`, logs, HTML, or tooltips.

The edit flow changes password handling:

- Add server with password auth: password is required.
- Edit server with password auth and blank password: keep existing stored password.
- Edit server with password auth and non-empty password: replace stored password.

This requires the submit handler to distinguish "password field not provided or blank during edit" from "new password value was supplied." It should avoid passing an empty password to `ConfigManager.saveServer`.

Private key file selection is local file access initiated by the user through the VS Code dialog. The extension does not read the key during selection and does not validate file contents in the form.

## Server Tree Polish

`ServerTreeItem` should remain a normal VS Code TreeItem, but it should provide richer non-sensitive context:

- Icon indicating a remote/server connection.
- Description showing `username@host:port`, as today.
- Tooltip with label, group, host, port, username, auth type, and keepalive.

Tooltip text must not include passwords, private key file contents, or secret material. Showing the private key path is optional; if included, it should be clearly labeled as a local path and should not be shown in compact tree descriptions.

## Components and Responsibilities

### `src/webview/ServerFormPanel.ts`

- Render the refreshed form markup.
- Handle `submit` and `selectPrivateKey` messages.
- Call `showOpenDialog` for private key selection.
- Save server configuration using the existing `ConfigManager`.
- Preserve existing edit IDs and timestamps.
- Keep error formatting centralized through `formatError`.

### `webview/server-form/index.ts`

- Manage authentication card selection.
- Keep hidden or form-compatible `authType` values in sync.
- Toggle password and private key fields.
- Update live summary as fields change.
- Post `selectPrivateKey` and process `privateKeySelected`.
- Disable submit controls while saving.
- Restore controls after webview error messages.

### `webview/server-form/index.css`

- Update visual hierarchy for sectioned form layout.
- Style authentication cards, selected states, helper text, file-picker row, summary area, disabled state, and inline errors.
- Stay within VS Code theme tokens and compact workbench aesthetics.
- Preserve responsive behavior for narrow webview widths.

### `src/tree/TreeItems.ts`

- Improve server icon and tooltip content.
- Keep command behavior unchanged: selecting a server still connects.

## Error Handling

Client-side validation should catch missing label, host, username, and required auth details before posting submit. Extension-side schema validation remains authoritative.

Error display should be inline and specific enough to act on:

- Missing connection fields: show in the form error region.
- Missing password on add: explain that password is required for new password-auth servers.
- Missing private key path: explain that a key file must be selected or entered.
- File picker errors: show a normal inline error and keep the current form state.
- Save errors: restore the save button and keep the form open.

The implementation should avoid modal error dialogs for form validation unless VS Code APIs fail outside the webview flow.

## Testing Strategy

Unit and markup tests should cover:

- Refreshed form renders authentication cards, private key Browse button, summary region, and loading-capable submit button.
- `selectPrivateKey` opens the VS Code file picker and posts the selected path back to the webview.
- Cancelled private key selection leaves the form unchanged.
- Add server with password auth still stores a supplied password.
- Edit server with password auth and blank password does not overwrite the existing secret.
- Private key auth still requires `privateKeyPath`.
- Server tree tooltip includes non-sensitive connection details.

Existing typecheck, build, and test commands remain the verification baseline:

```powershell
npm run typecheck
npm run build
npm test
```

## Acceptance Criteria

- Users can select a private key through a native VS Code file picker instead of manually typing a path.
- The authentication area is visibly clearer than the current dropdown and communicates which mode is active.
- The save button prevents duplicate submissions while saving.
- Editing a password-auth server no longer clears or replaces the saved password when the password field is left blank.
- The form shows a live connection summary before saving.
- Validation and save errors are shown inline and do not close the form.
- Server tree items expose better icon and tooltip information without leaking secrets.
- The existing server config format remains compatible.
