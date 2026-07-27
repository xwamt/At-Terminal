# Kubernetes Diagnosis

Read this reference for Pod, Deployment, StatefulSet, DaemonSet, Job, Node, Service, Ingress, autoscaling, scheduling, or PVC symptoms. For mutations, rollout actions, scaling, eviction, deletion, or cluster changes, also read [safe operations](safe-operations.md).

## First-pass read-only checks

Confirm cluster context and namespace before every query.

```sh
# Purpose: inspect workload placement, readiness, and recent namespace events without changing the cluster
kubectl config current-context; kubectl get pods -n <namespace> -o wide; kubectl get events -n <namespace> --sort-by=.metadata.creationTimestamp | tail -n 100
```

Use `kubectl describe` for the affected object, `kubectl logs --since=30m --tail=200` with the explicit container, `kubectl logs --previous` for a restarted container, and `kubectl get ... -o yaml` only for the narrow object. Inspect owner references before acting on a Pod.

## Decision path

- **Pending Pod:** inspect scheduling events, requests, selectors, affinity, taints/tolerations, quota, topology, and PVC binding.
- **CrashLoopBackOff/Error:** inspect current and previous logs, exit reason/code, probes, command, configuration, dependencies, and OOMKilled state.
- **ImagePullBackOff:** verify image name/digest, registry reachability, pull secret reference, service account, and platform compatibility without exposing credentials.
- **Not Ready:** separate startup, readiness, and liveness probes; test the same endpoint from the Pod network context.
- **Service unreachable:** trace labels → selector → EndpointSlice → targetPort → Pod listener → NetworkPolicy → client DNS.
- **Ingress/gateway failure:** verify class/controller, address, routes, TLS secret metadata, backend Service and EndpointSlice; then use [web proxy](web-proxy.md) if applicable.
- **Node pressure:** inspect conditions, allocatable versus requests, evictions, kubelet/container runtime, disk/inode pressure, and affected workload spread.
- **PVC issue:** inspect phase, StorageClass, access mode, topology, events, attachment/mount errors, capacity, and application permissions.
- **Rollout stuck:** compare desired/updated/available replicas, ReplicaSets, strategy limits, Pod failures, PDB, quota, and image digest.

## Escalation and changes

`apply`, `patch`, `edit`, `delete`, `scale`, rollout restart/undo, drain, cordon, eviction, Helm upgrade/rollback, secret changes, and force operations require an explicit plan and approval under Safe Operations. Prefer changing the declarative source of truth; direct cluster edits can be overwritten by GitOps.

## Verification

Verify observed generation, desired/current/available replicas, Pod readiness and restart stability, Service endpoints, probes, events, logs, critical request path, and monitoring. Observe long enough to cover probe and rollout windows.

Official references: [Troubleshoot applications](https://kubernetes.io/docs/tasks/debug/debug-application/), [Troubleshoot clusters](https://kubernetes.io/docs/tasks/debug/debug-cluster/), [Services](https://kubernetes.io/docs/concepts/services-networking/service/).
