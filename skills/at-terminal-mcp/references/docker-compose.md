# Docker and Compose Diagnosis

Read this reference for Docker daemon, image, container, health-check, network, volume, or Compose symptoms. For container changes, image pulls, recreation, pruning, or Compose actions, also read [safe operations](safe-operations.md).

## First-pass read-only checks

```sh
# Purpose: inspect Docker health, container state, and bounded recent events
docker version; docker info; docker ps -a --no-trunc; docker events --since 30m --until 0s
```

For the target container, use `docker inspect`, bounded `docker logs --since 30m --tail 200`, and `docker stats --no-stream`. For Compose, run `docker compose ps`, `docker compose images`, and `docker compose config` from the verified project directory. Avoid printing resolved secrets from configuration.

## Decision path

- **Daemon unavailable:** distinguish service failure, socket path, permissions, rootless context, disk exhaustion, and client/daemon mismatch.
- **Container exited:** inspect exit code, OOM state, error, restart policy, logs, mounts, command, and dependency readiness.
- **Restart loop or unhealthy:** compare health-check command/timing with application startup and listen address. Verify the health check from inside the same network context.
- **Image mismatch:** compare immutable digest, tag, creation time, platform, and deployment record; do not assume a mutable tag identifies deployed content.
- **Network failure:** inspect container networks, aliases, DNS, exposed versus published ports, and host binding before changing networks.
- **Volume or persistence issue:** inspect mount source/type/read-only flags, ownership, available capacity, and whether data is ephemeral.
- **Compose drift:** compare `docker compose config`, active labels, image digests, environment-file sources, profiles, and workspace definition.
- **Resource pressure:** inspect cgroup limits, OOM state, CPU/memory usage, and host pressure; route host evidence to [Linux host](linux-host.md).

## Escalation and changes

Starting, stopping, restarting, recreating, pulling, pruning, deleting volumes, changing networks, or running `docker compose up/down` can interrupt service or destroy data. Back up persistent data, state exact objects and rollback image digests, and obtain approval under Safe Operations. Never use broad prune commands as routine cleanup.

## Verification

Verify container identity and digest, stable state beyond the former restart interval, health, logs, published socket, persistent data, dependency connectivity, and an end-user request path.

Official references: [Docker troubleshooting](https://docs.docker.com/engine/daemon/troubleshoot/), [Compose production guidance](https://docs.docker.com/compose/how-tos/production/).
