# Contributing to mobile-use

This guide covers local development, implementation contracts, and hardware
validation. For plugin requirements, device setup, everyday use, and safety
boundaries, start with the [README](README.md).

## Development prerequisites

Use Windows, a maintained Node.js release (**22.2.0** minimum; Node 24 LTS
recommended), and npm. Automated checks do not require ADB or a connected phone.
Real-hardware checks additionally require the prerequisites and user-performed
setup in the README, plus specific consent for the device and task.

## Build and check the plugin

From the repository directory in PowerShell:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

`check` typechecks, runs no-phone tests, and builds/checks `dist\mobile-use`.
The Windows CI workflow runs the same command on Node 22 and 24.

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Typecheck without emitting files. |
| `npm test` | Compile and run the TypeScript no-phone tests. |
| `npm run build:plugin` | Bundle the local plugin into `dist\mobile-use`. |
| `npm run test:plugin` | Check the built artifact and its copied-artifact protocol behavior; build the plugin first. |
| `npm run check` | Run all of the above in order. |
| `npm run test:gestures` | Test the Java helper's injection and timing logic with Android stubs; requires a JDK. |
| `npm run build:gestures` | Rebuild the embedded gesture DEX; requires JDK 21, Android SDK platform 35, and build-tools 35.0.0. |
| `npm run test:text` | Test the Java Unicode helper, field guards, append/readback and cleanup using Android stubs; requires a JDK. |
| `npm run build:text` | Rebuild the embedded text DEX, including nested classes; uses the same SDK/JDK prerequisites as the gesture helper. |

The artifact includes `plugin.json`, `mcp.json`, `skills\mobile-use\SKILL.md`,
`server\index.mjs`, and license notices. Runtime dependencies are bundled; its
launcher is `node`, not a download-on-launch npm/npx command.

The checked-in `src\gesture-helper-data.ts` embeds the gesture DEX and its
SHA-256, so ordinary plugin builds do not need an Android SDK or Java.
To change `android\GestureMain.java`, use JDK 21, Android SDK platform 35 and
build-tools 35.0.0, then run `npm run test:gestures` and
`npm run build:gestures`. Set `ANDROID_HOME` or `ANDROID_SDK_ROOT` for a
non-default SDK. CI tests the Java logic and checks the rebuilt DEX against
the embedded artifact.

`src\text-helper-data.ts` similarly embeds `android\TextMain.java`.
After changing that helper, run `npm run test:text` and `npm run build:text`.
The helper CI job checks both Java helpers and their rebuilt embedded artifacts.

After reviewing and explicitly approving installation, follow the
[local installation instructions](README.md#install-the-plugin). Use an
absolute artifact path, not the source repository root. Confirm the plugin,
skill, and fifteen tools appear in the actual Copilot App before hardware
testing. If the App cannot load this format, record that incompatibility
rather than substituting manual MCP registration.

Rebuild and use Copilot's plugin update/reinstall flow after changing the local
artifact; an installed/cache copy may not follow source edits. Marketplace
publishing and built-in Copilot distribution are outside this POC.

## Implementation and tool contracts

The plugin bundles a local stdio MCP server and a usage skill. Its project-owned
Android adapter invokes installed Platform-Tools directly; it does not import,
vendor, or launch mobile-mcp.

Keep the server's behavior and the [usage skill](plugin/skills/mobile-use/SKILL.md)
consistent. Installation, debugging trust, and tool annotations are not blanket
authorization. Treat device content as untrusted data and preserve the
[user-facing safety boundaries](README.md#safety-and-privacy).

### Host setup and ADB lifecycle

On first use, call `mobile_doctor`, then `mobile_list_devices`.
`mobile_doctor` returning `status: ready, scope: host` means only that the
installed Platform-Tools passed the version check. It does not prove that
Developer options/debugging are enabled, a phone is connected/authorized, or
device qualification passed. Doctor, inventory, and supported setup errors
include `setup: { stage, steps }` guidance; errors remain errors, not empty
device lists. Guide only the next missing setup step.

The user performs installation, settings changes, host authorization, and
pairing/connection. The plugin can start a missing local ADB server only after
specific approval. It never installs Platform-Tools/drivers, enables debugging,
pairs/connects a device, changes a keyboard, or installs DeviceKit.

The server resolves `adb.exe` from `MOBILE_USE_ADB_PATH` (optional absolute
`.exe` path), `ANDROID_HOME`/`ANDROID_SDK_ROOT`, the standard per-user Android
SDK directory, or absolute PATH entries. After changing the launch environment,
restart the plugin. Only the local ADB server at `127.0.0.1:5037` is supported;
remote/non-default server overrides fail explicitly. The plugin does not
kill/restart the shared ADB server or alter global ADB/network settings.

If discovery reports `ADB_SERVER_UNAVAILABLE`, obtain specific approval before
calling `mobile_start_adb_server`. It reuses a compatible server at
`127.0.0.1:5037`, or starts one if the port refuses connections. It verifies
the ADB protocol/version and retries read-only inventory before returning
device setup/selection guidance. It never selects or controls a phone, accepts
a debugging prompt, or silently starts from doctor/discovery. An unavailable
host server says nothing about the phone's connection state.

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

### Tool reference and device selection

| Tool | Contract |
| --- | --- |
| `mobile_doctor` | First-use host ADB/version check with setup guidance. `ready` is host-only; does not enumerate or control devices. |
| `mobile_start_adb_server` | After explicit approval, reuse/start only the default local server, verify readiness, and return fresh inventory/setup steps. Never kills/restarts, selects, or controls a device. |
| `mobile_list_devices` | Show endpoint IDs, transport IDs/kinds, all states, and next setup/selection steps. Discovery failure is not an empty list. |
| `mobile_select_device` | Bind exactly the endpoint the user chose; qualify Android/physical-device and wireless evidence; return a session target token. |
| `mobile_wake` | With explicit permission and a target token, wake the display and dismiss only an unsecured lock screen. No observation or screen capture; secure/unknown lock states require manual unlocking. |
| `mobile_prepare_gestures` | After explicit approval to upload and run the bundled gesture helper on the selected device, deploy and hash-check its DEX and check API compatibility without touch input. Invalidates old observations; required only for double-tap. |
| `mobile_prepare_text_input` | After explicit approval, upload and run the pinned text DEX, verify its hash and UiAutomation compatibility without reading screen content or entering text. Invalidates observations; required for Unicode and text outside the original ASCII subset. |
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
They do not require an `observationId`. The four mutating tools invalidate
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
Then observe approved non-sensitive content before subsequent `mobile_act`
input. A secure keyguard or SIM lock returns `MANUAL_UNLOCK_REQUIRED`;
unavailable, contradictory, or unfamiliar OEM diagnostics return
`KEYGUARD_STATE_UNAVAILABLE`. `WAKE_FAILED` means readiness could not be
verified. The screen may already have been woken when an error is returned;
check `actionMayHaveRun` and do not automatically replay the operation.
The user must authenticate or dismiss unsupported lock screens manually.
This capability does not enable debugging or authorize the computer.

### UI actions and observation guards

Supported `mobile_act` action objects:

| `kind` | Additional fields |
| --- | --- |
| `tap` | `target: { elementRef }` from the observation, or `target: { x, y }` from its screenshot. |
| `double_tap` | Same `target` as `tap`; optional integer `delayMs` (0-250, default 50) requests the first-UP to second-DOWN event-time interval. Requires approved `mobile_prepare_gestures`. |
| `swipe` | `from: { x, y }`, `to: { x, y }`, optional `durationMs` (100-2000, default 400). |
| `type_text` | `text`: 1-256 UTF-16 code units of well-formed Unicode text. The original ASCII subset uses ADB; all other supported text requires approved `mobile_prepare_text_input`. |
| `key` | `key`: `BACK`, `HOME`, or `ENTER`. |
| `launch_app` | `packageName` of a specifically requested, already-installed app with one resolved launcher. |

#### Double-tap helper and preparation

`double_tap` revalidates once before the pair and returns an observation after
both taps, without a host round trip or observation between them. The bundled
helper injects DOWN/UP/DOWN/UP in one `app_process`, with primary-display
touchscreen events, 10 ms holds, and all four injection acknowledgements checked.
It schedules the second DOWN relative to the first UP's monotonic event time,
so process startup is outside the inter-tap interval. `gestureTiming` reports
`requestedDelayMs` and `actualGapMs`; scheduling can increase the requested gap.
If the framework double-tap timeout is already exceeded, the helper stops before
the second tap and reports an uncertain partial outcome. Zero is accepted for
diagnosis, but may be below Android's minimum double-tap interval.

Before the first double-tap after each selection/server restart, ask specifically
for approval to upload and run the bundled helper on that device, then call
`mobile_prepare_gestures`. Preparation copies the embedded DEX to a new
mode-700 `/data/local/tmp/mobile-use-gestures-*` directory, makes the file
read-only, verifies its SHA-256, and checks its input API compatibility.
It installs no APK, permissions, service, network connection, or daemon.
The directory/files remain on the device; there is no automatic deletion.
Preparation is not permission to control other content, and requires a new
observation before input. Every double-tap rechecks the helper hash. Missing,
modified, or incompatible helpers fail explicitly: no automatic deployment,
download, helper replacement, or two-process fallback is performed.

The helper uses non-public Android input APIs through reflection under the
authorized ADB shell identity. These are not a supported public SDK contract;
availability and injection permission can vary by Android/OEM build.
Preparation checks API availability without injecting input, so it does not
prove that touch injection or app gesture recognition will succeed.

Dispatch and reported event timestamps do not prove gesture recognition. Verify
the returned observation and never automatically replay an uncertain or partial
pair. Both taps target the same point even if the first changes the screen, so
authorize the pair only when that is safe. Hierarchy-only mode supports
`elementRef` double-taps but rejects coordinates without capturing a screenshot.

For example, `{ "kind": "double_tap", "target": { "x": 360, "y": 800 }, "delayMs": 50 }`
requests a 50 ms event-time gap at a point from a fresh screenshot.

#### Unicode text helper and preparation

The text helper adopts the text-setting approach illustrated in
[this AndroidViewClient example](https://stackoverflow.com/a/71367206), without
adding its Python/server stack or extending Android's character-to-key-event map.
It invokes `AccessibilityNodeInfo.ACTION_SET_TEXT` through a short-lived
`UiAutomation` connection under the approved ADB shell identity. The connection
uses `FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES`; it disconnects and stops its
handler thread even on failure. Reflection is needed for shell-only connection
APIs, so availability still depends on the Android/OEM build.

Before using text outside ASCII letters/digits/space/period/comma/underscore/
hyphen, obtain explicit approval to upload and run the bundled text helper on
the selected device, call `mobile_prepare_text_input`, and observe again.
Preparation uses the same private mode-700, read-only, SHA-256-checked DEX
deployment as the gesture helper, under `/data/local/tmp/mobile-use-text-*`.
It checks compatibility without reading UI or entering text. Files remain on
the device; reselection/server restart requires fresh approval and preparation.
There is no APK installation, IME replacement, clipboard, network service,
automatic helper deployment, or fallback input attempt.

After preparation, hierarchy observations also use the pinned helper's
Unicode-safe XML serializer rather than the stock `uiautomator dump`.
It preserves supplementary characters and leading/trailing whitespace,
redacts password values before returning data, and retains the hierarchy
size/depth/node limits. Primary-display geometry is checked before and after
the helper read. There is no fallback to a potentially lossy stock dump if the
prepared helper becomes unavailable. Screenshot settings remain unchanged.

New `UiAutomation` connections can initially expose no active root, including
during pre-action revalidation. Both hierarchy reads and pre-write text checks poll
only that read for up to 2 seconds (100 ms intervals, at most 21 attempts);
the outer ADB deadline still bounds a blocked Android call. No write is retried.
Missing roots fail closed with the fixed `ROOT` diagnostic stage. Helper errors
return only allowlisted phase names, never exception messages, field values,
or device logs. Preflight failures preserve their no-input status and consume
the observation; recovery requires a fresh observation.
If the text-helper process exits unsuccessfully before its result can be
interpreted, `ADB_FAILED` includes only the numeric exit code, an allowlisted
result marker, and an allowlisted Java exception class (or unavailable/missing).
Raw stdout/stderr, exception messages, and UI content are never returned.
A nonzero exit remains uncertain even if stdout contains an `OK` marker.

Focused editable nodes are refreshed before serialization. Each non-password
editable node also exposes a validated SHA-256 `textHash` over its exact UTF-16
text and hint-state bit. Text actions compare this fingerprint after refreshing
the field, instead of comparing XML-normalized display text with raw Android
text. This preserves stale-text protection when XML escaping, invalid-XML
replacement, whitespace, or cached node data differ between a read and refresh.
Password fields never expose a text fingerprint.

Prepared hierarchy elements also carry their native `windowId`. Unicode input
requires this validated nonnegative Android window ID from the authorized
observation. Host element revalidation rejects a changed ID even if the app,
activity, text, resource ID, and bounds are identical. Request protocol 3 carries
the original window ID to the helper, which checks the root and refreshed field
against it before `ACTION_SET_TEXT` and retains it through readback.

Hierarchy parsing must decode XML numeric character references as well as named
escapes, without trimming or double-decoding their values. The serializer uses
numeric references for tabs and line breaks; leaving `&#10;` as literal text
breaks exact observation/readback even when Android accepted the requested text.
Fixtures encode these whitespace characters just like the device helper.

Each Unicode action transmits length-prefixed UTF-8 data encoded as Base64, never
shell syntax. The helper rechecks the Android user, primary-display active app
window, unique focused editable non-password field, class/resource ID, bounds,
and existing text. It appends to the **end** of the actual value, irrespective
of selection/caret position, excluding a reported placeholder hint. ASCII
input retains its existing key-event/caret behavior. Tabs and line breaks are
text, not key events; the helper does not clear or submit the field.
Pre-write bounds must match exactly. Post-write verification refreshes the
same native node and requires the same window ID, active primary app window,
user, field identity/state, and exact desired text. It permits that node's
bounds to change: multiline text can legitimately resize or scroll its editor.
Checking its old bounds after writing would falsely report an uncertain result.

Combining marks, supplementary-plane characters, emoji and ZWJ sequences are
preserved without normalization. Limits are 256 UTF-16 code units per action
and 4096 for the resulting value plus its exposed label/hint. Unpaired surrogates, C0 controls other than
tab/LF/CR, C1/DEL controls, and U+FFFE/U+FFFF are rejected before device I/O.
Native fields must expose `ACTION_SET_TEXT`; custom editors, app input filters,
and OEM restrictions may prevent input. Successful acknowledgement is followed
by exact text readback with `isShowingHintText()` false. A visible placeholder
matching the requested value is not proof of entered text. A rejected, filtered,
interrupted, or unverifiable write is uncertain and must not be replayed
automatically; inspect a fresh observation.

On successful process completion, recognized helper errors in REQUEST, CONNECT,
CONFIGURE, ROOT, WINDOW, HIERARCHY, or TARGET confirm a pre-write failure with
`actionMayHaveRun: false`. WRITE, VERIFY, DISCONNECT, unknown responses, and
unsuccessful process exits remain uncertain. A failed append attempt still
consumes its observation; obtain a fresh observation rather than replaying it.

Java stub tests and host fixtures are not real-device proof. The currently
packaged Unicode DEX has automated coverage only and has not been phone-tested.
Earlier helper revisions passed approved USB tests in MIUI Notes on one Android
11 Redmi; that evidence does not establish hardware validation of the current
DEX. See the [versioned Unicode artifact evidence](#unicode-artifact-evidence).

#### Shared observation guards

Text appends to one unchanged, focused, enabled, non-password native EditText;
it does not clear or submit the field. Extended text requires the explicitly
prepared Unicode helper described above. Clipboard fallback and arbitrary
shell are rejected.

Observations expire after 30 seconds and are consumed on an action attempt.
Elements are revalidated before dispatch; coordinate gestures additionally
require in-bounds points and unchanged decoded pixels in a full-width interaction
band. The band extends above/below a tap by 8% of the shorter display dimension
(rounded up, at least 8 pixels, clipped to the display). For swipes, it covers the
entire vertical path plus that padding, not just the endpoints. Exposed hierarchy
elements intersecting the band must also remain unchanged when both reads succeed.

Up to 20% of screen pixels may change outside this band, allowing unrelated
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
preserving screenshot-plus-hierarchy behavior.

`mobile_act` preserves the observation's screenshot setting for both its
pre-dispatch revalidation and post-action observation, including chained
actions. In hierarchy-only mode, use `elementRef` taps; coordinate taps and
swipes fail with `CAPTURE_UNAVAILABLE` rather than taking a screenshot.
Typing, keys, and app launches retain their existing guards. If hierarchy
capture fails, observation fails without falling back to an image. Empty or
custom-drawn hierarchies cannot supply missing UI content; report the
limitation instead of silently enabling screenshots.

Hierarchy availability depends on the app/OEM. Protected capture may error or
return obscured pixels; the plugin cannot reliably diagnose protection from
a dark image and never bypasses it. Screenshot and hierarchy status are
independent; without a usable screenshot, coordinate gestures are blocked.
Without either observation, normal input stops; explicitly requested
`mobile_wake` is the bounded no-capture exception for waking. App-management
tools independently operate on explicit package/file targets without screen
observations. Password-node text is redacted, not a guarantee that a whole
screen contains no secrets.

`dispatchStatus: dispatched` proves dispatch, not the requested state.
Inspect the returned observation and assert the intended UI state.
`outcome-unknown` or `verificationStatus: unverified` is an error result with
`actionMayHaveRun`; do not replay a possibly delivered tap/text entry. Observe
first, and rediscover/reselect if the transport was lost.

### Resource bounds and lifecycle

Commands have a 15-second deadline and 16 MiB output limit (APK installation
alone allows 120 seconds). Primary-display diagnostics have a shorter
two-second attempt deadline and retry transient read failures at most once.
Display parsing is limited to 1 MiB; raw display diagnostics are not returned
in tool results or saved to disk. Only these read-only metadata attempts are
retried, never input commands.

PNG images are limited to 5 MiB, 8192 pixels per dimension, 64 MiB decoded data,
and non-interlaced 8-bit RGB/RGBA. XML is limited to 2 MiB, 2000 traversed nodes,
depth 64, and 500 retained elements; normalized element data is capped at
512 KiB. Successful observation results stay below an 8 MiB serialized budget.
Inventory is limited to 256 endpoints/512 KiB, with at most 65535 payload bytes
per ADB protocol inventory response, and identity properties to 512 bytes each.
Oversized/malformed data is reported explicitly, not silently truncated.
Wireless qualification may reject an OEM whose TLS evidence cannot be read.

App inventories are bounded to 1 MiB and 10,000 packages, foreground activity
diagnostics to 2 MiB, and package-state diagnostics to 1 MiB. Raw app diagnostics
are not returned or saved. App package inventories/foreground metadata can
also be sensitive and should be requested only for the authorized task.

One server serializes its actions, but there is no cross-process device lock:
use one controller per phone. Disabling/unloading the plugin stops its bounded
command helpers/monitor and clears selection, not the shared ADB server or
the phone's debugging trust.

## Real-hardware acceptance runbook

These are pending manual checks, not results of the automated suite. The
complete runbook remains pending even where individual USB operations have
been verified. Before control, record the actual phone/model/build,
host/App/Node/ADB/plugin versions, network, and an agreed non-sensitive offline
app/package. Agree exact screen-state assertions for this device; do not
invent an OEM UI path.

1. Approve a reversible, non-submitting journey: launch the agreed app, inspect
   and tap a visible control, scroll, focus a native non-password search field,
   append `POC sample-01` without submitting, then Back/Home. If the app lacks
   a supported surface, agree another existing app rather than install one.
2. After user-performed USB authorization, explicitly select USB. Complete the
   journey three consecutive times, inspecting fresh screenshot/hierarchy
   observations and asserting the intended intermediate/final state each time.
   Reset only disposable demo UI, manually if necessary.
3. After user-performed modern pairing/connection, compare the separate USB and
   wireless entries. Confirm the same physical phone using identity evidence
   or the user's physical confirmation. Explicitly select wireless.
4. Physically unplug USB, re-enumerate, and confirm its endpoint is absent.
   Complete the identical journey three consecutive times over wireless.
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

Full POC acceptance requires App loading and the physical runs/no-fallback
check. Fixture success is not a substitute. See [Support](SUPPORT.md) for safe
issue reports and [Security](SECURITY.md) for security reporting.

### Current validation evidence

| Acceptance layer | Current evidence |
| --- | --- |
| Fixture/subprocess/MCP/package behavior | Local automated checks; no real ADB/device access. |
| Plugin recognition | Read-only Copilot CLI 1.0.99-2 mount on Node 22.15.1. |
| Actual Copilot App tool loading | Fifteen tools loaded in an earlier reinstalled build. This does not establish hardware validation of the currently packaged Unicode DEX. |
| Unicode text helper / fifteenth tool | Current DEX `a848d0b...`: automated-only, not phone-tested. Historical DEX `fec6781...`: approved workspace-MCP and reinstalled-plugin USB tests passed in MIUI Notes on one Android 11 Redmi. See the [versioned artifact evidence](#unicode-artifact-evidence). |
| USB app-management lifecycle | All six operations passed through the reinstalled plugin on one Android 11 phone, including the package-state parser fix. |
| USB double-tap recognition | Diagnostic app recognized 50 ms and 125 ms gaps; Gallery zoomed in and back out with 50 ms requested and 51 ms reported on one Android 11 Redmi. |
| Complete physical USB and unplugged paired Wi-Fi acceptance journeys | Unverified; hardware and control consent required. |

Hierarchy-only observation and element-reference tab navigation passed through
the reinstalled Copilot App plugin over USB on that phone. Screenshot-coordinate
navigation through menu, product, checkout, and coupon screens also passed in
one non-submitting journey. A changed interaction region correctly rejected
input, and a fresh observation allowed navigation to continue without manual
taps. Paired-wireless acceptance remains unverified.

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

On one Redmi running Android 11 over USB, the former two-`input` implementation
produced a measured UP-to-DOWN gap of 993 ms at zero added delay and 1,080 ms at
50 ms, exceeding the phone's 300 ms framework timeout. A manual double-tap
measured 108 ms and was recognized. After approved preparation, the single-process
helper produced recognized double-taps in the diagnostic app at requested and
measured gaps of 50 ms and 125 ms. Gallery visibly zoomed in and back out with
50 ms requested and 51 ms reported for each pair. These results cover this
Android 11 Redmi over USB only; other devices, Android versions, and paired
wireless double-taps remain unverified on hardware.

#### Unicode artifact evidence

| Artifact | DEX SHA-256 | Evidence and scope |
| --- | --- | --- |
| Phone-tested baseline, commit `212a88c`, request protocol 2 | `fec6781aa14300488c70bc5d6b783c62417838d349f3493af9a2eccb8e08a9ef` | Approved workspace-MCP and reinstalled Copilot App plugin runs on one USB-connected Android 11 Redmi in MIUI Notes. Exact multilingual append/readback, including editor resizing/scrolling, returned `dispatched` with no error. |
| Currently packaged helper, introduced in `80367c6`, request protocol 3 | `a848d0b20256dd15c8fbe1ab8efe11412e009bf73507c7b5d7c326bc36f334eb` | Automated Java/host/MCP/package and CI source-to-DEX checks only. **Not phone-tested.** Adds original-observation window binding and non-hint readback checks. |

Commit `82fbc9a` changes host-side pre-write failure classification, not the DEX.
Digest and packaging checks prove artifact identity, not hardware compatibility.
A new approved run of the currently packaged DEX is required before calling that
revision phone-tested. Other devices, editors, and paired-wireless Unicode input
remain unverified.

The following phone results are historical and predate the current DEX.
Earlier Unicode phone tests exposed initially unavailable accessibility roots and
XML numeric references being returned as literal strings. The corrected helper
waits within each connection for its root and refreshes/fingerprints field text;
the host decodes numeric references without trimming or double-decoding.
A fresh read matched the native text fingerprint and preserved the multilingual
sample. A separately approved, distinct confirmation suffix then passed exact
`previous + requested` comparison in a fresh hierarchy-only observation, without
screenshots or input replay. These checks used the workspace-built MCP server
through its public tools.

The reinstalled Copilot App plugin subsequently entered another multilingual
line exactly, confirmed by its native-text fingerprint, but returned uncertain
`ADB_FAILED`. The original native process failure was not captured in enough
detail to establish its cause. Investigation independently reproduced a
post-write verification bug: legitimate field growth failed the old-bounds
comparison. That guard now applies only before the write; post-write checks
retain native node/window identity, state, and exact text. The revised helper
passed another approved workspace-MCP phone action with `dispatched`, no error,
and exact append in both returned and fresh observations. The reinstalled
Copilot App plugin using the protocol-2 `fec6781...` DEX then passed the same
checks: `dispatched`, `error: null`,
and matching native-text fingerprints for exactly the previous content plus the
requested multilingual line. Its editor resized/scrolled without a false failure.
No screenshots were taken and no input was replayed. The original process
failure did not recur; its specific cause remains unconfirmed.

The current protocol-3 helper's review regressions cover same-activity replacement
windows before dispatch and during helper refresh, plus filters that leave only
the matching hint visible. These are automated results only; the historical
phone results above do not exercise these latest guards.

## Licensing and provenance

Project-authored code is [MIT-licensed](LICENSE). Third-party dependencies keep
their own licenses: the MCP server/core SDK remains at 2.3.1 and includes
Apache-2.0-covered code. TypeScript is also Apache-2.0-licensed development
tooling, but is not shipped in the plugin. This is an MIT project, not an
Apache-free dependency bundle.

The former mobile-mcp-derived helper, UI traversal, discovery/lookup, and type
declarations have been replaced. The current adapter uses Android's
[ADB interface](https://developer.android.com/tools/adb) and
[documented command contracts](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/docs/user/adb.1.md);
Android/AOSP implementation source is not copied or redistributed.
The helper-free text path validates a small alphabet instead of using a generic
shell escaper; extended text uses a framed Base64 payload. Hierarchy processing
uses an ordered XML tree and a bounded iterative
walk. This replacement is not a legal clean-room certification: the prior
implementation and upstream source were previously examined.

See [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES). Builds preserve license texts for
dependencies actually bundled and copy version-specific license fallbacks only
when needed. They do not change those dependencies' licenses.

## Pull requests and community

This project welcomes contributions and suggestions. Most contributions require
you to agree to a Contributor License Agreement (CLA) declaring that you have
the right to, and actually do, grant us the rights to use your contribution.
For details, visit [Contributor License Agreements](https://cla.opensource.microsoft.com).

When you submit a pull request, a CLA bot will automatically determine whether
you need to provide a CLA and decorate the PR appropriately (e.g., status check,
comment). Simply follow the instructions provided by the bot. You will only
need to do this once across all repos using our CLA.

This project has adopted the
[Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the
[Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any
additional questions or comments.
