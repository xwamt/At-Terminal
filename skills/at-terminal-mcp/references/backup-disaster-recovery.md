# Backup and Disaster Recovery

Read this reference for backup design, failed backup jobs, restore requests, retention, RPO, RTO, corruption, regional loss, or disaster-recovery exercises. For backup deletion, retention change, restore, failover or data mutation, also read [safe operations](safe-operations.md).

## First-pass read-only checks

Identify data owners, system boundaries, dependencies, consistency requirements, backup type, schedule, retention, encryption/key ownership, storage location, immutability, replication and last successful restore test. State the required recovery point objective (RPO) and recovery time objective (RTO); do not invent them.

Inventory all state needed for recovery: database, object/file data, configuration, secrets/keys, identity and access, infrastructure definitions, certificates, queues and external dependencies. A file copy may not be application-consistent.

## Decision path

- **Backup job failed:** determine first failed stage, credentials, target capacity, network, source consistency, snapshot state, quota and retention interactions. Do not delete older recovery points to make space without approval.
- **Backup reported successful:** verify object existence, size/checksum or catalog metadata, encryption/key availability, retention and an independent restore test. Job success alone is not proof of recoverability.
- **Restore requested:** select a recovery point within RPO, verify chain/dependencies, restore into an isolated target first when possible, and prevent accidental overwrite of current data.
- **Point-in-time recovery:** verify base backup plus complete ordered logs/WAL/binlogs and the exact target time/timezone.
- **Corruption:** stop writes where safely authorized, preserve the damaged state and logs, determine corruption scope and choose a clean recovery point.
- **Disaster or region loss:** follow the declared dependency order, DNS/traffic plan, identity/key availability and split-brain prevention. Measure actual RTO.
- **Restore test:** validate application-level invariants and representative reads, not only mountability or database startup.
- **Retention change:** model RPO, compliance, immutability, storage cost and deletion consequences before change.

## Escalation and changes

Restore, failover, overwrite, backup deletion and retention/key changes are high risk. Present source and target, recovery point, expected data loss, isolation, credentials, validation, cutover, fallback and irreversibility; obtain approval under Safe Operations.

## Verification

Verify checksums/catalog, decryptability, application consistency, dependency connectivity, data invariants, user access, monitoring, achieved RPO/RTO and backup schedule resumption. Record the tested recovery point and evidence.

Official references: [NIST contingency planning guide](https://csrc.nist.gov/pubs/sp/800/34/r1/upd1/final), [Kubernetes backup and restore considerations](https://kubernetes.io/docs/concepts/cluster-administration/cluster-administration-overview/).
