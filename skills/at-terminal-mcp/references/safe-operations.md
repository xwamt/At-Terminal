# Safe Operations

Read this reference before every remote state change, including file writes, deployments, restarts, package changes, migrations, permission changes, or destructive commands.

## Authorization boundary

- Diagnosis and inspection authorize read-only work only.
- Perform an ordinary reversible change only when the user explicitly requested that change. State the plan, inspect the current state, back up, make the smallest change, and verify.
- Obtain explicit approval in the conversation before every high-risk action. An AT Terminal or IDE confirmation dialog does not replace conversational approval.
- Request approval again if the target, commands, impact, or rollback plan changes materially.

Treat an action as high risk when it can affect availability, data integrity, security, access, or production traffic. This includes deletion or overwrite; service reload/restart/stop; process termination; package installation, upgrade, or removal; database migration or production-data changes; `sudo`; permission, ownership, account, firewall, routing, DNS, proxy, SSH, scheduled-task, container, or orchestration changes.

## Approval brief

Before a high-risk action, stop and present:

1. Target and reason.
2. Evidence supporting the change.
3. Expected impact and possible interruption.
4. Preconditions and checks.
5. Backup method and location.
6. Exact commands or file operations.
7. Success checks.
8. Rollback triggers and exact rollback steps.
9. Remaining uncertainty.

Ask for a clear approval such as “Proceed with this plan.” Silence, a diagnostic request, an earlier approval, or an IDE popup is not approval.

## File changes and backups

1. Resolve the intended server and environment.
2. Use `sftp_stat_path`, then `sftp_read_file` for bounded UTF-8 text.
3. Determine whether the file is generated and identify its authoritative source.
4. Create a timestamped backup such as `name.bak.YYYYMMDD-HHMMSS` before modifying the original.
5. Verify the backup exists and matches the original by content, size, or checksum. Never merely claim it succeeded.
6. Apply only the necessary change. Use `overwrite: true` only when replacement is intended.
7. Read back the result and run a syntax, dry-run, or validation command when available.

Do not use this text-file workflow for binaries, databases, large files, live state files, keys, certificates, or files whose ACLs, extended attributes, ownership, permissions, or SELinux context must be preserved. Propose a resource-specific backup and rollback method instead.

## Command discipline

- Put a specific `# Purpose:` comment first in every `run_remote_command` command.
- Use non-interactive, bounded commands. Avoid editors, TUI programs, password prompts, pagers, unbounded recursion, and `tail -f`.
- Bound logs by time, line count, and output bytes. Default maxOutputBytes is 64000 (hard cap 256000); when `truncated` is true, narrow the command instead of raising blindly. Do not default to whole-config dumps such as `nginx -T` or `docker compose config`.
- Never print secrets or full `.env` contents. Inspect variable names or presence without values.
- Report stdout, stderr, exit code, timeout, duration, and truncation when relevant.

## SFTP payload discipline

- `sftp_list_directory` returns at most `maxEntries` (default 500, hard cap 5000) plus `truncated`/`total`. When truncated, list a narrower path or raise `maxEntries`.
- `sftp_read_file` defaults to 65536 bytes (hard cap 262144). When truncated, read a smaller slice or raise `maxBytes` explicitly.

## Failure and rollback

If an action fails, stop dependent steps, preserve evidence, check for a partial change, and assess service availability. Roll back when a declared trigger is met. If rollback creates a new risk, explain it and obtain approval. Report partial success as partial success, and label anything not checked as unverified.

After a change, verify more than exit code: check the file or configuration, service state, recent logs, port or health endpoint, critical behavior, and relevant monitoring signals.
