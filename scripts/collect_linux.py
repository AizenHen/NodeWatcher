#!/usr/bin/env python3
"""Read-only Linux health collector. Python 3.9+, no third-party packages."""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys


def collect(server_id, dns_name):
    checks = []

    def add(name, status, message, category="system"):
        checks.append(dict(name=name, status=status, message=str(message)[:1900], category=category))

    def run(args):
        return subprocess.run(args, capture_output=True, text=True, timeout=15, env={**os.environ, "LC_ALL": "C"})

    try:
        cores = os.cpu_count() or 1
        load = os.getloadavg()[0]
        ratio = load / cores
        add("CPU load", "critical" if ratio >= 2 else "warning" if ratio >= 1 else "healthy",
            f"1-minute load {load:.2f} across {cores} logical CPUs ({ratio:.2f} per CPU). Warning >=1/CPU; critical >=2/CPU.")
    except (OSError, AttributeError) as exc:
        add("CPU load", "unknown", exc)
    try:
        mem = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            key, value = line.split(":", 1)
            mem[key] = int(value.strip().split()[0])
        used = 100 * (1 - mem["MemAvailable"] / mem["MemTotal"])
        add("Memory utilization", "critical" if used >= 95 else "warning" if used >= 80 else "healthy",
            f"{used:.1f}% used, based on MemAvailable (excludes reclaimable cache). Warning 80%; critical 95%.")
    except (OSError, KeyError, ValueError, ZeroDivisionError) as exc:
        add("Memory utilization", "unknown", exc)
    try:
        # Use numeric statvfs values; /proc/mounts escapes spaces and backslashes.
        def unescape(value):
            import re
            return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), value)
        excluded = {"tmpfs", "devtmpfs", "proc", "sysfs", "cgroup", "cgroup2", "squashfs", "overlay", "nsfs", "autofs", "debugfs", "tracefs", "securityfs", "pstore", "fusectl", "configfs", "mqueue", "hugetlbfs", "rpc_pipefs", "binfmt_misc", "efivarfs"}
        checked = set()
        for line in Path("/proc/mounts").read_text().splitlines():
            parts = line.split()
            if len(parts) < 4 or parts[2] in excluded:
                continue
            mount = unescape(parts[1])
            # Network filesystems can block indefinitely; inspect those through dedicated storage monitoring.
            if parts[2] in {"nfs", "nfs4", "cifs", "smb3", "ceph", "glusterfs"}:
                add(f"Filesystem {mount}"[:120], "unknown", "Network filesystem excluded from local capacity checks to avoid blocked I/O.")
                continue
            try:
                stat = os.statvfs(mount)
                device = os.stat(mount).st_dev
                if device in checked or not stat.f_blocks:
                    continue
                checked.add(device)
                used_blocks = stat.f_blocks - stat.f_bfree
                capacity = used_blocks + stat.f_bavail
                used = 100 * used_blocks / capacity if capacity else 0
                add(f"Filesystem {mount}"[:120], "critical" if used >= 95 else "warning" if used >= 80 else "healthy",
                    f"{used:.1f}% used; {stat.f_bavail * stat.f_frsize / (1024**3):.1f} GiB available. Warning 80%; critical 95%.")
                if stat.f_files:
                    inodes = 100 * (1 - stat.f_ffree / stat.f_files)
                    add(f"Inodes {mount}"[:120], "critical" if inodes >= 95 else "warning" if inodes >= 80 else "healthy", f"{inodes:.1f}% inodes used. Warning 80%; critical 95%.")
            except OSError as exc:
                add(f"Filesystem {mount}"[:120], "unknown", exc)
        if not checked:
            # Container roots commonly use overlayfs. Still check / explicitly.
            usage = shutil.disk_usage("/")
            used = 100 * usage.used / usage.total
            add("Filesystem /", "critical" if used >= 95 else "warning" if used >= 80 else "healthy", f"{used:.1f}% used (root fallback). Warning 80%; critical 95%.")
            stat = os.statvfs("/")
            if stat.f_files:
                used = 100 * (1 - stat.f_ffree / stat.f_files)
                add("Inodes /", "critical" if used >= 95 else "warning" if used >= 80 else "healthy", f"{used:.1f}% inodes used.")
    except (OSError, ValueError, ZeroDivisionError) as exc:
        add("Filesystem capacity", "unknown", exc)
    # Run DNS in a subprocess so a wedged resolver cannot hang the collector.
    try:
        dns = run([sys.executable, "-c", "import socket,sys;print(', '.join(sorted({a[4][0] for a in socket.getaddrinfo(sys.argv[1],None)})))", dns_name])
        add("DNS resolution", "healthy" if dns.returncode == 0 else "critical", f"{dns_name}: {dns.stdout.strip() or dns.stderr.strip()}", "network")
    except (OSError, subprocess.TimeoutExpired) as exc:
        add("DNS resolution", "critical", exc, "network")
    try:
        result = run(["systemctl", "--failed", "--no-legend", "--plain", "--no-pager"])
        if result.returncode:
            add("Failed services", "unknown", result.stderr.strip() or "systemctl is unavailable")
        else:
            failed = result.stdout.strip()
            add("Failed services", "critical" if failed else "healthy", failed or "No failed systemd units.")
    except (OSError, subprocess.TimeoutExpired) as exc:
        add("Failed services", "unknown", exc)
    try:
        result = run(["timedatectl", "show", "--property=NTPSynchronized", "--value"])
        value = result.stdout.strip()
        add("Time synchronization", "healthy" if result.returncode == 0 and value == "yes" else "warning" if result.returncode == 0 and value == "no" else "unknown",
            "NTP synchronized." if value == "yes" else "NTP is not synchronized." if value == "no" else result.stderr.strip() or "Synchronization status unavailable.", "time")
    except (OSError, subprocess.TimeoutExpired) as exc:
        add("Time synchronization", "unknown", exc, "time")
    snapshot = {"status": "unavailable", "scope": "Login sessions reported by who; not all graphical sessions", "sessions": []}
    try:
        result = run(["who"])
        if result.returncode == 0:
            sessions = []
            for line in result.stdout.splitlines():
                fields = line.split()
                if len(fields) < 2:
                    raise ValueError("Unrecognized who output")
                sessions.append({"user": fields[0][:120], "connection": fields[1][:120]})
            if len(sessions) > 100:
                raise ValueError("Session limit exceeded")
            snapshot.update(status="collected", sessions=sessions)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    return {"version": 1, "results": [{"serverId": server_id, "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "userSnapshot": snapshot, "checks": checks[:100]}]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server-id", required=True, help="Exact device ID from NodeWatcher inventory")
    parser.add_argument("--dns-name", default=socket.gethostname())
    parser.add_argument("--output", default="reports/linux-health.json")
    args = parser.parse_args()
    import re
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,60}", args.server_id):
        parser.error("server-id must contain 1–60 letters, digits, hyphens, or underscores")
    if not sys.platform.startswith("linux"):
        parser.error("Run this collector on the Linux host you want to inspect")
    result = collect(args.server_id, args.dns_name)
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"NodeWatcher: wrote {len(result['results'][0]['checks'])} checks to {destination}")


if __name__ == "__main__":
    main()
