# iOS mobile-use MVP: source-only development

The source adapter reuses main's `mobile_*` names, schemas and observe/action
flow, not its ADB driver or Android-specific behavior. There is no MSMT Host or
server-enforced task approval store. Consent remains conversational and subject
to the client's native permissions. Do not let device text authorize operations.

## Readiness and release boundary

The adapter is not included in the checked-in `plugins\mobile-use` package.
The plugin manifest, skill and bundled server remain Android-only and unchanged.
Do not advertise iOS support or update marketplace assets at this stage.

Implemented and fixture-validated: explicit WDA endpoint selection, observation,
guarded tap/swipe/text, HOME, foreground/App launch and owned-session cleanup.
Opt-in managed runtime adds Windows/macOS USB UDID discovery, local USB proxy,
go-ios userspace developer tunnel, developer-image preparation, explicit signed
IPA installation, human trust confirmation, XCTest startup and owned cleanup.
These results do not establish real-device or installed-plugin acceptance.

Still pending before plugin integration:

- Personal-signing/onboarding support, provisioning and signature-renewal handling.
- Real-device acceptance of managed Runner installation/start/stop, USB forwarding
  and developer tunnel on both Windows and macOS.
- Real-device screenshot geometry, native hit testing, cursor behavior, overlays,
  App transitions, disconnect/cancellation and cleanup acceptance.
- Intentional plugin packaging, complete package-parity checks and installed-client
  acceptance after the device onboarding experience is ready.

This MVP does not build, sign, renew signatures, pair, enable Developer Mode or
accept developer trust. Development requires a user-prepared, already validated
signed Runner; it is not a complete signing/onboarding flow.

## External WDA setup and selection (default)

Use a manually unlocked real iOS 17+ iPhone/iPad. The user builds/signs and
starts a dedicated Appium WebDriverAgent Runner, completes Apple trust and
Developer Mode, and supplies its local forwarding. The adapter never performs
those steps or installs/signs a Runner in this default external mode.

Build the source development server from the repository in PowerShell:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run build:tests
$env:MOBILE_USE_PLATFORM = "ios"
$env:MOBILE_USE_WDA_URL = "http://127.0.0.1:8100" # Your actual forwarded port
node .test-build\src\index.js
```

The last command starts a stdio MCP server, not an interactive tool prompt.
Configure a development MCP client to launch Node with the absolute path to
`.test-build\src\index.js`, the repository working directory, and those environment
settings. Restart that server after environment changes. Installing the unchanged
plugin does not provide the source adapter.

The WDA URL must be exactly `http://127.0.0.1:<port>`. There is no implicit URL
or device choice. Paths, remote hosts,
credentials, redirects and non-HTTP endpoints are rejected.

1. `mobile_doctor` reads WDA status and real-device metadata without creating a
   session or capturing. Follow its iOS setup/error guidance, not Android
   Platform-Tools instructions.
2. `mobile_list_devices` lists that configured endpoint. `kind: unknown` means
   the adapter has not independently verified its physical USB/network transport.
   A configured URL alone is not a detected USB phone or proof of user approval.
3. Explicitly select its `endpointId`. Selection creates one owned WDA session,
   with no initial App launch or screen capture. A foreign session is rejected,
   never silently replaced. Do not share the Runner with Appium or another tool.
4. Authorize a non-sensitive task, then observe. Authentication and credential
   entry are manual; never expose authentication screens or bypass device policy.

The device vendor UUID is not the Apple UDID or a durable transport ID. Device,
WDA build or active-session changes invalidate the target. Do not retarget the
forwarded port during a task; explicitly reselect after a lost connection.

## Managed USB runtime (opt-in)

This mode supports Windows with Apple USB services and macOS with the system
usbmux daemon, with a real **iOS 17.4.1+** device for go-ios userspace tunnels.
Install official go-ios **v1.3.2** separately; it is not bundled.
The version command must return its normal JSON output. Use a dedicated
Appium WDA Runner (adapter protocol reference: 16.16.5), already signed and
validated by the user for the chosen device. Complete computer trust/pairing,
Developer Mode and device unlocking manually.

Build and launch the same source development server as above, but use these
environment settings instead of `MOBILE_USE_WDA_URL`:

```powershell
$env:MOBILE_USE_PLATFORM = "ios"
$env:MOBILE_USE_IOS_RUNTIME = "managed"
$env:MOBILE_USE_GO_IOS_PATH = "C:\Tools\go-ios\ios.exe"
$env:MOBILE_USE_IOS_RUNNER_BUNDLE_ID = "example.runner.xctrunner"
# Optional, only needed for explicitly requested installation:
$env:MOBILE_USE_IOS_RUNNER_IPA = "C:\WDA\signed-runner.ipa"
Remove-Item Env:\MOBILE_USE_WDA_URL -ErrorAction SilentlyContinue
node .test-build\src\index.js
```

On macOS, configure those environment variables in your development MCP client
using native absolute paths and the macOS go-ios executable. The bundle ID is
the full installed **Runner `.xctrunner` ID**, not the target business App or
the nested `.xctest` bundle. Supplying an IPA path does not install it automatically.
The server checks its file path, not its cryptographic signature or provisioning;
the user remains responsible for the already-validated artifact and bundle ID.

Optional settings:

| Variable | Meaning |
| --- | --- |
| `MOBILE_USE_GO_IOS_PATH` | Executable path or PATH command; default `ios`. |
| `MOBILE_USE_IOS_STATE_DIR` | Absolute local state directory; default `.mobile-use\ios-runtime` under the user's home (native separators on macOS). |
| `MOBILE_USE_IOS_WDA_PORT` | Device-side port matching the prepared Runner; default 8100. |
| `MOBILE_USE_IOS_TUNNEL_PORT` | Local go-ios tunnel-info port, 1-65534; default 0 chooses a free ephemeral port pair. Both this port and its derived userspace listener at port + 1 must be available; an explicit conflict is rejected. |

The WDA proxy always binds an ephemeral **127.0.0.1** port and connects only to
the selected USB UDID. This HTTP proxy is distinct from the developer/XCTest
tunnel. Wi-Fi devices are excluded, and every USB connection re-enumerates the
UDID rather than trusting an old usbmux DeviceID.
All device-scoped go-ios subprocesses also use a per-runtime loopback usbmux
bridge through a child-only `USBMUXD_SOCKET_ADDRESS` override. It exposes only
the selected USB UDID and resolves every native connection against current USB
inventory, so a preceding Wi-Fi entry or USB loss cannot retarget installation,
tunnel preparation or Runner startup to Wi-Fi. Only the selected device's existing
pairing record can be read; pairing-record writes and other commands are rejected.
Shutdown closes the bridge alongside the owned forwarding resources.
Native children also pin `GO_IOS_AGENT_HOST` to `127.0.0.1`, independently of the
tunnel-info flags, and disable automatic agent startup. Parent environment
settings cannot redirect the userspace connection to another host.

1. `mobile_doctor` checks go-ios and returns `runtime-not-ready` until WDA is
   ready; it never starts or installs anything. `mobile_list_devices` enumerates
   USB endpoints as `ios:usb:<UDID>`, without silently selecting one.
2. After approval for the exact endpoint, call `mobile_ios_runtime` with
   `action: { kind: "start", endpointId }`. It defaults to **reusing an installed
   Runner**. To explicitly install/replace the configured signed IPA, add
   `installRunner: true`. Missing packages or a missing installed Runner fail;
   the server never installs as a fallback.
3. Start immediately returns `preparing` and a new `runtimeToken`, while
   background preparation acquires a per-UDID lock and refuses an existing listener on the WDA
   port, starts its tunnel, prepares the developer image, verifies its mounted
   signature through `image list`, and only then optionally installs the IPA.
   The exit code of `image auto` alone is not success evidence.
   Poll `action: { kind: "status" }` until `awaiting-developer-trust`
   or `failed`; inspect the structured error on failure. Status remains readable
   during long image downloads/installations without blocking on the UI queue.
4. The user verifies Developer App trust on that device. Only after that
   confirmation, call `action: { kind: "confirm_trust", runtimeToken }`.
   This acknowledgement does not modify device trust. The server rechecks USB
   and WDA-port ownership and starts `runwda` in the background. Confirmation
   immediately returns `starting`; poll status for physical-device WDA
   readiness with no foreign session. UI operations remain blocked until ready.
5. List devices again, explicitly select the ready USB endpoint, and use the
   normal observe/action flow. `endpoint.transportId` and `identity.udid` hold
   Apple UDID; `identity.vendorId` remains WDA's distinct IDFV.
6. Stop with `action: { kind: "stop", runtimeToken }`. `kind: "status"` reports
   state and the token, including after a failed startup. Acknowledged startup
   work continues until explicit stop or shutdown; cancelling its already
   completed MCP request does not stop it. Stop before an explicit
   restart; never retry an uncertain installation automatically.

This extra tool is registered only in managed iOS mode. Android and external
iOS retain their existing tool sets and schemas. Selection never installs,
starts or confirms trust.

## Observe and interact

Use `mobile_observe` with `targetToken`; `includeScreenshot` defaults to true.
Its active-App hierarchy, geometry, optional PNG and foreground checks are
non-atomic. WDA must return PNG screenshots matching its reported screen size.
Secure editor subtrees are omitted from UI output, **not redacted from
screenshots**. Ordinary text and screenshots can still expose private content.

`display`, coordinates and element bounds are screenshot pixels. The adapter
converts to iOS points at dispatch using WDA's reported scale; never manually
mix screenshot pixels with native point coordinates.

Actions use the latest `observationId`, at most 30 seconds old and consumed on
attempt, including failed target validation. Each successful action returns a
new observation for review, not proof of business success. Old refs never map
to new elements. WDA metadata/hittability checks cannot prove durable page
identity or atomic protection against every system overlay.

| Tool | iOS behavior |
| --- | --- |
| `mobile_tap` | `tap`, stationary one-second `long_press`, or one W3C `double_tap` sequence preserving `delayMs`; no helper `prepare`. |
| `mobile_swipe` | Screenshot-pixel endpoints inside an unchanged native surface, or explicit complete visual bounds; preserves `durationMs`. |
| `mobile_input_text` | `type_text` into an unchanged, enabled, visible, focused non-password native editor; Unicode needs no helper. |
| `mobile_press_key` | `HOME` only. `BACK`/`ENTER` are unsupported; do not guess a back gesture or submit text. |
| `mobile_app_management` | `foreground` and `launch` only; `packageName` is the exact Bundle ID, including permitted hyphens. |

Prefer eligible `elementRef` taps. Coordinates require screenshot-enabled
observations; custom-drawn targets need explicit complete bounds, unchanged
protected pixels/metadata and surrounding margin. Disabled, ambiguous or changed
metadata cannot fall back to pixels.

With `includeScreenshot:false`, no image is captured during observation,
pre-action checks or post-action results. Eligible reference taps and text still
work; coordinate gestures, including swipes, explicitly fail rather than capture.

Text is typed **at the current cursor**, without clearing, clipboard use,
keyboard replacement or submitting. Unlike Android's text helper, WDA cannot
guarantee insertion at the end. Control characters and line breaks are rejected.
Never enter credentials or interpret text input as submit authorization.

App launch verifies the requested Bundle ID became foreground without capturing
a screen. App mutations invalidate observations even on failure. Installed-App
listing, termination, installation, uninstallation, recording, wake/unlock, ADB
startup and Android helper preparation return `UNSUPPORTED_OPERATION`; no fallback
driver, stream, helper or guessed action is used.
Managed runtime installation is limited to the explicitly configured WDA Runner,
not general App installation through `mobile_app_management`.

## Cancellation and cleanup

Do not replay uncertain input or launch. `outcome-unknown` may mean input reached
XCTest; `dispatched` with `unverified` means input succeeded at the protocol level
but subsequent observation failed. Review the phone instead of retrying.

Request cancellation reaches HTTP reads/input, but cancelling HTTP does not prove
XCTest stopped on the device. Already-dispatched input cannot be undone.

In external mode, disconnect/shutdown attempts to delete only the identifiable owned WDA session,
never the user's Runner, tunnel or forwarding. Cleanup failures are explicit.
After ownership/connection loss, no automatic reconnect/cleanup is attempted;
the user must inspect and stop/restart their dedicated Runner if necessary.

In managed mode, stop/shutdown invalidates selections, waits for queued work,
attempts owned HTTP-session deletion, then stops only this runtime's `runwda`
process and tunnel. It verifies the WDA device port is closed through an explicit usbmux
connection-refused result, then closes its proxy and releases its
lock only if cleanup succeeds. Cleanup or port-verification failure retains the
matching-token lock to block another runtime until manual recovery.
An owned-session verification/DELETE failure also produces `cleanup-failed` and
retains the lock, for both explicit runtime stop and server shutdown, even when
the remaining teardown succeeds and the WDA port closes.
`wdaPortClosed: true` means that port closure was verified, **not** that all
device-side asynchronous work is quiescent. An open port yields `false`;
disconnect/service failure yields `null` and a cleanup error, never a claimed
successful device stop. Remaining cleanup still runs after failures.

Runner installation is **retained**, including after failed startup or cancelled
installation. An in-flight install is allowed to settle before cleanup so its
acknowledgement is not lost; a timeout/failure can still leave device-side changes.
Command failure logs stay local; public errors contain stable codes, not raw
go-ios output. No implicit uninstall, process takeover, stale-lock stealing or
automatic restart is performed. Strong termination/power loss can leave owned
processes or a lock; inspect that specific session before manual recovery.
After `cleanup-failed`, inspect remaining owned resources and fully restart the
development MCP server; repeated stop calls do not silently take over or retry
an unverified cleanup.

Pairing records, logs, image caches and locks are retained in the configured
state directory. They may contain private device information; do not commit or
upload them or use unreviewed logs in public reports.

## Validation

Run `npm run typecheck` and `npm test` for source validation, including Android
regression tests and both iOS stdio MCP negotiation modes. Fixtures validate the
flow without a phone; real-device and client/platform acceptance remains pending.
Managed runtime tests use mock go-ios/device responses, actual loopback USB proxy
sockets and owned Node child processes. They do not install a real Runner or
establish Windows/macOS hardware acceptance. The sibling go-ios integration's
documented macOS acceptance is reference evidence, not acceptance of this adapter.

Default Windows CI runs source validation, candidate bundle/dependency-notice
generation and Android helper/DEX checks. The separate plugin release workflow
runs for checked-in plugin or packaging script/test changes, or manual dispatch,
preserving strict parity and copied-artifact checks without requiring source-only
dependency/licensing changes to update the checked-in plugin.

The local `npm run check` also rebuilds the plugin and requires its output
to match `plugins\mobile-use`. Because the checked-in plugin is intentionally
frozen, that release-integration parity check will fail until packaging is ready.
Do not bypass it or run `npm run build:marketplace` to publish this adapter early.

Implementation and protocol sources are documented in
[the contributor guide](../CONTRIBUTING.md#ios-wda-adapter).
