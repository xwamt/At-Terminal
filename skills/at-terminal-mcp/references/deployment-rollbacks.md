# Deployments, Releases, and Rollbacks

Read this reference for deployment planning, version drift, failed releases, canary or rolling rollout, rollback, and post-deploy verification. For any deployment or state change, also read [safe operations](safe-operations.md).

## First-pass read-only checks

Identify environment, source commit/tag, artifact or image digest, configuration version, database migration state, current deployment mechanism, ownership and the authoritative source of truth. Compare workspace intent with the actual remote version; do not deploy merely because they differ.

Collect current health, traffic, capacity, active instances, recent changes, dependency status, available rollback artifacts and backup state. Determine whether the release is backward/forward compatible with configuration, schema, queues and cached data.

## Decision path

- **Preflight failure:** stop. Resolve missing artifact, capacity, permission, dependency, configuration validation, backup or rollback prerequisites before changing production.
- **Version drift:** determine whether drift is intentional, emergency/manual, GitOps reconciliation, partial rollout or failed automation. Preserve evidence before reconciling.
- **Rolling deployment:** verify surge/unavailable limits, readiness semantics, graceful shutdown, connection draining and capacity during mixed versions.
- **Canary deployment:** define cohort/traffic share, observation period, baseline, success metrics and automatic/manual abort thresholds before starting.
- **Release regression:** correlate first failure with version/config/schema and affected cohort. Stop promotion; choose rollback or forward fix based on compatibility and recovery time.
- **Rollback:** verify the previous immutable artifact, configuration and schema remain compatible. Rollback is a new deployment, not an inherently safe undo.
- **Partial deployment:** inventory every instance/node and avoid declaring success from the controller summary alone.
- **Migration involved:** use the database Runbook; irreversible or expand/contract schema steps may prevent application rollback.

## Approval brief

Present target, exact artifact digest, change set, expected interruption, rollout stages, capacity, backup, health gates, abort thresholds, rollback artifact/commands and known irreversible effects. Obtain explicit approval under Safe Operations.

## Verification

Verify deployed digest/version on all intended targets, configuration, schema compatibility, readiness, critical transactions, logs, metrics, traces, error/latency versus baseline, and stability through the observation window. Document whether old artifacts and backups remain available.

Official references: [Kubernetes deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/), [Google SRE canarying releases](https://sre.google/workbook/canarying-releases/).
