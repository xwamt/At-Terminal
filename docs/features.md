# Features

AT Terminal MCP combines the base AT Terminal SSH/SFTP workspace with agent-facing MCP and VS Code language model tools.

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

AT Terminal MCP contributes VS Code language model tools and a local stdio MCP server. The MCP server connects back to the running AT Terminal MCP extension, so credentials and host trust stay inside the extension host.

| Tool | Type | Description |
| --- | --- | --- |
| `list_ssh_servers` | read-only | Lists configured SSH servers without exposing passwords or private keys. |
| `get_terminal_context` | read-only | Returns focused, default connected, connected, and known AT Terminal SSH terminal context. |
| `run_remote_command` | command | Runs a confirmed non-interactive SSH command and returns stdout, stderr, exit code, timeout, duration, and truncation metadata. |
| `sftp_list_directory` | read-only | Lists a remote directory through a connected AT Terminal SFTP session. |
| `sftp_stat_path` | read-only | Returns metadata for a remote file or directory. |
| `sftp_read_file` | read-only | Reads bounded UTF-8 text from a remote file. Binary-looking content is rejected. |
| `sftp_write_file` | write | Writes UTF-8 text to a remote file. Existing files require `overwrite: true`. |
| `sftp_create_file` | write | Creates a new remote file, optionally with UTF-8 content. |
| `sftp_create_directory` | write | Creates a new remote directory. |

## Safety Behavior

- `run_remote_command` asks for confirmation before commands unless the target server has `Trust agent remote commands` enabled. Dangerous-looking commands still ask for confirmation.
- The server trust switch affects only `run_remote_command`. It does not bypass SFTP write authorization or SSH host key trust.
- SFTP write tools ask for first-write authorization per server during the current extension host session.
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
