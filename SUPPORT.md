# Support

## How to file issues and get help  

This is an experimental Windows/Android real-device POC with a source-only,
fixture-validated iOS/WDA adapter in development and best-effort GitHub issue
support, not a production-supported Microsoft product. Search
[existing issues](https://github.com/microsoft/mobile-use/issues) before opening
a bug, question, or feature request. Follow the [README](README.md) for supported
scope and setup boundaries, and the
[contributor guide](CONTRIBUTING.md#real-hardware-acceptance-runbook) for hardware
validation instructions.

Include the plugin version, Windows/Node/Copilot App/CLI/Platform-Tools versions,
Android version/build, selected transport kind, stable tool error code, expected
versus actual behavior, and whether the reproduction used fixtures or real
hardware. Use a device alias and sanitized steps. Distinguish failed discovery
from a successful empty inventory, dispatch from verified UI state, and
fixture-only results from actual App/USB/wireless results.

For source-only iOS development, include the source revision, iOS/WDA versions,
server mode, stable error code, and whether the failure concerns user-managed
forwarding, session selection, capture or input. The checked-in plugin does not
include this adapter. Personal-signing/onboarding support and real iOS hardware
acceptance are pending; see [iOS MVP status](docs/ios-mvp.md). Never post signing
materials, device identifiers or unreviewed WDA responses/logs.

Do not post pairing codes, private ADB keys, credentials, raw serials/IPs,
account/app data, environment dumps, command traces with input text, or
unreviewed screenshots/UI dumps. A minimal non-sensitive error code and status
is preferable to a full transcript. Do not revoke debugging trust, change
network/OS settings, or install helpers merely to reproduce a report.

Report suspected security vulnerabilities through [SECURITY.md](SECURITY.md),
not a public issue.

## Microsoft Support Policy  

Support for this project is limited to the resources listed above.
