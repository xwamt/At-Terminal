# Storage and Filesystem Diagnosis

Read this reference for disk-full, inode exhaustion, mount, permission, read-only filesystem, latency, or suspected storage corruption. For deletion, repair, resize, mount, ownership, or filesystem changes, also read [safe operations](safe-operations.md).

## First-pass read-only checks

```sh
# Purpose: inspect filesystem capacity, inode use, mounts, block devices, and recent storage errors
df -hT; df -ih; findmnt; lsblk -f; dmesg --level=err,warn | tail -n 100
```

Scope directory analysis to the affected mount. Prefer `du -x` so it does not cross filesystems, and bound depth or targets. Check deleted-but-open files with `lsof +L1` only when available. Inspect ownership and each path component with `namei -l` when access fails.

## Decision path

- **Capacity full:** identify the correct mount, largest bounded consumers, deleted-open files, log growth, snapshots, and container layers. Do not delete before establishing retention and ownership.
- **inode full:** count file distribution by bounded directory; many tiny files require a different remedy than byte exhaustion.
- **Usage mismatch:** compare `df`, `du -x`, open deleted files, reserved blocks, snapshots, bind mounts, and namespace visibility.
- **Read-only mount:** inspect kernel messages and the underlying device before remounting. Treat possible filesystem damage as an incident.
- **Mount missing or wrong:** compare `findmnt`, `/etc/fstab`, device identity/UUID, automount behavior, and cloud volume attachment.
- **Slow I/O:** correlate device latency/queue evidence, saturation, errors, and application I/O pattern; route host pressure to [Linux host](linux-host.md).
- **Permission denied:** distinguish Unix mode, ownership, ACL, SELinux/AppArmor, parent-directory traversal, and read-only mount state.

## Escalation and changes

Deletion, truncation, filesystem repair, remount, resize, snapshot removal, volume detach, `chmod`, and `chown` are high risk. Confirm backups and an outage plan where appropriate, then obtain explicit approval under Safe Operations. Never run a repair tool against a mounted filesystem unless its official procedure explicitly permits it.

## Verification

Verify capacity and inode headroom, mount flags, kernel logs, application writes, ownership/permissions, and monitoring recovery. Confirm cleanup did not remove active data or break retention requirements.

Official references: [Linux VFS](https://docs.kernel.org/filesystems/vfs.html), [findmnt](https://man7.org/linux/man-pages/man8/findmnt.8.html).
