# Streamix on the shared Hetzner demo server

Streamix shares the temporary Hetzner server created by TrafficGuard's `ops/hetzner/Start-TrafficGuardHetzner.ps1`. The web app, BFF, gRPC services, PostgreSQL, Redis, and the MediaMTX-backed media service run in one isolated Compose project. TrafficGuard's Caddy instance provides HTTPS; RTMP uses port 1935 directly.

The shared `CX43` is intended for demos and light testing. Do not run a heavy TrafficGuard load test and high-bitrate Streamix broadcasts simultaneously. Use `-ServerType cx53` for that case.

## Start

From the TrafficGuard repository:

```powershell
.\ops\hetzner\Start-TrafficGuardHetzner.ps1
```

The script clones both public repositories and starts both stacks. It prints the generated Streamix web, API, media, and RTMP addresses.

## Stop billing

From the TrafficGuard repository:

```powershell
.\ops\hetzner\Stop-TrafficGuardHetzner.ps1
```

This permanently deletes the shared server and all TrafficGuard and Streamix data. Powering off the server does not stop Hetzner billing.

## Existing Fly.io resources

Do not delete the old Fly Postgres volume until its data is backed up or intentionally abandoned. The stopped Machine, 1GB volume, and dedicated media IPv4 can still incur storage/IP charges.
