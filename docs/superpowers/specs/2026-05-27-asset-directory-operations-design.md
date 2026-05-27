# Asset Directory Operations Design

Date: 2026-05-27
Status: Approved for implementation planning

## Goal

Make common SSH asset directory operations easier when users manage many servers across groups.

The selected product direction is a conservative enhancement of the existing server tree and add/edit server form. It keeps the current storage model and form layout, but improves group selection, group-scoped server creation, and jump host selection.

## Scope

Included:

- Let users choose an existing group from the add/edit server form without losing the ability to type a new group.
- Add a group context menu action for creating a server directly inside the selected group.
- Pre-fill the add server form with the selected group when launched from a group node.
- Preserve the current `Default` group semantics by saving `Default` as an empty group value.
- Replace the flat jump host list with a two-step selection: jump host group, then server within that group.
- Keep `Direct connection` as the default jump host state.
- Do not include an `All groups` jump host filter.
- Keep the existing `jumpHostId` configuration field and direct connection behavior.

Deferred:

- Dedicated group management, rename, delete, or reorder actions.
- Drag-and-drop server moves between groups.
- Bulk server editing.
- Multi-hop jump host cycle detection beyond the current self-exclusion behavior.
- Jump host health indicators or server count badges.

## User Experience

The Servers tree already displays groups as top-level items. Group nodes gain a right-click `Add Server` action. Selecting it opens the existing add server form.

When the action is invoked on a non-default group, the form's `Group` field is pre-filled with that group name. When invoked on `Default`, the form can display `Default` to match the tree, but submitting the form saves an empty group so ungrouped servers continue to appear in `Default`.

The form's `Group` field becomes an editable dropdown using the currently saved groups as suggestions. Users can select an existing group or type a new group name. The top-level `Add Server` command opens the same form without a selected group and keeps the default group behavior.

The jump host section changes from one flat selector to two controls:

- `Jump Host Group`: defaults to `Direct connection`.
- `Jump Host Server`: enabled only after a group is selected and populated only with servers from that group.

When `Direct connection` is selected, no `jumpHostId` is submitted. When a group is selected, the server selector lists only servers in that group and excludes the server currently being edited. Editing an existing server with a saved `jumpHostId` automatically selects the referenced jump host's group and server.

## Data Model

No schema change is required.

Server groups continue to use the existing optional `group` field. Empty or missing groups are displayed as `Default`.

Jump host routing continues to use the existing optional `jumpHostId` field. The new group selector is only a UI filter for choosing that ID; it is not stored.

## Technical Design

`GroupTreeItem` already carries `contextValue = 'group'`, so the group context menu can be added through the existing VS Code contribution points. The `sshManager.addServer` command will accept an optional `GroupTreeItem` argument. If present, it passes an initial group value into `ServerFormPanel.open`.

`ServerFormPanel.open` will continue to call `configManager.listServers()` once and pass the saved servers into `renderServerForm`. Rendering derives the group suggestion list from the saved servers. The form uses a text input with a `datalist` for the editable group dropdown.

The jump host UI is rendered with enough data for the webview script to filter client-side. This can be implemented with grouped option metadata or a serialized list of candidate servers embedded in attributes. The submitted payload remains unchanged: only `jumpHostId` is submitted for jump-host routing.

The webview script updates the jump host server selector when the selected jump host group changes. It also keeps the summary panel aligned with the selected group/server or direct connection state.

## Error Handling

The form keeps the existing validation behavior for label, host, username, authentication, and private key requirements.

If the user selects a jump host group but no jump host server, the form blocks saving and shows a clear validation message. A selected group indicates user intent to route through a jump host, so silently treating that state as direct connection would be surprising.

If an existing `jumpHostId` references a missing server, the form should fall back to direct connection in the selectors while the underlying connection path keeps surfacing the current missing jump host error when used. This design does not add repair UI for broken references.

## Testing Strategy

Tree and command tests:

- Verify group nodes expose the expected context for a group context menu.
- Verify `sshManager.addServer` can receive a group item and open the form with that group pre-filled.
- Verify the `Default` group saves as an empty group value.

Form rendering tests:

- Render group suggestions for existing groups.
- Preserve free-form group input.
- Pre-fill the group field for group-scoped add server.
- Render jump host group and server controls.
- Exclude the currently edited server from jump host server options.
- Select the correct jump host group and server when editing a saved `jumpHostId`.

Webview script tests:

- Switching jump host group filters the server selector to that group.
- Selecting direct connection clears the jump host server selection.
- Summary text shows direct connection or `via <server label>` correctly.
- Saving is blocked or validation surfaces a clear message when a jump host group is selected without a server.

Regression tests:

- Existing direct server creation still works.
- Existing edit behavior still keeps blank password edits as saved passwords.
- Existing jump host deletion protection remains unchanged.
- Existing terminal, SFTP, and MCP connection behavior remains unchanged because the stored data model is unchanged.

## Open Decisions

None. The selected behavior is:

- Group input: editable dropdown with saved group suggestions.
- Group context menu: `Add Server` on group nodes.
- Default group persistence: save as empty group.
- Jump host selection: group first, then server in that group.
- All-groups jump host option: not included.
