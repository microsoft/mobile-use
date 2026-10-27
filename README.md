# MSMT architecture MVP

MSMT (Microsoft Mobile Test) is a working name for a proposed mobile automation
service for Android and iOS, hosted on Windows and macOS.

This local `develop` workspace contains only the architecture proposal and a
small, synthetic demo. The previous Android/ADB Copilot plugin implementation
has been removed from this workspace; its history remains on `main`.

**No real device, ADB, WDA, MCP server, approval UI, or authenticated IPC is
implemented here.** Two simulated adapters exercise the same host-side policy
interface. This is not a security sandbox or a claim of hardware support.

## Run locally

Use Node.js 22.2+ and npm:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run demo:msmt
```

The demo exercises task approval, separate action/observation permissions,
privacy handoff, trusted resume, and revocation for simulated Android and iOS
devices. It never reads a phone, account, screenshot, or user file.

```powershell
npm run check
```

The runner resolves native paths without shell glob expansion. Windows and
macOS are the intended host environments; local checks do not prove support
for either platform's device tooling.

## Layout

| Path | Purpose |
| --- | --- |
| [docs/msmt-architecture.md](docs/msmt-architecture.md) | Architecture, trust boundaries, platform differences, and roadmap |
| `src\msmt\service.ts` | In-process host policy core and adapter contract |
| `src\msmt\demo.ts` | Trusted demo harness and synthetic adapters |
| `test\msmt.test.ts` | Permission, lease, handoff, and in-flight request scenarios |
| `scripts\run.mjs` | Platform-neutral launcher for compiled demo/tests |

The `agent` object can request work but cannot approve or resume it. The
separate `control` object stands in for trusted human authorization; the demo
harness invokes it directly, not through an actual user interface. Keep it
outside any future model-facing tools.

Runtime device adapters, client identity, trusted approval, MCP integration,
and optional iOS Runner-side enforcement are future work. See the architecture
document and [discussion #5](https://github.com/microsoft/mobile-use/issues/5).

## Project policies

Project-authored code is [MIT-licensed](LICENSE). See
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) for dependency scope,
[SUPPORT.md](SUPPORT.md) for issue guidance,
[SECURITY.md](SECURITY.md) for private security reporting, and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations.
