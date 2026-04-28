# SFTP Remote Edit Manual Tests

Date: 2026-04-28

## Setup

- Build the extension with `npm run build`.
- Launch the extension in VS Code Extension Development Host.
- Connect to an SSH server that supports SFTP.
- Open the `SFTP Files` view.

## Cases

- Right-click a remote file and choose `SFTP: Edit`.
- Confirm the file opens as a normal editable VS Code file.
- Save once and confirm the automatic sync prompt appears.
- Choose `Enable Sync` and confirm the remote file is updated.
- Save again and confirm no success notification appears.
- Enable VS Code Auto Save, edit the file repeatedly, and confirm only the final content is uploaded.
- Modify the same remote file outside this editor, save locally, and confirm the conflict prompt appears.
- Choose `Cancel Upload` and confirm local content remains open.
- Save again, choose `Overwrite Remote`, and confirm the remote file matches local content.
- Disconnect the terminal, edit locally, save, and confirm an error status appears without closing the file.
- Reconnect to the same server, save again, and confirm upload can retry.
- Close a clean synced edit document and confirm the local cache file is removed.
- Close an unsynchronized failed edit document and confirm the keep/discard prompt appears.
