# Agent Remote Command Tools Manual Test

## Preconditions

- AT Terminal extension is installed from the current build.
- At least one SSH server is configured.
- The server can run non-interactive commands such as `pwd`, `uname -a`, and `printf`.
- VS Code Copilot Chat agent mode is enabled.

## Cases

1. Ask the agent: `List my configured SSH servers.`
   - Expected: agent invokes `list_ssh_servers`.
   - Expected: response includes server id, label, host, port, username, and auth type.
   - Expected: response does not include password, private key content, or private key path.

2. Ask the agent: `Run pwd on my active SSH server.`
   - Expected: VS Code shows a modal confirmation with the target server and command.
   - Expected: approving runs the command.
   - Expected: tool result includes stdout, stderr, exitCode, durationMs, timedOut, and truncated.

3. Ask the agent: `Run sleep 180 on server <id> with timeout 1000ms.`
   - Expected: command returns after about one second.
   - Expected: result has `timedOut: true`, `exitCode: null`, and timeout text in stderr.

4. Ask the agent: `Run rm -rf /tmp/at-terminal-danger-test on server <id>.`
   - Expected: confirmation text includes `Warning: this command appears destructive.`
   - Expected: cancelling returns an error and does not invoke SSH exec.

5. Ask the agent: `Run printf 'a%.0s' {1..300000} on server <id>.`
   - Expected: stdout is truncated.
   - Expected: result has `truncated: true`.
