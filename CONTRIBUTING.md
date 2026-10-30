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
skill, and twelve tools appear in the actual Copilot App before hardware
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
| `mobile_observe` | Require that token; return a fresh observation ID, display geometry, hierarchy/status/warnings, and a separate PNG image block when usable. Set `includeScreenshot: false` to read only hierarchy/display state without capturing an image. |
| `mobile_tap` | `action.kind`: `tap`, `double_tap`, or `prepare` for the gesture helper. Input requires `action.observationId` and `action.target`; preparation requires consent and invalidates observations without injecting input. |
| `mobile_swipe` | Require target and latest observation IDs, `from`, `to`, and optional `durationMs`; dispatch one bounded screenshot-based swipe. |
| `mobile_press_key` | Require target and latest observation IDs and one `key`: `BACK`, `HOME`, or `ENTER`. |
| `mobile_input_text` | `action.kind`: `type_text` with `action.observationId`/`action.text`, or `prepare` for the text helper. Preparation requires consent and invalidates observations without entering text. |
| `mobile_app_management` | `action.kind`: `list`, `foreground`, `launch`, `terminate`, `install`, or `uninstall`. No observation or screenshot; mutations require their specific authorization. |
| `mobile_screen_recording` | `action.kind`: read-only `capabilities`, `start` with `filePath`/optional `timeLimitSeconds`, `status`, or `stop` with `recordingId`. Silent primary-display MP4; omitted duration means unlimited where supported. Stop saves to the approved local destination without overwriting. |

This is a breaking public-tool redesign: `mobile_act`, the six separate app
tools, and the standalone preparation tools are no longer registered or
provided as aliases. There are exactly 12 tools, each with a human-readable
title. The internal bounded-action dispatcher and its device/screen guards
remain shared across the four UI input tools.

For app calls, move the former operation's fields into `action` and choose its
`kind`: `list`, `foreground`, `launch`, `terminate`, `install`, or `uninstall`.
For old UI actions, move tap/text `observationId` inside `action`; swipe/key
fields are top-level and need no `kind`. Move app launch to app management
instead of the old observation-based `launch_app` action. Replace preparation
calls with the corresponding tap/text tool and `action: { kind: "prepare" }`.
Every object/operation is strict: extraneous fields and cross-category actions
are rejected, not silently ignored.

USB and Wi-Fi entries may be two connections to the same phone. Choose an
endpoint explicitly, not by model name; the selected identity includes physical
serial evidence when available, otherwise `null`. Every device command uses
the selected ADB transport ID. A disconnect, observed server restart, or new
selection invalidates tokens/references. There is **no endpoint fallback**,
including to another connection to the same phone.

### Screen recording

`mobile_screen_recording` requires the current `targetToken`, but no
`observationId`. The four strict `action` variants are:

| Action | Contract |
| --- | --- |
| `{ kind: "capabilities" }` | Read the selected device's native help without capture or observation invalidation. Return `{ status: "available", source: "device-help", unlimitedSupported, maxTimeLimitSeconds, nativeDefaultTimeLimitSeconds }`. No recording consent or unlocked screen is needed for this read-only metadata check. |
| `{ kind: "start", filePath, timeLimitSeconds? }` | Require an already awake/unlocked phone and explicit consent for the device, non-sensitive screen content, duration or unlimited capture, and destination. `filePath` is a new absolute local Windows `.mp4` path in an existing writable directory. Optional `timeLimitSeconds` is a positive integer up to 4294967295 (native unsigned 32-bit argument range), restricted further by live capabilities. Omit it for unlimited recording until stopped where supported; the plugin never substitutes a finite default. Dispatch once and return `status: starting` with `recordingId`, without waiting for startup. |
| `{ kind: "status" }` | Return `status: idle` when no recording exists, otherwise metadata with `starting`, `recording`, `completed` or `saved`. For `starting`, perform one startup check per caller request. `timeLimitSeconds: null` means unlimited. Native recorder and query failures remain explicit errors. No screen capture or export. |
| `{ kind: "stop", recordingId }` | Stop only this selection's matching recording, await native finalization, and export to the original destination. Also exports a recording that already reached its deadline. Return `status: saved`, `filePath` and `sizeBytes` only after a successful exclusive copy. Remove only this recording's generated device temporary files. |

One active or unsaved recording is allowed per selection. Start and stop
invalidate observations, including failed attempts. Recording uses the native
`/system/bin/screenrecord` at 4 Mbps, with no audio, helper installation,
streaming, or arbitrary shell/file-transfer interface. UI operations remain
available during capture; a completed start request's cancellation does not
cancel an authorized ongoing recording. A cancelled or uncertain start must
not be replayed automatically; status can expose a `starting` recording ID
for an explicitly requested stop.

Omitted duration is explicitly passed to Android as `--time-limit 0`; omitting
the native option would incorrectly use Android's own default duration.
Unlimited capture has no host process timeout. Finite limits use the requested
native duration and a host watchdog with 15 seconds of finalization allowance
when the deadline fits Node's signed 32-bit timer range; longer durations rely
on the native limit rather than overflowing the host timer. Unsupported older
recorders fail explicitly, without falling back to a shorter capture.

The adapter creates a private, randomly named device directory and keeps the
recorder's ADB shell attached to the selection lifetime. Start checks native
help, the local destination, and the unlocked state, then dispatches capture
without startup polling. The caller requests status when it needs readiness:
each request checks the owned PID/command line and output existence once while
the recording is `starting`.

Stop sends one SIGINT command guarded by the owned PID and unique output path,
then waits up to ten seconds for the attached recorder command to finish before
saving. It does not poll process exit, retry commands, reconcile racing results,
or replace command failures with inferred success. A recorder that has already
completed needs only export. Failed native commands are never exported.
The caller decides when to check status, how to sequence operations, and whether
a retry is justified by the returned result and existing authorization.

Stop and status require the pinned transport, not repeated build/TLS metadata.
Stop occurs before one current-user check for export; there is no repeated
identity/user race checking or permanent export-failure latch. The caller must
keep the approved user unchanged and handle failures before continuing.
An already saved clip can have its temporary files cleaned without a user check.

Recording is supervised and restricted to the same approved Android user
throughout capture. Native screenrecord captures the shared primary display,
not an isolated user session. User checks are snapshots, not continuous
monitoring: a switch away and back between checks cannot be detected. Do not
switch Android users or use this tool for workflows that require user switching
or guaranteed cross-user isolation.

Export checks that device size is a positive, safely representable integer,
pulls without a fixed total deadline, but aborts after 30 seconds without local
file-size progress so a stalled pull releases the serialized operation queue.
Request cancellation and selection-lifetime abort still apply. Validation checks
movie and video-track headers, nested box boundaries, local data references,
AVC/HEVC configuration records and MPEG-4 descriptor lengths, sample-table
counts, optional sync-sample references, and media ranges using bounded reads;
it is structural validation, not a decoder or proof of playback. The exclusive
streaming copy from the randomly named local temporary directory is also abortable.
Cancellation removes only the partial destination created by that copy.
There is no fixed video-size cap and the video is not buffered in server memory.
Unlimited capture can exhaust device
storage; export requires enough local space for both the temporary download
and final copy.
Destination validation rejects UNC/device paths, alternate streams, reserved
names and existing files. It verifies Windows write permission by creating and
removing a unique temporary file, not just `fs.access(W_OK)`, without reserving
the requested evidence path. An exclusive copy also prevents races from
overwriting another writer. Failed exports retain the device capture; local
temporary files are cleaned. Cleanup errors after saving are explicit;
status still exposes the saved path, and another explicit stop retries only
cleanup, not capture or export.
Cleanup treats an already-absent owned directory as success, including after
a lost response, but still reports other removal failures.
The staging directory is beside the approved destination and inherits Windows
folder permissions, as does the final file. The caller must choose an
appropriately restricted destination; a random name does not provide isolation.
Failed or unsaved recordings retain their device files and
occupy the recording slot. There is no discard/delete operation: confirm capture
stopped before explicitly reselecting; reselection does not remove those files.

Reselection, transport loss, server restart and shutdown cancel the attached
ADB command and invalidate recording handles. If Android continues capture
after a disconnect, only an explicitly requested native time limit bounds it.
Unlimited recording has no fallback deadline: the user must verify capture
stopped on the phone. Device temporary files may remain; there is no silent
reconnect, automatic export or recovery
through a new selection. Successful saves remove only their own temporary
capture/PID files and directory.

Screenshot-free observation permission never grants recording consent. Never
record authentication or navigate to sensitive content during capture.
Protected or OEM-restricted capture can fail or contain blank content; do not
bypass it. Tool responses contain metadata/path only, not video bytes.
Real-device validation must separately confirm a playable saved clip, native
timed/unlimited and early-stop behavior, and UI input during capture on
approved content.

#### Android recorder compatibility

The release baseline below was checked against official AOSP `screenrecord.cpp`
release tags on 2026-10-30. It describes the native ADB executable, **not** the
phone's Quick Settings recorder, a MediaProjection-based app, or scrcpy.

| AOSP releases | API | `--time-limit` | Other relevant differences |
| --- | --- | --- | --- |
| [11](https://android.googlesource.com/platform/frameworks/av/+/android-11.0.0_r1/cmds/screenrecord/screenrecord.cpp), [12](https://android.googlesource.com/platform/frameworks/av/+/android-12.0.0_r1/cmds/screenrecord/screenrecord.cpp), [12L](https://android.googlesource.com/platform/frameworks/av/+/android-12.1.0_r1/cmds/screenrecord/screenrecord.cpp), [13](https://android.googlesource.com/platform/frameworks/av/+/android-13.0.0_r1/cmds/screenrecord/screenrecord.cpp) | 30-33 | Only 1-180 seconds; 0 and values above 180 are rejected. Default is 180. | No `--version` option in these tags; use `--help` to inspect capabilities. |
| [14](https://android.googlesource.com/platform/frameworks/av/+/android-14.0.0_r1/cmds/screenrecord/screenrecord.cpp), [15](https://android.googlesource.com/platform/frameworks/av/+/android-15.0.0_r1/cmds/screenrecord/screenrecord.cpp) | 34-35 | Accept 0 (unlimited) and positive durations up to unsigned 32-bit maximum. Default is still 180. | The duration parser, not the still-named `kMaxTimeLimitSec` constant, establishes the supported range. |
| [16](https://android.googlesource.com/platform/frameworks/av/+/android-16.0.0_r1/cmds/screenrecord/screenrecord.cpp) | 36 | Same modern duration semantics as 14-15. | Adds `--version`; do not assume older devices support it. |

All checked tags encode video without audio; the plugin exports silent MP4
at 4 Mbps. Native `--size`, `--bit-rate` and `--display-id` exist across these
releases, but this tool exposes neither size/bitrate overrides nor alternate
displays. Encoder resolution, availability, orientation changes, storage and
OEM/device policy can still affect capture. Avoid rotating mid-clip and verify
the saved video; a capability response is not proof of a playable recording.
Protected content may be blank or rejected; never use secure-capture flags,
root, APK installation or a different recorder to bypass protection.

Copilot must inspect `action: { kind: "capabilities" }` before recording approval.
The adapter captures stderr for `/system/bin/screenrecord --help`, parses only
the time-limit option's recognized help block (maximum 64 KiB), and returns
structured metadata, never raw OEM help or instructions. The current native
help is authoritative over API/version labels: OEMs can backport the modern
recorder or ship a different limit. The plugin does not infer a runtime limit
from API level, and does not rely on newer-only `--version`.

Every start rechecks help before creating a device directory or launching a
recorder. A recognized unsupported duration produces
`RECORDING_DURATION_UNSUPPORTED` with `actionMayHaveRun: false`, an allowed
range, and instructions to obtain approval for a supported duration.
Missing or unrecognized help produces `RECORDING_CAPABILITIES_UNAVAILABLE`;
do not guess, trial-record, shorten, segment, or silently fall back.
Both preflight failures leave recording status idle and allow a later
explicitly approved supported start without reselecting the device. Native
startup/encoder failures remain distinct, potentially uncertain errors.

Research and fixture coverage are not physical-device proof. The earlier
Android 11 USB demonstration verified a playable timed clip, not unlimited
recording or other Android versions.

### App management

All six `mobile_app_management` operations require the `targetToken` from
explicit device selection. They revalidate the selected transport and physical identity; they
never select another device, switch Android users, or capture a screen.
They do not require an `observationId`. The four mutating operations invalidate
earlier observations, including on a failed attempt; observe again before UI
input. App launch is available only through the public app-management tool.
Because MCP annotations apply at tool level, the combined tool conservatively
advertises `readOnlyHint: false`, `destructiveHint: true`, and
`idempotentHint: false`, including for its list/foreground reads. Do not mark
the whole tool read-only or recommend blanket tool approval to avoid prompts.

`action: { kind: "list" }` returns `{ userId, apps: [{ packageName }] }` for the
current Android user, including system apps; it does not resolve human-readable labels.
`action: { kind: "foreground" }` returns `{ foregroundApp: { packageName,
activityName, userId } }`, or `foregroundApp: null` only when Android explicitly
reports no resumed activity. It supports Android 11's `ResumedActivity` and
newer `mResumedActivity`/`topResumedActivity` fields, scoped to the primary
display; missing, ambiguous, and unfamiliar OEM formats are errors.

Launch, terminate, and uninstall accept `action.packageName`. Launch verifies the
foreground package/user. Termination uses Android force-stop (activities and
services), may discard unsaved state, and verifies the package's stopped flag.
Unrelated user headings in package diagnostics are ignored; duplicate or
conflicting installed/stopped records still fail verification.
Uninstallation deletes app data for the current user without targeting other
users; protected/system packages remain subject to Android policy. Obtain
specific authorization or matching scoped session consent for termination.
Uninstallation requires explicit one-action approval naming the package/device
and data-deletion consequence. Do not ask again for an already explicit exact
authorization.

Installation accepts `action.filePath`, an absolute local Windows drive path such as
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
Then observe approved non-sensitive content before subsequent UI input.
A secure keyguard or SIM lock returns `MANUAL_UNLOCK_REQUIRED`;
unavailable, contradictory, or unfamiliar OEM diagnostics return
`KEYGUARD_STATE_UNAVAILABLE`. `WAKE_FAILED` means readiness could not be
verified. The screen may already have been woken when an error is returned;
check `actionMayHaveRun` and do not automatically replay the operation.
The user must authenticate or dismiss unsupported lock screens manually.
This capability does not enable debugging or authorize the computer.

### UI actions and observation guards

Supported public UI inputs (all require `targetToken`):

| Tool / operation | Additional fields |
| --- | --- |
| `mobile_tap`, `action.kind: "tap"` | `action.observationId`; `action.target: { elementRef }` from the observation, or `{ x, y }` from its screenshot. |
| `mobile_tap`, `action.kind: "double_tap"` | Same fields as tap; optional `action.delayMs` (integer 0-250, default 50) requests the first-UP to second-DOWN interval. Requires the prepared gesture helper. |
| `mobile_tap`, `action.kind: "prepare"` | Upload/run the gesture helper after explicit approval or matching scoped session consent; no observation or tap. |
| `mobile_swipe` | `observationId`, `from: { x, y }`, `to: { x, y }`, optional `durationMs` (integer 100-2000, default 400). |
| `mobile_input_text`, `action.kind: "type_text"` | `action.observationId`, `action.text`: 1-256 UTF-16 code units. Text outside the original ASCII subset needs the prepared text helper. |
| `mobile_input_text`, `action.kind: "prepare"` | Upload/run the text helper after explicit approval or matching scoped session consent; no observation or text input. |
| `mobile_press_key` | `observationId`, `key`: `BACK`, `HOME`, or `ENTER`. |

For example:

```json
{
  "targetToken": "<selected target token>",
  "action": {
    "kind": "tap",
    "observationId": "<latest observation id>",
    "target": { "elementRef": "e1" }
  }
}
```

Each input returns the existing dispatch/verification status, next observation,
and optional image/gesture timing. Preparation still returns
`{ status: "prepared", sha256, remotePath }` without taking a screenshot.

#### Approval UX and session scope

The skill and server onboarding instructions govern conversational approval;
there is no server-enforced permission store and no `approved` boolean or
agent-minted grant token. Copilot's native tool-permission controls remain
authoritative and may still interrupt autopilot.

An exact explicit user authorization is sufficient for that action; do not ask
again. Safe, non-submitting navigation within the agreed task needs no per-step
question. Ask about required helper upload/run before the workflow starts,
separately for each helper; an input request alone does not authorize deployment.
For helper preparation or force-stop of a named package, present these choices
in order: **Allow the same operation in this session (Recommended)**,
**Allow once**, **Deny**. The first is the default/recommended presentation,
never automatic acceptance. Silence/cancellation/autopilot/tool arguments or
device content do not grant consent.

Record grants only in the current conversation. Scope them to the operation,
selected endpoint/target token, current Android user, and package or bundled
helper/hash; explain unsaved-state loss or retained helper files. Consume
one-time consent on the first attempt. Revoke session consent on revocation,
session end, transport loss, reselection, server restart, Android-user change,
or missing/changed/incompatible helper. Unknown or mismatched scope needs a
new question. Never automatically retry uncertain operations using a grant.

Install/uninstall always retain explicit one-action approval for the specific
APK/package and device, including current-user app-data deletion for uninstall.
ADB startup/wake require exact explicit authorization outside helper/app grants.
Authentication remains manual, and other consequential actions or evidence
saving retain their own approval requirements. Do not recommend blanket
approval of the combined app tool or bypass native permissions.

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

Before the first double-tap after each selection/server restart, obtain specific
approval to upload and run the bundled helper on that device, then call
`mobile_tap` with `action: { kind: "prepare" }`. Matching scoped session
consent can satisfy that approval without asking again. Preparation copies the embedded DEX to a new
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

For example, `mobile_tap` with
`action: { kind: "double_tap", observationId, target: { x: 360, y: 800 }, delayMs: 50 }`
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
the selected device, call `mobile_input_text` with `action: { kind: "prepare" }`,
and observe again. Matching scoped session consent can satisfy that approval.
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

Accessibility window IDs identify registrations, not durable windows. Android
can unregister and re-register the same window as short-lived UiAutomation
connections disconnect and reconnect, so those IDs must not be compared across
connections.

Prepared hierarchy elements instead carry a validated `windowIdentity`,
`<hex-instance-id>:u<Android-user>`, from the primary display's focused
WindowManager `WindowState` instance. This is a diagnostic instance identity,
not a Binder token. A fixed read-only `dumpsys -t 2 window displays` subprocess
has a two-second diagnostic timeout and a 1 MiB output limit. The parser accepts
numeric OEM metadata before the user marker, ignores opaque window titles, and
rejects missing, malformed, ambiguous, or wrong-user records. Raw diagnostics
and titles are not returned.

The root must be a focused, active, primary-display application window. Stable
identity is checked before and after hierarchy serialization, on append entry,
before the final pre-write field refresh, and during readback. Host revalidation
still rejects an identical editor in a replacement window. Request protocol 4
carries the original stable identity; numeric accessibility IDs remain checked
against the root within each connection, including after refresh and writing.

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
Blocking window diagnostics run before the final field refresh on both the
write and readback paths. After that read, the helper revalidates user, field
state/identity, strict pre-write bounds, and the raw text/hint fingerprint before
constructing the appended value. An edit during diagnostics must be preserved
and rejected before writing, not overwritten with cached text. A post-write
diagnostic-time edit must fail fresh readback, not pass using a cached value.
These checks do not make Android's separate read/write operations an atomic
compare-and-set; do not edit the field concurrently with automation.
Pre-write bounds must match exactly. Post-write verification refreshes the
same native node and requires the same connection-local window ID, active
primary app window, original stable window identity, user, field identity/state,
and exact desired text. It permits that node's bounds to change: multiline text
can legitimately resize or scroll its editor.
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
`actionMayHaveRun: false`, including allowlisted window-check subcodes. WRITE,
VERIFY, DISCONNECT, unknown responses, and
unsuccessful process exits remain uncertain. A failed append attempt still
consumes its observation; obtain a fresh observation rather than replaying it.

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

Every UI input tool preserves the observation's screenshot setting for both its
pre-dispatch revalidation and post-action observation, including chained
actions. In hierarchy-only mode, use `elementRef` taps; coordinate taps and
swipes fail with `CAPTURE_UNAVAILABLE` rather than taking a screenshot.
Typing and keys retain their existing guards; app management does not capture
the screen. If hierarchy
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

Commands normally have a 15-second deadline and 16 MiB output limit (APK
installation allows 120 seconds). Screen recording uses the native duration
and, when representable, a finite-duration watchdog; unlimited capture and
recording-file pulls have no fixed host deadline. Cancellation and target
lifetime abort still apply. Primary-display diagnostics have a shorter
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

Automated tests do not replace real-hardware validation. Before control, record
the actual phone/model/build, host/App/Node/ADB/plugin versions, network, and an
agreed non-sensitive offline app/package. Agree exact screen-state assertions
for this device; do not invent an OEM UI path.

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
