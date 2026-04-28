# SSH Terminal Manager

Lightweight VS Code extension for managing direct SSH terminal sessions.

MVP scope:

- Manual server management.
- Password and private key authentication.
- One independent SSH client per terminal tab.
- xterm.js Webview terminal.
- Manual disconnect and reconnect.
- Basic host fingerprint trust.

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
