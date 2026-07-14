# Incident Response

Read this reference for outages, degradation, production errors, resource exhaustion, or other time-sensitive service incidents. Also load [safe operations](safe-operations.md) before any state change.

## Triage

1. Confirm the target environment and reported symptom.
2. Determine severity, start time, affected users, and blast radius.
3. Check service health, dependencies, recent deployments, and resource pressure using bounded read-only commands.
4. Establish a timeline from monitoring, logs, deployment events, configuration changes, and restarts.
5. Distinguish symptom, trigger, contributing conditions, and root cause.

Consider recent releases, expired certificates, disk or inode exhaustion, memory pressure, CPU saturation, permissions, network failures, dependency failures, queue growth, database health, and resource limits. Do not rely on application logs alone.

## Stabilization

Prioritize safe restoration of service, but separate temporary mitigation from permanent remediation. Do not default to restarting a service when the cause is unknown. Test one main hypothesis at a time so outcomes remain attributable.

Before a risky mitigation, present impact, backup, verification, and rollback details and obtain explicit user approval as required by Safe Operations. If the evidence suggests intrusion, credential exposure, or data corruption, stop routine remediation, preserve evidence, avoid destroying forensic state, and recommend the appropriate security or data-recovery response.

## Closure

Report:

- Target and environment.
- Symptom, severity, duration, and scope.
- Confirmed facts, likely cause, and unresolved uncertainty.
- Workspace and remote evidence inspected.
- Actions taken, approvals received, and backups created.
- Verification or rollback results.
- Temporary mitigations, permanent follow-up work, and remaining risk.

Never state that service is restored until health checks and critical behavior have been verified. A successful command exit code alone is insufficient.
