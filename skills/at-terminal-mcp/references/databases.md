# Database Operations and Diagnosis

Read this reference for database connection, availability, saturation, slow query, lock, replication, storage, backup, or migration symptoms. For query cancellation, failover, schema/data change, migration, restart, parameter change, or restore, also read [safe operations](safe-operations.md).

## First-pass read-only checks

Identify engine, version, topology, role, managed/self-hosted status, connection method, and authoritative monitoring before selecting commands. Never expose passwords, connection strings, query parameters containing secrets, or full production rows.

Collect bounded evidence for availability, connection usage, active/long-running work, wait/lock state, replication health, storage headroom, error logs, and recent deployment/migration events. Prefer existing read-only monitoring views and approved credentials. Set statement/query timeouts for diagnostic queries where supported.

## Decision path

- **Connection failure:** distinguish DNS/TCP/TLS, authentication, authorization, connection limit, pool exhaustion, server recovery, and wrong endpoint/role.
- **Connection saturation:** compare server sessions, pool size, application instances, idle/active distribution, leaks, transaction duration, and recent traffic changes.
- **Slow queries:** capture normalized query identity, latency distribution, plan, rows, waits, indexes/statistics, cache state and concurrency. Do not optimize from one sample alone.
- **Lock or blocking:** identify blocker/waiter graph, transaction age, owner and business operation. Killing a session can roll back substantial work.
- **Replication lag:** determine transport versus apply lag, source load, replica I/O/CPU, long transactions, network, errors, and recovery objectives.
- **Disk growth:** separate tables/indexes, logs/WAL/binlogs, temporary files, bloat, backups and retention. Route filesystem evidence to [storage](storage-filesystem.md).
- **Migration failure:** compare applied version, transaction state, backward compatibility, lock impact, retry semantics, and application version. Never blindly rerun a non-idempotent migration.
- **Data correctness:** preserve evidence, bound queries, avoid writes, and escalate possible corruption to backup/recovery procedures.

## Escalation and changes

Present data scope, lock/availability impact, backup and restore proof, exact statements, transaction behavior, verification queries, and rollback limitations. Obtain approval under Safe Operations. A logical rollback may be impossible after destructive DDL or data mutation; say so explicitly.

## Verification

Verify client connectivity, error rate, pool headroom, representative query latency, wait/lock clearance, replication position, data invariants, storage trend, and application health. Do not use “query completed” as the sole success criterion.

Official references: [PostgreSQL monitoring](https://www.postgresql.org/docs/current/monitoring-stats.html), [MySQL Performance Schema](https://dev.mysql.com/doc/refman/8.4/en/performance-schema.html).
