# SFTP Remote Edit Design

Date: 2026-04-28
Status: Draft for user review
Related design: `docs/superpowers/specs/2026-04-28-sftp-lrzsz-transfer-design.md`

## 1. Goal

Add a low-friction remote file editing workflow on top of the existing SFTP system.

Users should be able to right-click a remote file, open it in VS Code, edit it locally, and have subsequent saves automatically synchronize the local content back to the remote file. The workflow should feel close to editing a normal VS Code file, while still protecting users from accidental remote overwrites.

## 2. Scope

Included:

- Add a right-click `SFTP: Edit` command for remote files.
- Download the selected remote file into an extension-owned local cache.
- Open the cached file as a normal editable VS Code `file:` document.
- Track an edit session for each opened remote file.
- On the first save in an edit session, ask the user to confirm automatic save-back synchronization.
- After confirmation, upload future saves automatically.
- Support VS Code Auto Save through debouncing and per-file upload serialization.
- Before upload, compare the current remote `mtime` and `size` with the session baseline.
- If the remote file changed externally, pause automatic upload and prompt the user before overwriting.
- Show lightweight synchronization state through the VS Code status bar.
- Clean up local cache files when they are no longer needed and safe to remove.

Deferred:

- Full VS Code `FileSystemProvider` support for `ssh-sftp://` URIs.
- Three-way merge for remote conflicts.
- Persistent offline editing across VS Code restarts.
- Multi-user collaboration semantics beyond `mtime` and `size` conflict detection.
- Directory-level remote editing.
- Large-file streaming or partial-write editing.

## 3. Recommended Approach

Use a dedicated `SftpEditSessionManager` rather than extending the existing read-only preview flow.

The current `SftpPreview` module should remain a read-only preview feature. Remote editing has different lifecycle, synchronization, conflict, and cleanup requirements, so it needs a separate manager with explicit edit-session state.

Longer term, this feature can evolve into a full remote file system provider. That is intentionally out of scope for the first version because it requires a broader implementation of `stat`, `read`, `write`, `delete`, `rename`, directory listing, URI identity, and file watching semantics.

## 4. Architecture

New module:

- `src/sftp/SftpEditSessionManager.ts`

Likely supporting additions:

- `SftpSession.stat(path)` for remote metadata.
- `SftpManager.stat(path)` wrapper that uses the active SFTP session.
- `sshManager.sftp.edit` command registration.
- `SFTP: Edit` package contribution and context menu entry.
- Focused tests for edit-session behavior and package contributions.

`SftpEditSessionManager` owns the local-to-remote mapping and save synchronization lifecycle. It should depend on the existing SFTP manager for download, upload, and remote stat operations.

Each edit session tracks:

```text
remotePath
localUri
serverId
baseRemoteStat { size, modifiedAt }
firstSaveConfirmed
syncState: idle | pending | uploading | conflict | failed
uploadInProgress
pendingUpload
lastError
```

The manager should key active sessions by stable remote identity:

```text
serverId + remotePath
```

It should also maintain a reverse lookup from local file path to session so `workspace.onDidSaveTextDocument` can identify managed documents cheaply.

## 5. Open Flow

When the user chooses `SFTP: Edit` on a file:

1. Validate that the item is a connected remote file.
2. Check whether an edit session already exists for the same `serverId + remotePath`.
3. If a session exists, reveal the existing local document instead of creating a second local copy.
4. If no session exists, read the remote file metadata.
5. Download the remote file into an extension-owned cache path.
6. Record the initial remote metadata as `baseRemoteStat`.
7. Open the cached file with VS Code as a normal editable local file.
8. Register the edit session.

The cache path should be deterministic enough for diagnostics but avoid unsafe remote path characters:

```text
globalStorageUri/sftp-edit/<server-id>/<hash(remotePath)>/<safe-file-name>
```

This prevents two remote files with the same basename from colliding.

## 6. Save Synchronization Flow

The manager listens to `vscode.workspace.onDidSaveTextDocument`.

For managed local files:

1. Debounce the save event for a short interval, such as 500-1000 ms.
2. If the session has not confirmed automatic sync, ask once:
   `Enable automatic sync to <remotePath> for this edit session?`
3. If the user declines, do not upload this save. Keep the document open and the session registered.
4. If confirmed, queue an upload for the latest saved local content.
5. Before uploading, fetch current remote metadata.
6. If the remote metadata matches `baseRemoteStat`, upload the local file.
7. After upload, fetch or update remote metadata and store it as the new `baseRemoteStat`.
8. Update the session state and status bar.

Successful save-back should not show a disruptive notification. It should only update the status bar briefly.

## 7. Auto Save Behavior

Auto Save is supported.

The implementation must handle save bursts from Auto Save, format-on-save, and repeated manual saves:

- Debounce save-triggered uploads per edit session.
- Allow only one upload at a time for a given session.
- If a save occurs while an upload is in progress, mark the session as pending.
- When the active upload completes, upload the latest local file once more if pending is set.
- Never run concurrent uploads for the same remote file.

State transitions:

```text
idle + save -> pending -> uploading -> idle
uploading + save -> uploading with pending=true
uploading with pending=true -> upload latest after current upload finishes
conflict + save -> remain blocked until user chooses how to proceed
failed + save -> retry through the same save queue
```

This keeps normal editing unobtrusive while preventing repeated saves from creating remote upload races.

## 8. Conflict Handling

Before every upload, compare the current remote metadata with the session baseline:

```text
currentRemoteStat.size === baseRemoteStat.size
currentRemoteStat.modifiedAt === baseRemoteStat.modifiedAt
```

If both values match, the remote file is considered unchanged and upload may proceed.

If either value differs, treat it as a conflict. Pause automatic upload and prompt the user with two primary actions:

- `Overwrite Remote`: upload the current local file and accept it as the new remote baseline.
- `Cancel Upload`: do not upload. Keep the local document open and leave the session in a conflict or failed state.

The first version may also offer `Compare` as a secondary action. `Compare` should download the current remote file into a separate temporary copy and open a VS Code diff against the local edit file. It is not required for the MVP.

The first version should not attempt automatic merge.

## 9. Status and User Feedback

The default path should be quiet. Normal successful saves should not produce notifications.

Use a status bar item for active or recently changed sync state:

- `$(sync~spin) Uploading remote file...`
- `$(check) Remote file synced`
- `$(warning) Remote file changed`
- `$(error) Remote sync failed`

Behavior:

- Show upload state while an upload is active.
- Show success briefly, then hide or return to idle.
- Keep warning/error states visible until resolved.
- Clicking a warning or error status should offer the relevant action, such as retry, overwrite, cancel upload, or show error details.

Use modal or warning messages only for:

- First-save automatic synchronization confirmation.
- Remote conflict resolution.
- Close cleanup when unsynchronized local changes may be lost.
- Upload failure that requires user action.

## 10. Disconnection and Reconnection

Closing or disconnecting the active terminal should not forcibly close local edit documents.

If the user saves while the remote is disconnected:

- Keep the local file intact.
- Mark the session as failed or pending with a readable disconnected reason.
- Show a status bar error.
- Allow the user to retry after reconnecting to the same server.

Sessions should be associated with `serverId + remotePath`, not only a terminal instance. This allows a local edit session to survive a terminal reconnect within the same VS Code session.

The MVP does not need to restore edit sessions after VS Code restarts.

## 11. Cleanup Strategy

Local edit files are stored under the extension-owned `sftp-edit` cache directory.

On document close:

- If the session is idle and there is no pending, failed, or conflict state, remove the local cache file and unregister the session.
- If there may be unsynchronized local content, prompt the user:
  - `Keep Local Copy`
  - `Discard Local Copy`

On extension startup:

- Remove stale cache files that are clearly not attached to active sessions and older than a conservative retention period, such as 7 days.
- Avoid deleting files from a previous session if the implementation cannot confidently determine they are safe to remove.

On command re-open:

- If an active session exists, reuse and reveal it.
- If no active session exists but a stale local cache file exists, prefer downloading a fresh remote copy for the MVP.

## 12. Error Handling

Required readable errors:

- No connected SSH terminal is active.
- Remote file no longer exists.
- Permission denied while reading or writing the remote file.
- SFTP connection failed.
- Local cache path cannot be created or written.
- Remote metadata cannot be read.
- Upload failed.
- Remote disconnected before upload could complete.

Errors should not expose passwords, private keys, or unnecessary local path details.

Failed uploads must not update `baseRemoteStat`. The baseline should only move after a confirmed successful upload.

## 13. Security and Data Safety

Requirements:

- Store editable cache files only under the extension-owned storage directory.
- Sanitize local filenames.
- Use hashed remote path components to avoid collisions and path traversal.
- Do not log credentials or secret values.
- Do not overwrite remote files without first-save confirmation for the edit session.
- Do not overwrite externally changed remote files without explicit conflict confirmation.
- Do not create multiple editable local copies for the same active `serverId + remotePath`.

## 14. Testing Strategy

Unit tests:

- Session key generation for `serverId + remotePath`.
- Cache path generation and filename sanitization.
- Save debounce and upload coalescing.
- Single-session upload serialization.
- Conflict detection using `mtime` and `size`.
- First-save confirmation behavior.
- Failed upload does not advance the baseline.

Integration tests:

- Package contributes `sshManager.sftp.edit`.
- Context menu shows `SFTP: Edit` only for connected SFTP file items.
- Opening the same remote file twice reuses the existing edit session.
- Save event for unmanaged local files is ignored.
- Save event for managed local files queues upload.

Manual tests:

- Right-click a remote file and edit it in VS Code.
- First save asks for automatic sync confirmation.
- Later manual saves upload without prompting.
- Auto Save uploads without duplicate concurrent transfers.
- Format-on-save does not cause upload races.
- External remote change triggers conflict prompt.
- Overwrite conflict path updates the remote file.
- Cancel conflict path preserves local edits.
- Disconnect during editing does not close the local file.
- Reconnect and save can retry upload.
- Closing a clean synced document removes the cache file.
- Closing a document with failed or pending upload warns before discarding.

## 15. Milestones

### M1: Remote Stat and Command Surface

- Add remote `stat` support to SFTP session and manager.
- Add `sshManager.sftp.edit` command and menu contribution.
- Add package contribution tests.

### M2: Edit Session Manager

- Implement cache path creation.
- Download remote files for editing.
- Open cached files as normal VS Code documents.
- Reuse existing sessions for duplicate opens.

### M3: Save-Back Synchronization

- Listen to document save events.
- Add first-save confirmation.
- Add debounce and upload serialization.
- Upload saved local content through existing SFTP manager.

### M4: Conflict and Status UX

- Add remote metadata baseline checks.
- Add conflict prompt with overwrite and cancel actions.
- Add status bar state for upload, success, conflict, and failure.

### M5: Cleanup and Tests

- Clean up synced cache files on close.
- Protect unsynchronized files from silent deletion.
- Add unit, integration, and manual coverage.

## 16. Implementation Defaults

- First-save confirmation applies per edit session, not globally.
- Auto Save is supported from the first version.
- Uploads are quiet on success and visible only through status bar state.
- Conflicts are detected with remote `mtime` and `size`.
- Existing SFTP transfer progress may be reused for long uploads, but normal small-file save-back should avoid noisy notifications.
- The read-only preview command remains available and separate from remote editing.
