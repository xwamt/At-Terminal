# Features

AT Terminal MCP combines the base AT Terminal SSH/SFTP workspace with agent-facing tools exposed through the shared **AT Series** MCP hub.

## Base AT Terminal Features

The MCP build still includes the base AT Terminal workflow:

- SSH server management.
- Password and private-key authentication.
- Host key verification and changed-host-key blocking.
- SSH terminal tabs.
- SFTP browse, upload, download, and drag upload.
- SFTP create, rename, delete, copy path, and preview.
- Local editing for remote files with upload-on-save.
- Terminal font, scrollback, semantic highlighting, and keep-alive settings.
- `rz`/`sz` sequence detection.

## SSH Terminal

- Manage SSH server configurations.
- Use password or private-key authentication.
- Confirm unknown host fingerprints.
- Block changed host keys for previously trusted hosts.
- Open each SSH connection in an independent terminal tab.
- Disconnect and reconnect sessions.
- Configure terminal font, scrollback, semantic highlighting, and keep-alive behavior.

## SFTP File Management

The `SFTP Files` view follows the active SSH terminal and loads the remote login directory after connection.

Supported actions:

- Browse remote directories.
- Refresh the current directory.
- Go to the parent directory or jump to a typed remote path.
- Upload files.
- Drag files from VS Code Explorer into the SFTP view.
- Download remote files or folders.
- Create files and folders.
- Rename, delete, and copy remote paths.
- Preview remote files.
- Send `cd` commands from a remote directory to the active SSH terminal.

## Local Editing For Remote Files

Use `SFTP: Edit` to open a remote file in a local editor. The extension downloads the file, detects the language, watches saves, and uploads saved content back to the original remote path.

This workflow is useful for:

- Shell scripts.
- Python and Node.js scripts.
- Configuration files.
- Operations and deployment scripts.
- Remote files that need AI-assisted explanation or refactoring.

## MCP And Agent Tools

AT Terminal MCP publishes tools through the shared **AT Series** hub (`~/.at-series/mcp/hub.js`). The hub connects back to the running AT Terminal MCP extension bridge, so credentials and host trust stay inside the extension host.

| Tool | Type | Description |
| --- | --- | --- |
| `list_ssh_servers` | read-only | Lists SSH servers authorized for background connections without exposing passwords or private keys. |
| `get_terminal_context` | read-only | Returns focused, default connected, connected, and known AT Terminal SSH terminal context. |
| `run_remote_command` | command | Runs a confirmed non-interactive SSH command and returns stdout, stderr, exit code, timeout, duration, and truncation metadata. Every command is confirmed unless it is on the read-only allowlist and the server is trusted. stdout/stderr each default to 64000 bytes (hard cap 256000). |
| `sftp_list_directory` | read-only | Lists a remote directory through a connected AT Terminal SFTP session. Returns at most `maxEntries` (default 500, hard cap 5000) plus `truncated`/`total`. |
| `sftp_stat_path` | read-only | Returns metadata for a remote file or directory. |
| `sftp_read_file` | read-only | Reads bounded UTF-8 text from a remote file. Default `maxBytes` 65536 (hard cap 262144). Binary-looking content is rejected. |
| `sftp_write_file` | write | Writes UTF-8 text to a remote file. Existing files require `overwrite: true`. |
| `sftp_create_file` | write | Creates a new remote file, optionally with UTF-8 content. |
| `sftp_create_directory` | write | Creates a new remote directory. |

## Safety Behavior

- SFTP agent writes are authorized one directory at a time. The prompt offers `Allow Once` (the default), `Allow This Folder For 15 Minutes`, and `Allow This Folder For The Session`; no answer ever covers a directory the user was not shown.
- All SSH and SFTP connect paths verify host keys (unknown hosts prompt; changed hosts are blocked).
- Bridges publish into the AT Series registry under `~/.at-series/bridges/<hostApp>/`.
- Bridge requests validate JSON schemas and enforce a maximum body size (2 MiB).
- `run_remote_command` asks for confirmation before every command. `Trust agent remote commands` narrows that to a read-only allowlist (`ls`, `cat`, `grep`, `ps`, `df`, `systemctl status`, `journalctl` and similar); a command leaves the allowlist as soon as it contains a pipe, a redirect, command chaining, a subshell or a variable expansion.
- The server trust switch affects only `run_remote_command`. It does not bypass SFTP write authorization or SSH host key trust.
- Writes outside the directory the SFTP session was opened in are highlighted in the prompt and cannot be granted for the whole session.
- Sensitive paths (`~/.ssh`, `/etc`, `/usr`, `/root`, `*.service`, `authorized_keys`, `sudoers*`, `crontab`) always require a second confirmation and are never remembered.
- Agent SFTP sessions never escalate. A permission-denied write fails; the `sudo -n` fallback exists only in the user-driven SFTP view.
- Read tools do not return passwords, private keys, or SecretStorage values.
- SFTP reads are bounded to avoid flooding agent context with large files.
- Write tools resolve remote paths and do not allow modifying the remote root path.

## Asset Import And Export

Run `AT Terminal: Export Assets` to create an encrypted `.at-terminal-assets` package containing SSH server configuration. Passwords and private key files are optional export choices and are included only when selected.

Run `AT Terminal: Import Assets` in another supported IDE or device to decrypt the package and import the selected assets. Imported private keys are stored in the extension's global storage area and server configs are updated to use those new local paths. SSH host trust records are not migrated, so the first connection after import still asks for host trust confirmation.

## UI And Theme Adaptation

- Webview form for adding and editing servers.
- Clear password and private-key authentication sections.
- Private-key selection through the file picker.
- Inline validation and saving state.
- Icons, sidebars, and forms adapt to the active IDE theme.
