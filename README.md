# mobile-use

A Windows Copilot plugin POC for observing and performing bounded,
user-authorized interactions on a **real Android 11+ phone or tablet**, over
USB or modern paired wireless ADB. The plugin bundles a local stdio MCP server
and a usage skill. Its project-owned Android adapter invokes installed
Platform-Tools directly; it does not import, vendor, or launch mobile-mcp.

**Status:** local fixture, protocol, and copied-artifact checks are available.
Copilot App tool loading and all six app-management operations have been
verified through the reinstalled plugin over USB on one Android 11 phone,
including termination verification after a package-diagnostic parser fix.
Hierarchy-only observation and element-reference tab navigation have also been
verified through the reinstalled Copilot App plugin over USB on that phone.
Screenshot-coordinate navigation through menu, product, checkout, and coupon
screens has also been verified in one non-submitting journey through the
reinstalled plugin over USB. A changed interaction region correctly rejected
input, and a fresh observation allowed navigation to continue without manual
taps. Paired-wireless acceptance remains **unverified**.
This is not a released or production-supported capability.

## Prerequisites

- Windows and GitHub Copilot App with plugin support.
- A maintained Node.js release, minimum **22.2.0**; Node 24 LTS is recommended.
  Node and Android Platform-Tools are not included in the plugin.
- Current official [Android SDK Platform-Tools](https://developer.android.com/tools/releases/platform-tools).
  Android Studio, Java, Appium, an emulator, and a phone-side helper are not
  required. Windows may need the phone manufacturer's USB driver.
- A real Android 11+ device exposing Wireless debugging, a data-capable USB
  cable, and a trusted, reachable local network for wireless.

The device owner must enable debugging and authorize/pair their own device.
Managed-device/network restrictions may prohibit this; do not bypass them.
For development, npm is also required.

## Build and install locally

From this repository in PowerShell:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

`check` typechecks, runs no-phone tests, and builds/checks `dist\mobile-use`.
The artifact includes `plugin.json`, `mcp.json`, `skills\mobile-use\SKILL.md`,
`server\index.mjs`, and license notices. Runtime dependencies are bundled; its
launcher is `node`, not a download-on-launch npm/npx command.

**Only after reviewing and explicitly approving plugin installation**, install
the built directory:

```powershell
copilot plugin install (Resolve-Path .\dist\mobile-use).Path
```

This is the documented local installation route, not a claim that App loading
has already passed. Use the absolute path shown above: some Windows CLI versions
do not recognize a relative `.\` plugin source. Confirm the plugin, skill, and
thirteen tools appear in your actual Copilot App before using hardware. If the App
cannot load this format,
record that incompatibility rather than substituting manual MCP registration.
Rebuild and use Copilot's plugin update/reinstall flow when changing the local
artifact; an installed/cache copy may not follow source edits.

Do not install the GitHub repository root directly: this source checkout does
not contain the compiled, root-level plugin artifact. Marketplace publishing
and built-in Copilot distribution are outside this POC.

## User-performed device setup

The plugin guides first-time users through missing prerequisites instead of
assuming they are already configured. Ask Copilot to **"help me set up
mobile-use"** or start a phone task: the skill and MCP startup instructions
begin with `mobile_doctor`, then `mobile_list_devices`, and explain the next
missing step one at a time. Already working connections skip unnecessary setup.

`mobile_doctor` returning `status: ready, scope: host` means only that the
installed Platform-Tools passed the version check. It does **not** prove that
Developer options/debugging are enabled, a phone is connected/authorized, or
device qualification passed. Doctor, inventory, and supported setup errors
include `setup: { stage, steps }` guidance; errors remain errors, not empty
device lists. Server startup uses a separate, explicitly approved operation;
doctor and ordinary inventory never start a server automatically.

The user performs installation, settings changes, host authorization, and
pairing/connection. The plugin can start a missing local ADB server only after
specific approval. It never installs Platform-Tools/
drivers, enables debugging, pairs/connects a device, changes a keyboard, or
installs DeviceKit. Setup does not grant permission for observation or control.

### Android Platform-Tools on Windows

Only **Android SDK Platform-Tools** is required, not Android Studio or the full
SDK. If `mobile_doctor` reports missing/old ADB:

1. Download the current Windows package from the official
   [Platform-Tools page](https://developer.android.com/tools/releases/platform-tools)
   and review Google's download terms yourself.
2. Extract its `platform-tools` directory under `%LOCALAPPDATA%\Android\Sdk`,
   yielding `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`. The plugin
   discovers this location without a PATH change. For another location, add
   its directory to PATH or set `MOBILE_USE_ADB_PATH` to the absolute `adb.exe`
   path. If an explicit override points to a missing/old executable, correct it.
3. Fully quit/reopen Copilot after changing its environment, then rerun
   `mobile_doctor`. Node must also meet the minimum version above for the MCP
   server to start at all.

If discovery reports `ADB_SERVER_UNAVAILABLE`, Copilot asks for permission to
call **`mobile_start_adb_server`**. After approval, the tool reuses a compatible
server at `127.0.0.1:5037`, or starts one if the port refuses connections. It
verifies the ADB protocol/version and retries read-only inventory before
returning device setup/selection guidance. It never selects or controls a
phone, accepts a debugging prompt, or silently starts from doctor/discovery.
An unavailable host server says nothing about the phone's connection state.

The shared server may remain running after the plugin exits, and first startup
may initialize standard local ADB host keys. No key material is returned.
The startup path uses `adb -L tcp:localhost:5037 server nodaemon` in a detached
process. ADB requires `localhost` rather than a numeric IPv4 address in this
listener specification; protocol probes still connect to `127.0.0.1:5037`.
It does not use the client's `start-server` command, because that command can
automatically kill/restart an incompatible daemon. Readiness and inventory
checks and ordinary inventory use read-only ADB protocol requests, so even a
concurrent startup cannot cause these paths to replace another server.
The initial protocol probe is bounded to one second, post-launch readiness to
five seconds, and inventory to five seconds. Only one launch is attempted.

`ADB_SERVER_CONFLICT` reports an occupied, unresponsive, malformed, or
incompatible listener; `ADB_SERVER_START_FAILED` reports unverified startup.
Neither triggers a restart or automatic second startup attempt. After a
post-launch error/cancellation, `actionMayHaveRun: true` means the daemon may
already be running; verify its state before retrying. A startup attempt clears
old device tokens/observations, while reuse preserves a still-current target.
Do not bypass local policy or change firewall settings to recover.

### USB

1. On the phone, open **Settings > About phone** and tap **Build number** seven
   times to enable **Developer options**. Paths vary: Samsung often uses
   **Software information > Build number**, while some Xiaomi/MIUI versions
   use the **MIUI version** entry. Ask Copilot for model-specific guidance if
   needed. Enter any device PIN/password only on the phone, not in chat.
2. In **Developer options**, enable **USB debugging**. Enabling Developer
   options alone is not enough. Do not enable OEM unlocking or unrelated
   security options. See [Android's official instructions](https://developer.android.com/studio/debug/dev-options).
3. Unlock the phone, attach a data-capable USB cable, and accept only the
   intended computer's RSA-debugging prompt. Debugging trust grants that host
   device access, so approve only a trusted computer.
4. Ask Copilot to rerun `mobile_list_devices`. An `unauthorized` entry needs
   on-phone approval; `offline` needs the chosen connection restored. If the
   inventory is empty, check cable/port and the manufacturer's
   [Windows USB-driver guidance](https://developer.android.com/studio/run/oem-usb);
   it does not necessarily mean Developer options is disabled. Do not bypass
   managed-device restrictions.

Once an online/selectable endpoint appears, choose its exact endpoint ID.
`mobile_select_device` then verifies supported physical hardware before any
observation/control; neither doctor nor discovery silently selects a phone.

### Modern paired wireless

On the phone, enable Wireless debugging and open its pairing-code dialog.
In your own terminal, enter the addresses shown by Android:

```powershell
$pairingAddress = Read-Host "Pairing address (IP:pairing-port)"
adb pair $pairingAddress
# Enter the pairing code only at adb's interactive local prompt.
$connectionAddress = Read-Host "Wireless debugging connection address (IP:connection-port)"
adb connect $connectionAddress
adb devices -l
```

Pairing and connection ports are different. Discovery may connect automatically,
but explicit connection-address entry is useful when corporate/isolated
networks block mDNS. Modern paired debugging uses TLS; legacy unencrypted
`adb tcpip` setup is not supported.

Never send pairing codes or ADB keys to Copilot, screenshots, logs, or issues.
If the device or network blocks pairing, stop and report the restriction.

The server resolves `adb.exe` from `MOBILE_USE_ADB_PATH` (optional absolute
`.exe` path), `ANDROID_HOME`/`ANDROID_SDK_ROOT`, the standard per-user Android
SDK directory, or absolute PATH entries. After changing the launch environment,
restart the plugin. Only the local ADB server at `127.0.0.1:5037` is supported;
remote/non-default server overrides fail explicitly. The plugin does not
kill/restart the shared ADB server or alter global ADB/network settings.

## Tool workflow

| Tool | Contract |
| --- | --- |
| `mobile_doctor` | First-use host ADB/version check with setup guidance. `ready` is host-only; does not enumerate or control devices. |
| `mobile_start_adb_server` | After explicit approval, reuse/start only the default local server, verify readiness, and return fresh inventory/setup steps. Never kills/restarts, selects, or controls a device. |
| `mobile_list_devices` | Show endpoint IDs, transport IDs/kinds, all states, and next setup/selection steps. Discovery failure is not an empty list. |
| `mobile_select_device` | Bind exactly the endpoint the user chose; qualify Android/physical-device and wireless evidence; return a session target token. |
| `mobile_wake` | With explicit permission and a target token, wake the display and dismiss only an unsecured lock screen. No observation or screen capture; secure/unknown lock states require manual unlocking. |
| `mobile_observe` | Require that token; return a fresh observation ID, display geometry, hierarchy/status/warnings, and a separate PNG image block when usable. Set `includeScreenshot: false` to read only hierarchy/display state without capturing an image. |
| `mobile_act` | Require target and latest observation IDs; dispatch one bounded action and return the next observation or an explicit unknown/unverified outcome. |
| `mobile_list_apps` | With a target token, list all installed package names, including system packages, for the current Android user. No screen capture. |
| `mobile_get_foreground_app` | With a target token, read the primary display's foreground package, activity, and Android user without capturing the screen. |
| `mobile_launch_app` | Launch a specifically requested installed package for the current Android user and verify it is in the foreground. No observation required. |
| `mobile_terminate_app` | With specific authorization, force-stop a requested installed package's activities/services for the current Android user and verify its stopped state. |
| `mobile_install_app` | After explicit approval, install one local `.apk` for the current Android user using an absolute Windows `filePath`. No automatic launch or permission grants. |
| `mobile_uninstall_app` | After explicit approval, remove the requested package and its app data for the current Android user, then verify package removal. |

USB and Wi-Fi entries may be two connections to the same phone. Choose an
endpoint explicitly, not by model name; the selected identity includes physical
serial evidence when available, otherwise `null`. Every device command uses
the selected ADB transport ID. A disconnect, observed server restart, or new
selection invalidates tokens/references. There is **no endpoint fallback**,
including to another connection to the same phone.

### App management

All six app-management tools require the `targetToken` from explicit device
selection. They revalidate the selected transport and physical identity; they
never select another device, switch Android users, or capture a screen.
They do **not** require an `observationId`. The four mutating tools invalidate
earlier observations, including on a failed attempt; observe again before UI
input. The original `mobile_act` launch action remains available with its
existing observation requirements.

`mobile_list_apps` returns `{ userId, apps: [{ packageName }] }` for the current
Android user, including system apps; it does not resolve human-readable labels.
`mobile_get_foreground_app` returns `{ foregroundApp: { packageName,
activityName, userId } }`, or `foregroundApp: null` only when Android explicitly
reports no resumed activity. It supports Android 11's `ResumedActivity` and
newer `mResumedActivity`/`topResumedActivity` fields, scoped to the primary
display; missing, ambiguous, and unfamiliar OEM formats are errors.

Launch, terminate, and uninstall accept `packageName`. Launch verifies the
foreground package/user. Termination uses Android force-stop (activities and
services), may discard unsaved state, and verifies the package's stopped flag.
Unrelated user headings in package diagnostics are ignored; duplicate or
conflicting installed/stopped records still fail verification.
Uninstallation deletes app data for the current user without targeting other
users; protected/system packages remain subject to Android policy. Obtain
specific authorization for termination and explicit approval naming the
package/device and data-deletion consequence before uninstallation.

Installation accepts `filePath`, an absolute local Windows drive path such as
`C:\Packages\demo.apk`. The existing, readable regular file must be 1 byte to
512 MiB. Spaces and shell punctuation in the local path are passed as a
literal process argument, never through a shell. URLs, UNC/device paths,
`.ipa`, `.app`, `.zip`, and split APK bundles are unsupported. The tool neither
downloads files nor automatically adds replacement, downgrade, test-package,
permission-grant, or verification-bypass flags. Android still validates the
APK and enforces its signature/version/installation policies. Approve the
specific APK and device before installation; no app is automatically launched.

App mutations return `{ status, packageName, userId }` only after the relevant
Android acknowledgement/verification. Installation reports `packageName: null`:
the plugin does not infer package identity from the filename or parse APK
manifests. Installation has a 120-second command deadline; other commands
retain their 15-second limit. Errors after a possible dispatch report
`actionMayHaveRun: true` and are non-retryable. Verify device state before any
further mutation; no app operation is retried automatically.

### Waking a selected phone

After explicit permission to wake the selected phone, call `mobile_wake` with
`targetToken`. Like app-management tools, it does not require an observation:
the screen may be off, and capturing authentication UI is not appropriate.
It invalidates previous observations, sends the non-toggle Android `WAKEUP`
key, and checks bounded keyguard diagnostics. Only an explicitly unsecured
keyguard may receive Android's `wm dismiss-keyguard` command, at most once.
The tool never enters a PIN, password, or pattern, uses biometrics, changes
security settings, or attempts to bypass authentication.

Success is `{ status: "awake-and-unlocked", keyguardDismissed: boolean }`,
verified against screen-on and keyguard state, without returning a screenshot.
Then observe approved non-sensitive content before subsequent `mobile_act` input. A secure
keyguard or SIM lock returns `MANUAL_UNLOCK_REQUIRED`; unavailable,
contradictory, or unfamiliar OEM diagnostics return
`KEYGUARD_STATE_UNAVAILABLE`. `WAKE_FAILED` means readiness could not be
verified. The screen may already have been woken when an error is returned;
check `actionMayHaveRun` and do not automatically replay the operation.
The user must authenticate or dismiss unsupported lock screens manually.
This capability does not enable debugging or authorize the computer.

Supported action objects:

| `kind` | Additional fields |
| --- | --- |
| `tap` | `target: { elementRef }` from the observation, or `target: { x, y }` from its screenshot. |
| `swipe` | `from: { x, y }`, `to: { x, y }`, optional `durationMs` (100-2000, default 400). |
| `type_text` | `text`: 1-256 ASCII letters, digits, spaces, periods, commas, underscores, or hyphens. |
| `key` | `key`: `BACK`, `HOME`, or `ENTER`. |
| `launch_app` | `packageName` of a specifically requested, already-installed app with one resolved launcher. |

Text appends to one unchanged, focused, enabled, non-password native EditText;
it does not clear or submit the field. Unicode/control characters, other
punctuation, clipboard/helper fallback, and arbitrary shell are rejected.

Observations expire after 30 seconds and are consumed on an action attempt.
Elements are revalidated before dispatch; coordinate gestures additionally
require in-bounds points and unchanged decoded pixels in a full-width interaction
band. The band extends above/below a tap by 8% of the shorter display dimension
(rounded up, at least 8 pixels, clipped to the display). For swipes, it covers the
entire vertical path plus that padding, not just the endpoints. Exposed hierarchy
elements intersecting the band must also remain unchanged when both reads succeed.

Up to 20% of screen pixels may change **outside** this band, allowing unrelated
ads, price animations, and status-bar updates without requiring a byte-identical
PNG. Any changed target-band pixel, larger screen change, or known foreground
app/activity/Android-user switch still rejects input. Allowing changed pixels
elsewhere requires a verified matching foreground activity and consistent
hierarchy availability; unavailable foreground diagnostics produce an explicit
observation warning and retain the identical-visible-pixels requirement.
Equivalent PNG encodings/metadata are compared by decoded RGB/RGBA pixels,
including alpha, rather than file hashes. These are conservative visual/context
checks, not proof of an unchanged page or permission to submit a transaction.
Only the primary display is covered; capture sources and input remain non-atomic.

`STALE_OBSERVATION` describes the local pre-input check that failed, not an
app-level security block. It does not by itself identify ads or price animations
as the cause. Observe again and inspect the target before another attempt;
observations remain single-use, and uncertain input is never automatically retried.

Display geometry and rotation are verified independently of UI Automator using
the primary logical display in `dumpsys window displays`. A failed hierarchy read
therefore does not turn a known rotation into an apparent rotation change.
Observations include a separate `displayState` status. Unavailable display state
leaves rotation unknown and blocks normal input with
`DISPLAY_STATE_UNAVAILABLE`; old rotation is never cached or assumed to be zero.
Actual geometry/rotation changes (including 180-degree rotation), disagreement
between capture sources, and changed interaction regions still reject stale input.
Unrecognized OEM display formats fail explicitly rather than guessing. Input
viewport orientation is not used because it can include a physical panel offset
rather than just the logical UI rotation.

Hierarchy capture uses a forced device PTY for `/dev/tty` without leaving a dump
file on the phone. PNG capture stays on raw `exec-out`, avoiding terminal
newline conversion of image bytes.

For screenshot-free observation, call `mobile_observe` with:

```json
{
  "targetToken": "<selected target token>",
  "includeScreenshot": false
}
```

This skips screen capture entirely, returns no image block, and reports
`screenshot: { status: "skipped", error: null }`. UI text, labels, resource IDs,
element references, and independently verified display geometry remain
available when exposed by Android. The default is `includeScreenshot: true`,
preserving existing screenshot-plus-hierarchy behavior.

`mobile_act` preserves the observation's screenshot setting for both its
pre-dispatch revalidation and post-action observation, including chained
actions. In hierarchy-only mode, use `elementRef` taps; coordinate taps and
swipes fail with `CAPTURE_UNAVAILABLE` rather than taking a screenshot.
Typing, keys, and app launches retain their existing guards. If hierarchy
capture fails, observation fails without falling back to an image. Empty or
custom-drawn hierarchies cannot supply missing UI content; report the
limitation instead of silently enabling screenshots.

`dispatchStatus: dispatched` proves dispatch, **not** the requested state.
Inspect the returned observation and assert the intended UI state.
`outcome-unknown` or `verificationStatus: unverified` is an error result with
`actionMayHaveRun`; do not replay a possibly delivered tap/text entry. Observe
first, and rediscover/reselect if the transport was lost.

## Limits and privacy

Screen images/UI text returned to Copilot may be processed by its configured
model service. Local device I/O does not mean on-device inference. Use only
approved, non-sensitive demo content; do not observe authentication screens.
Images and dumps remain in server memory by default. This does not prevent
Copilot/model-side retention under the host's policies. Save evidence only with
explicit approval of its content and destination.

Hierarchy availability depends on the app/OEM. Custom-drawn content may expose
no semantic elements. Protected capture may error or return obscured pixels;
the plugin cannot reliably diagnose protection from a dark image and never
bypasses it. Screenshot and hierarchy status are independent; without a usable
screenshot, coordinate gestures are blocked. Without either observation,
normal input stops; explicitly requested `mobile_wake` is the bounded
no-capture exception for waking. App-management tools independently operate on
explicit package/file targets without screen observations. Password-node text
is redacted, not a guarantee that a whole screen contains no secrets.

Reads are bounded: commands have a 15-second deadline and 16 MiB output limit
(APK installation alone allows 120 seconds);
primary-display diagnostics have a shorter two-second attempt deadline and
retry transient read failures at most once. Display parsing is limited to
1 MiB; raw display diagnostics are not returned in tool results or saved to disk.
Only these read-only metadata attempts are retried, never input commands.
PNG images are limited to 5 MiB, 8192 pixels per dimension, 64 MiB decoded data,
and non-interlaced 8-bit RGB/RGBA. XML is limited to 2 MiB, 2000 traversed nodes,
depth 64, and 500 retained elements; normalized element data is capped at
512 KiB. Successful observation results stay below an 8 MiB serialized budget.
Inventory is limited to 256 endpoints/512 KiB, with at most 65535 payload bytes
per ADB protocol inventory response, and identity properties to
512 bytes each. Oversized/malformed data is reported explicitly, not silently
truncated. Wireless qualification may reject an OEM whose TLS evidence cannot
be read.

App inventories are bounded to 1 MiB and 10,000 packages, foreground activity
diagnostics to 2 MiB, and package-state diagnostics to 1 MiB. Raw app diagnostics
are not returned or saved. App package inventories/foreground metadata can
also be sensitive and should be requested only for the authorized task.

One server serializes its actions, but there is no cross-process device lock:
use one controller per phone. Disabling/unloading the plugin stops its bounded
command helpers/monitor and clears selection, not the shared ADB server or
the phone's debugging trust.

Installation, debugging trust, and tool annotations are **not** blanket
authorization for device actions. Obtain an explicit target and safe journey,
respect Copilot's permission UI, and treat device content as untrusted data.
The initial POC must not send messages/forms, change settings/accounts, make
purchases, grant permissions, or enter credentials. Generic taps/keys can do
those things even though no dedicated tool is provided.

There is no iOS/emulator/cloud-device support, streaming/canvas, recording,
general-purpose file transfer, remote service, or legacy wireless fallback.
Secure lock-screen authentication is never automated.

## Real-hardware acceptance runbook

These are **pending manual checks**, not results of the automated suite.
Before control, record the actual phone/model/build, host/App/Node/ADB/plugin
versions, network, and an agreed non-sensitive offline app/package. Agree
exact screen-state assertions for this device; do not invent an OEM UI path.

1. Approve a reversible, non-submitting journey: launch the agreed app, inspect
   and tap a visible control, scroll, focus a native non-password search field,
   append `POC sample-01` without submitting, then Back/Home. If the app lacks
   a supported surface, agree another existing app rather than install one.
2. After user-performed USB authorization, explicitly select USB. Complete the
   journey **three consecutive times**, inspecting fresh screenshot/hierarchy
   observations and asserting the intended intermediate/final state each time.
   Reset only disposable demo UI, manually if necessary.
3. After user-performed modern pairing/connection, compare the separate USB and
   wireless entries. Confirm the same physical phone using identity evidence
   or the user's physical confirmation. Explicitly select wireless.
4. **Physically unplug USB**, re-enumerate, and confirm its endpoint is absent.
   Complete the identical journey **three consecutive times over wireless**.
   Record TLS qualification and USB absence; a listed Wi-Fi endpoint alone is
   not proof that control used wireless.
5. With another endpoint available, have the user interrupt the selected
   transport. Input must fail or report uncertainty, never switch to the
   alternative. Restore, rediscover, and explicitly reselect before continuing.
6. Record safe diagnostics: no devices, missing ADB, naturally reproducible
   offline states, and unavailable hierarchy/capture. Unauthorized/revoked-trust
   setup requires separate consent; never revoke existing trust automatically.
   A second phone and protected test surfaces are optional hardware inputs:
   label unavailable cases fixture-only or unverified.

Keep an approved, sanitized acceptance record in private session artifacts:
device alias (not raw serial/IP), versions, consent/setup confirmation,
transport identity, USB-unplug confirmation, per-step dispatch/observation/state
assertions, no-fallback result, and approved images only. Never commit evidence.

| Acceptance layer | Current evidence |
| --- | --- |
| Fixture/subprocess/MCP/package behavior | Local automated checks; no real ADB/device access. |
| Plugin recognition | Read-only Copilot CLI 1.0.99-2 mount on Node 22.15.1. |
| Actual Copilot App tool loading | Verified with thirteen registered tools and the full USB app-management lifecycle on one Android 11 phone. |
| USB app-management lifecycle | All six operations passed through the reinstalled plugin on one Android 11 phone, including the package-state parser fix. |
| Physical USB and unplugged paired Wi-Fi journeys | Unverified; hardware and control consent required. |

Full POC acceptance requires App loading and the physical runs/no-fallback
check. Fixture success is not a substitute. See [SUPPORT.md](SUPPORT.md) for safe
issue reports and [SECURITY.md](SECURITY.md) for security reporting.

Wake and unsecured-keyguard dismissal passed on the USB-connected Android 11
phone without changing its security settings or capturing its lock screen.
Secure-lock and unknown-OEM hardware cases remain pending. On an existing
secure lock, verify only waking occurs and manual authentication is required,
without capturing the lock screen. Unknown OEM diagnostics must stop dismissal;
do not remove or change a real device's security settings for testing.

All six app-management operations passed on one USB-connected Android 11 phone
using the explicitly approved Field Notes Demo APK (`dev.mobileuse.demo`):
inventory, installation, launch, foreground lookup, force-stop, and
uninstallation with current-user data deletion. The demo was absent before
installation and verified absent after removal. Termination passed through the
rebuilt MCP server after fixing unrelated user headings in package diagnostics.
The complete lifecycle then passed again through the reinstalled plugin,
including termination verification.

MIUI first-run permissions and an installation prompt required user handling.
An initially rejected installation was retried only after the user explicitly
requested another attempt. Missing-package launch/terminate/uninstall and
missing-file install guards also passed without app mutations. Paired-wireless
app management remains unverified: repeat the approved lifecycle on the
explicitly selected paired-wireless endpoint without USB, and never retry an
uncertain mutation automatically.

## Licensing

Project-authored code is [MIT-licensed](LICENSE). Third-party dependencies keep
their own licenses: the MCP server/core SDK remains at 2.3.1 and includes
Apache-2.0-covered code. TypeScript is also Apache-2.0-licensed development
tooling, but is not shipped in the plugin. This is an MIT project, **not an
Apache-free dependency bundle**.

The former mobile-mcp-derived helper, UI traversal, discovery/lookup, and type
declarations have been replaced. The current adapter uses Android's
[ADB interface](https://developer.android.com/tools/adb) and
[documented command contracts](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/docs/user/adb.1.md);
Android/AOSP implementation source is not copied or redistributed.
The text path validates a small alphabet instead of using a generic shell
escaper; hierarchy processing uses an ordered XML tree and a bounded iterative
walk. This replacement is not a legal clean-room certification: the prior
implementation and upstream source were previously examined.

See [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES). Builds preserve license texts for
dependencies actually bundled and copy version-specific license fallbacks only
when needed. They do not change those dependencies' licenses.

## Contributing

This project welcomes contributions and suggestions.  Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit [Contributor License Agreements](https://cla.opensource.microsoft.com).

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
