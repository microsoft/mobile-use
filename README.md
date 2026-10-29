# mobile-use

Use GitHub Copilot to observe and interact with a **real Android 11+ phone or
tablet** from Windows, over USB or modern paired wireless ADB.

The plugin lets Copilot read the screen or UI hierarchy, navigate visible
controls, enter supported text, and manage apps on a device you explicitly
select. It includes a local MCP server and a skill that guides setup and use.

**Experimental:** this is a proof of concept, not a released or
production-supported capability. USB observation, navigation, double-taps,
waking, and app management have been verified on one Android 11 phone. Full
paired-wireless acceptance remains **unverified**.

## Requirements

- Windows and GitHub Copilot App with plugin support.
- A maintained Node.js release, minimum **22.2.0**; Node 24 LTS is recommended.
- Current official [Android SDK Platform-Tools](https://developer.android.com/tools/releases/platform-tools).
- A real Android 11+ device exposing Wireless debugging, plus either a
  data-capable USB cable or a trusted, reachable local network for wireless.

Node and Platform-Tools are not bundled. Android Studio, Java, Appium, and an
emulator are not required at runtime. Only double-tap requires explicit approval
to prepare a bundled helper on the phone; other actions remain helper-free.
Windows may need the phone manufacturer's USB driver.

## Install the plugin

The current installation route requires a local build; there is no marketplace
or built-in Copilot distribution. Follow the
[build instructions](CONTRIBUTING.md#build-and-check-the-plugin) to create
`dist\mobile-use`. After reviewing and approving installation, run this from
the repository directory in PowerShell:

```powershell
copilot plugin install (Resolve-Path .\dist\mobile-use).Path
```

Use the absolute path produced by `Resolve-Path`; some Windows CLI versions do
not recognize a relative plugin source. Do not install the repository root:
it does not contain the compiled plugin. Confirm the plugin, skill, and tools
appear in your Copilot App before using a phone.

## Connect your device

Ask Copilot: **"Help me set up mobile-use."** It checks host tools first, then
connected devices, and guides you through the next missing step. A successful
host check alone does not mean a phone is connected or authorized.

You must install prerequisites, change debugging settings, authorize your
computer, and pair/connect devices yourself. Managed-device or network policy
may prohibit debugging; do not bypass it. Setup is not permission to observe
or control the phone.

### Android Platform-Tools on Windows

1. Download the current Windows package from the official
   [Platform-Tools page](https://developer.android.com/tools/releases/platform-tools),
   reviewing Google's download terms yourself.
2. Extract it so ADB is at
   `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`, which the plugin
   discovers automatically. For another location, add its directory to PATH
   or set `MOBILE_USE_ADB_PATH` to the absolute `adb.exe` path.
3. Fully quit and reopen Copilot after changing its environment, then ask it
   to check setup again.

If the local ADB server is missing, Copilot asks before starting it. The shared
server may remain running after the plugin exits, and its first startup may
initialize local ADB host keys. The plugin never kills or restarts an existing
server; conflicts must be resolved without bypassing local policy.

### USB

1. Enable **Developer options** and **USB debugging** on the phone using
   [Android's instructions](https://developer.android.com/studio/debug/dev-options).
   Menu paths vary by manufacturer; do not enable OEM unlocking or unrelated
   security options.
2. Unlock the phone, connect a data-capable USB cable, and approve only the
   intended trusted computer's RSA-debugging prompt. Enter any PIN/password
   only on the phone, never in chat.
3. Ask Copilot to list devices, then choose the exact USB endpoint. An
   `unauthorized` entry needs on-phone approval; an `offline` entry needs its
   connection restored. For an empty list, check the cable, port, and
   [manufacturer's USB driver](https://developer.android.com/studio/run/oem-usb).

### Modern paired wireless

Enable **Wireless debugging** and open its pairing-code dialog on the phone.
In your own terminal, use the addresses shown by Android:

```powershell
$pairingAddress = Read-Host "Pairing address (IP:pairing-port)"
adb pair $pairingAddress
# Enter the pairing code only at adb's interactive local prompt.
$connectionAddress = Read-Host "Wireless debugging connection address (IP:connection-port)"
adb connect $connectionAddress
adb devices -l
```

If `adb` is not on PATH, use the full `adb.exe` path identified during setup.
Pairing and connection ports are different. Discovery may connect automatically;
an explicit connection address can help when mDNS is blocked. Only modern
TLS-paired debugging is supported, not legacy `adb tcpip`.

Ask Copilot to list devices and explicitly choose the wireless endpoint.
USB and Wi-Fi entries may refer to the same phone; the plugin never silently
switches connections. Never share pairing codes or private ADB keys in chat,
screenshots, logs, or issues.

## Use with Copilot

Name the selected device and the safe task you want performed. For example:

> On the selected USB phone, describe the current screen.

> Read the current UI without taking screenshots.

> In this demo app, tap the visible search field and append `sample-01`.
> Do not submit it.

> On the selected phone, double-tap the open non-sensitive photo to test zoom,
> using a 50 ms delay between taps.

> List installed app package names on the selected phone.

Copilot observes before UI input and checks the resulting state after each
action. Screenshot-free mode uses exposed UI elements; coordinate taps and
swipes are unavailable in that mode. Custom-drawn or protected screens may
not expose enough information to continue.

Double-tap accepts a requested delay of 0-250 ms (50 ms by default); actual
timing and app recognition can vary. Before its first use after device selection
or a plugin restart, Copilot asks for approval to upload and run the bundled
helper on that phone. No APK or background service is installed, but the helper
files remain on the device. Preparation does not grant permission to control
other content. See the [helper contract](CONTRIBUTING.md#double-tap-helper-and-preparation)
for implementation details.

App management can launch or force-stop a named installed package, install a
local `.apk`, or uninstall a package for the current Android user. Installation
requires explicit approval of the APK and device; uninstallation requires
approval of the package, device, and **app-data deletion**. Force-stop requires
specific authorization and may discard unsaved state. Installation does not
automatically launch the app.

You can explicitly ask to wake the selected phone. Copilot can dismiss only
an unsecured lock screen; you must handle secure authentication yourself.
Text entry only appends to a focused, non-password native field and supports
up to 256 ASCII letters, digits, spaces, periods, commas, underscores, or hyphens.

## Safety and privacy

Use only approved, non-sensitive demo content and a reversible, non-submitting
journey. Installation and debugging trust are **not** blanket authorization.
Respect Copilot's permission prompts. This POC must not send messages or forms,
change settings or accounts, make purchases, grant permissions, or enter
credentials. Never observe authentication screens or bypass device policy.

Screenshots, UI text, app inventories, and foreground-app metadata returned to
Copilot may be processed by its configured model service. Local device access
does not mean on-device inference. Images and UI dumps stay in server memory
by default, but Copilot/model-side retention follows the host's policies.
Save evidence only with explicit approval of its content and destination.
Screenshot-free mode still exposes potentially sensitive UI text; password
redaction is not a guarantee that the rest of a screen contains no secrets.

Use one controller per phone. If the screen changes or an action's outcome is
uncertain, inspect fresh device state before trying again; do not blindly
replay input. A disconnect requires rediscovery and explicit device selection.
Unloading the plugin does not stop the shared ADB server or revoke the phone's
debugging trust.

Only the primary display and default local ADB server are supported. There is
no iOS, emulator, cloud-device, remote-server, recording, streaming, or
general-purpose file-transfer support.

## Help and contributing

For troubleshooting and safe bug reports, see [Support](SUPPORT.md). Report
security vulnerabilities through [Security](SECURITY.md), not a public issue.

For development setup, build commands, tool contracts, and hardware validation,
see the [contributor guide](CONTRIBUTING.md). Contributions follow the
[Microsoft Open Source Code of Conduct](CODE_OF_CONDUCT.md).

## Licensing

Project-authored code is [MIT-licensed](LICENSE). Third-party dependencies keep
their own licenses, including Apache-2.0-covered code. See
[Third-party notices](THIRD_PARTY_NOTICES) and the contributor guide's
[licensing details](CONTRIBUTING.md#licensing-and-provenance).

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
