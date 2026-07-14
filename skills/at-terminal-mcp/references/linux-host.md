# Linux Host and Resource Diagnosis

Read this reference for host-wide CPU, memory, load average, OOM, process, kernel, or resource-exhaustion symptoms. For changes, also read [safe operations](safe-operations.md).

## First-pass read-only checks

Collect a bounded snapshot before focusing on one process:

```sh
# Purpose: capture host identity, uptime, load, memory, and top resource consumers
uname -a; uptime; free -m; ps -eo pid,ppid,user,stat,%cpu,%mem,etime,comm --sort=-%cpu | head -n 25
```

Then inspect only the relevant evidence: `vmstat 1 5` for run queue, swap and I/O wait; `/proc/meminfo` for memory composition; `dmesg --level=err,warn | tail -n 100` or bounded kernel logs for OOM and hardware messages; `ulimit -a` and `/proc/<pid>/limits` for limit failures. Check whether tools exist before relying on them.

## Decision path

- **High load average:** distinguish runnable CPU work from uninterruptible I/O (`ps` state `D`). High load is not automatically high CPU.
- **CPU saturation:** identify sustained consumers, thread count, steal time, and cgroup/container limits. Correlate with request rate and the incident start time.
- **Memory pressure:** separate application RSS, page cache, reclaim, swap activity, and cgroup limits. An available-memory value is more useful than treating free memory alone as exhaustion.
- **OOM:** find the kernel OOM event, killed PID, cgroup, allocation context, and preceding growth. Do not merely restart the victim.
- **Process missing or unhealthy:** determine exit status, supervisor behavior, dependencies, file descriptors, and listening sockets before changing it.
- **I/O wait:** route to [storage and filesystems](storage-filesystem.md); do not attribute it to CPU without evidence.

## Escalation and changes

Killing processes, clearing caches, changing limits, adding swap, tuning sysctl, or rebooting is high risk. Present impact, exact target, backup where applicable, verification, and rollback, then obtain explicit approval under Safe Operations.

## Verification

Compare the same bounded signals before and after mitigation. Verify the application health check, error rate, latency, process stability, memory trend, and absence of new kernel warnings. State whether the cause was host pressure, an application leak, workload growth, or an external dependency.

Official references: [Linux PSI](https://docs.kernel.org/accounting/psi.html), [proc filesystem](https://docs.kernel.org/filesystems/proc.html).
