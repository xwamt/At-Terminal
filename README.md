# SSH Terminal Manager

Lightweight VS Code extension for managing direct SSH terminal sessions.

MVP scope:

- Manual server management.
- Password and private key authentication.
- One independent SSH client per terminal tab.
- xterm.js Webview terminal.
- Manual disconnect and reconnect.
- Basic host fingerprint trust.
- SFTP Files sidebar following the active SSH terminal.
- Basic SFTP upload, download, rename, delete, folder creation, preview, and path copy actions.
- Conservative lrzsz/ZMODEM transfer detection in terminal output.

## SFTP Files

Open an SSH terminal from the Servers view. The `SFTP Files` view follows the active terminal tab and shows the remote login directory after the first SFTP load. Use the context menu to refresh, upload, download, rename, delete, create folders, copy paths, preview files, or send `cd` commands to the active terminal.

Drag files from VS Code Explorer into `SFTP Files` to upload them to the target remote directory. Transfer operations run through the extension host and report errors through VS Code notifications.

## lrzsz

When the remote host has `lrzsz` installed, run `rz` or `sz <file>` in the terminal. The extension detects supported ZMODEM transfer sequences and starts the local adapter boundary. Full protocol transfer support depends on validating a compatible protocol implementation in the extension host.

## Development

Install dependencies:

```powershell
npm install
```

Build and test:

```powershell
npm run typecheck
npm run build
npm test
```

Run the extension:

1. Open this folder in VS Code.
2. Run `npm run build`.
3. Press F5 to launch an Extension Development Host.
4. Open the SSH activity bar view.
5. Add a server with password or private key authentication.
6. Connect to open an independent terminal tab.

## Manual SSH Test Container

Use any local SSH server or a disposable container. The MVP must be manually checked for:

- Password login.
- Private key login.
- Terminal input and output.
- Window resize.
- Disconnect.
- Manual reconnect.
- Unknown host trust prompt.
- Changed host key blocking.
- SFTP directory browsing.
- SFTP file upload and download.
- SFTP drag upload from VS Code Explorer.
- lrzsz `rz` and `sz` detection.
