# systemd Service Diagnosis

Read this reference for failed units, restart loops, dependency failures, incorrect startup behavior, or journal investigation. For any reload, restart, enablement, or unit change, also read [safe operations](safe-operations.md).

## First-pass read-only checks

```sh
# Purpose: inspect the unit state, effective definition, dependencies, and recent bounded logs
systemctl status example.service --no-pager --full; systemctl cat example.service; systemctl show example.service -p ActiveState -p SubState -p Result -p ExecMainStatus -p NRestarts; journalctl -u example.service -n 150 --no-pager
```

Use the actual unit name. Check `systemctl list-dependencies` when ordering or dependency failure is suspected. Use `journalctl --since` with a bounded time window to align logs with the first failure.

## Decision path

- **Unit not found:** verify installation, unit search paths, aliases, and whether the deployment actually provides the unit. Do not run `daemon-reload` until a unit file changed.
- **ExecStart failure:** validate executable path, arguments, working directory, user, environment-file presence, permissions, and the program's own config-test command.
- **Exit code or signal:** interpret `Result` and `ExecMainStatus`; correlate the application log and kernel OOM evidence.
- **Dependency or ordering failure:** inspect `Requires`, `Wants`, `After`, mounts, network readiness, and failed dependent units.
- **Restart loop:** inspect `Restart`, `RestartSec`, `NRestarts`, and StartLimit settings. Do not reset the failure counter until the cause is understood.
- **Active but unavailable:** verify the real child process, socket binding, health endpoint, proxy, and downstream dependencies.
- **Configuration drift:** compare `systemctl cat` output, drop-ins, environment sources, and the workspace/deployment definition.

## Escalation and changes

Editing units or drop-ins, `daemon-reload`, `enable`, `disable`, `restart`, `reload`, `reset-failed`, and StartLimit changes are state changes. Validate configuration first and obtain approval under Safe Operations. A reload is not automatically safe; confirm the service documents reload semantics.

## Verification

Verify `ActiveState`, `SubState`, main PID, restart count, listening socket, health check, recent journal, and critical request path. Watch long enough to cover the previous restart interval.

Official references: [systemctl](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html), [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html), [journalctl](https://www.freedesktop.org/software/systemd/man/latest/journalctl.html).
