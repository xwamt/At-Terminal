# SFTP and lrzsz File Transfer Design

Date: 2026-04-28
Status: Draft for user review
Related design: `docs/superpowers/specs/2026-04-28-ssh-terminal-manager-mvp-design.md`

## 1. Goal

Add built-in SFTP file management and lrzsz terminal transfer support to the SSH Terminal Manager extension.

The first version focuses on a reliable SFTP file browser in the VS Code sidebar. Users can browse the active remote host, upload and download files, perform common remote file operations, and use drag-and-drop from the local filesystem or VS Code Explorer. lrzsz is included as a terminal helper for `rz` and `sz` workflows, but it is not the primary file-management UI.

## 2. Scope

Included:

- Add a second sidebar TreeView named `SFTP Files` under the existing SSH activity bar.
- Make `SFTP Files` follow the currently active SSH terminal tab.
- Show the current server and remote root for the active terminal.
- Browse remote directories with lazy loading.
- Preserve the last loaded file tree when the active terminal disconnects, while disabling transfer and mutation actions.
- Support right-click actions for refresh, upload, download, delete, rename, new folder, copy remote path, read-only preview, and `cd` to directory in the active terminal.
- Support drag-and-drop upload from the local filesystem and VS Code Explorer.
- Show upload and download progress with VS Code notification progress.
- Support cancellation for transfer tasks where the underlying stream can be interrupted.
- Detect `rz` and `sz` lrzsz/ZMODEM flows in the terminal and prompt for local file selection or save location.

Deferred:

- Remote file editing with save-back synchronization.
- A persistent transfer queue or transfer history view.
- Remote tree internal drag-and-drop move.
- Copy and move operations between remote paths.
- Permission editing.
- Hidden-file toggle.
- Directory size calculation.
- Archive and extract actions.
- lrzsz right-click menu entries.
- lrzsz resume, retry queue, and persistent transfer history.

## 3. Architecture

The extension keeps the current terminal architecture and adds a dedicated SFTP layer.

```text
VS Code UI
- SSH Activity Bar
  - Servers TreeView
  - SFTP Files TreeView
- Terminal WebviewPanel
- VS Code progress notifications and dialogs

Extension Host
- command registration
- active terminal tracking
- SFTP tree provider
- SFTP session and transfer lifecycle
- lrzsz detection and transfer bridge
- config, secrets, and host key validation reuse

Remote Host
- ssh2 shell channel for terminal
- ssh2 SFTP channel for file operations
- remote lrzsz command running inside the shell
```

Each terminal tab still owns an independent `SshSession` and shell channel. SFTP operations use the same `ServerConfig` and credentials, but open a separate SFTP channel. The shell channel is not reused for SFTP file browsing, so terminal output and file transfer operations do not block each other.

The active terminal tab is the source of truth for the file tree context. When a `TerminalPanel` becomes active, the extension publishes its server and connection state to the SFTP layer. `SftpTreeProvider` then shows that server's remote file tree. When the terminal disconnects or closes, the tree keeps the latest loaded snapshot and marks transfer and mutation commands unavailable.

## 4. Modules

### `src/sftp/SftpSession.ts`

Owns one SFTP connection for a server context. It exposes operations for:

- connect and dispose
- realpath and directory listing
- upload file
- upload directory recursively
- download file
- download directory recursively
- delete file or directory
- rename path
- create directory

The implementation should validate remote paths before executing operations and convert low-level SFTP errors into readable extension errors.

### `src/sftp/SftpManager.ts`

Tracks the active terminal context and manages SFTP session lifecycle. It coordinates reconnects, disabled state after terminal disconnect, and operation serialization for each active SFTP session.

The first version should run transfer tasks serially per SFTP session. This is simpler and avoids overloading weak remote connections with concurrent streams.

### `src/tree/SftpTreeProvider.ts`

Provides the `SFTP Files` TreeView. It displays:

- no active terminal placeholder
- active server header or root node
- disconnected snapshot state
- remote directory nodes
- remote file nodes
- symlink nodes when metadata identifies them

Directories are lazy-loaded when expanded. Refresh may target the root or a single directory node.

### `src/tree/SftpTreeItems.ts`

Defines tree item types and `contextValue` values for menu enablement:

- `sftpRoot`
- `sftpDirectory`
- `sftpFile`
- `sftpSymlink`
- `sftpDisconnectedDirectory`
- `sftpDisconnectedFile`
- `sftpPlaceholder`

Disconnected nodes keep enough metadata to display names and copy paths, but mutation and transfer commands are disabled by menu `when` clauses and command-level guards.

### `src/lrzsz/LrzszDetector.ts`

Observes terminal output and detects ZMODEM/lrzsz transfer sequences. It should pass ordinary terminal data through unchanged unless a supported transfer sequence is confidently detected.

### `src/lrzsz/LrzszTransfer.ts`

Bridges detected `rz` and `sz` transfers to VS Code file pick/save dialogs and local filesystem streams. The implementation should evaluate a mature library such as `zmodem.js` during planning or implementation. If the library cannot run reliably in the extension host, lrzsz should be split into a follow-up task and not block the SFTP feature.

## 5. Commands and Menus

New command set:

- `sshManager.sftp.refresh`
- `sshManager.sftp.upload`
- `sshManager.sftp.download`
- `sshManager.sftp.delete`
- `sshManager.sftp.rename`
- `sshManager.sftp.newFolder`
- `sshManager.sftp.copyPath`
- `sshManager.sftp.openPreview`
- `sshManager.sftp.cdToDirectory`

Menu behavior:

- Directory nodes: refresh, upload to this directory, download directory, new folder, rename, delete, copy remote path, `cd` to this directory.
- File nodes: download, open/preview, rename, delete, copy remote path.
- Root or empty active view: refresh, upload to current root, new folder, copy current path.
- Disconnected snapshot nodes: copy remote path remains available; transfer and mutation actions are disabled.

All commands must also validate state in the command handler. Menu visibility is not enough protection.

## 6. File Tree Behavior

The default remote root should be the user's login directory. The extension should resolve it through SFTP `realpath('.')` when possible. If that fails, it may fall back to a conservative path derived from the remote user only when the server platform is known.

Hidden files are shown by default in the first version. A hidden-file toggle is deferred.

File preview is read-only. The extension downloads the selected remote file into an extension-owned temporary location, sanitizes the local filename, and opens it in VS Code. It does not watch saves or upload changes back. The preview flow must leave a clear path to future save-back support without implying that first-version previews are editable remote files.

`cd` to directory writes a shell command into the active terminal. The command must quote the remote path safely for POSIX shells. If the active terminal no longer matches the tree context or is disconnected, the command should be rejected with a readable message.

## 7. Drag-and-Drop Upload

The first version supports drag-and-drop upload from:

- the local filesystem
- VS Code Explorer resources

Dropping onto a directory uploads into that directory. Dropping onto a file uploads into the file's parent directory. The first version does not interpret a file drop as an implicit replacement of the target file.

Folder upload recursively creates directories and uploads files. Downloading a directory recursively writes into a user-selected local destination.

Overwrite handling:

- If the target path already exists, prompt for overwrite, skip, or cancel.
- For batch uploads or downloads, include an apply-to-all option.
- Cancel should stop queued files and attempt to interrupt the active stream.

## 8. Progress and Cancellation

Upload and download progress uses `vscode.window.withProgress` with notification location.

Progress should include:

- current operation
- current filename
- completed item count and total item count when known
- byte progress when file size is known
- final success, partial success, or failure message

The first version does not persist transfer history. Each upload or download is an independent task.

## 9. lrzsz Behavior

lrzsz is terminal-driven. Users initiate it by running commands such as `rz` or `sz file` in the remote shell.

First-version behavior:

- Detect supported ZMODEM/lrzsz transfer sequences from terminal output.
- For `rz`, show a local file picker and upload one or more selected files through the terminal protocol.
- For `sz`, show a local destination prompt and save one or more downloaded files.
- Display progress through VS Code notification progress.
- On cancellation, interrupt the transfer when possible and send the appropriate cancellation sequence to the terminal.
- On detection failure, leave terminal output untouched and show a readable error only when a transfer had clearly started.

The lrzsz implementation must not interfere with normal terminal output. The detector should be conservative and only enter transfer mode after a recognized protocol sequence.

## 10. Error Handling

The extension must avoid accidental remote file changes.

Required confirmations:

- delete file
- delete directory
- overwrite file
- overwrite directory contents
- recursive upload when conflicts are found
- recursive download when conflicts are found

Required readable errors:

- no active SSH terminal
- active terminal disconnected
- SFTP connection failed
- remote path not found
- permission denied
- local path not writable
- insufficient remote or local disk space when detectable
- transfer interrupted
- lrzsz protocol failure

Disconnected snapshots remain visible but must not allow transfer or mutation commands. Command handlers should reject these operations even if invoked manually.

## 11. Security

SFTP reuses existing server config, `SecretStorage`, private key path handling, and host key validation. It must not introduce a new credential store.

Security requirements:

- Do not log passwords, private key contents, or raw secret values.
- Do not copy private key contents into persistent storage.
- Sanitize local temporary preview filenames.
- Keep preview downloads inside an extension-owned temporary directory.
- Prevent remote paths from escaping intended local download destinations.
- Avoid leaking more local path detail than needed in error messages.
- Validate Webview and command inputs before executing file operations.

## 12. Testing Strategy

Unit tests:

- remote path normalization and shell quoting
- tree item context values and disabled-state behavior
- overwrite policy decisions
- error formatting
- preview temp filename sanitization

Integration tests:

- command registration
- `SFTP Files` View contribution
- `SftpTreeProvider` placeholder states
- active terminal context switches the file tree
- terminal disconnect preserves snapshot and disables actions
- menu context values match file, directory, and disconnected nodes

Manual or E2E tests with a local SSH/SFTP container:

- password and private key login still work
- SFTP root resolves to the remote login directory
- directory browsing and refresh
- file upload and download
- folder upload and download
- overwrite, skip, cancel flows
- delete, rename, and new folder
- read-only preview
- drag upload from OS file manager
- drag upload from VS Code Explorer
- switching between terminal tabs updates the file tree
- disconnected terminal preserves snapshot and disables actions
- `rz` upload
- `sz` download

## 13. Milestones

### M1: SFTP View Skeleton

- Add `SFTP Files` TreeView contribution.
- Add placeholder states.
- Add active terminal context tracking.
- Add initial command registrations and menu contributions.

### M2: SFTP Session and Directory Browsing

- Implement SFTP connection lifecycle.
- Resolve remote root.
- Lazy-load directories.
- Preserve disconnected snapshots.

### M3: File Operations

- Implement refresh, upload, download, delete, rename, new folder, copy path, preview, and `cd`.
- Add overwrite prompts and progress notifications.
- Add cancellation support where possible.

### M4: Drag-and-Drop Upload

- Support local filesystem drops.
- Support VS Code Explorer resource drops.
- Add recursive folder upload and conflict handling.

### M5: lrzsz Terminal Helper

- Add conservative ZMODEM detection.
- Implement `rz` upload and `sz` download through a validated protocol library.
- Add progress and cancellation behavior.

### M6: Tests and Release Polish

- Add unit and integration coverage.
- Run manual SSH/SFTP container tests.
- Update README and manual test notes.

## 14. Implementation Defaults

- SFTP sessions should open lazily on first file-tree expansion or first SFTP command for the active terminal. This avoids making every terminal tab pay the cost of an SFTP connection.
- Drag-and-drop should use VS Code's TreeView drag-and-drop APIs supported by the extension's `engines.vscode` range. If the API cannot support OS filesystem drops directly, the first implementation should still support VS Code Explorer resources and keep OS filesystem drops as the next compatibility task.
- lrzsz should use a mature protocol implementation if it works in the extension host. `zmodem.js` is the first candidate to validate. If no suitable library works reliably, the SFTP feature remains in scope and lrzsz becomes a follow-up task rather than blocking release.
