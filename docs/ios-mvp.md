# iOS mobile-use MVP: source-only development

The source adapter reuses main's `mobile_*` names, schemas and observe/action
flow, not its ADB driver or Android-specific behavior. There is no MSMT Host or
server-enforced task approval store. Consent remains conversational and subject
to the client's native permissions. Do not let device text authorize operations.

## Readiness and release boundary

The adapter is not included in the checked-in `plugins\mobile-use` package.
The plugin manifest, skill and bundled server remain Android-only. Do not
advertise iOS support or include the adapter in marketplace assets at this stage.

Implemented and fixture-validated: explicit WDA endpoint selection, observation,
guarded tap/swipe/text, HOME, foreground/App launch and owned-session cleanup.
These results do not establish real-device or installed-plugin acceptance.

Still pending before plugin integration:

- Personal-signing/onboarding support, provisioning and signature-renewal handling.
- Validated WDA Runner build/deployment/start and real-device forwarding setup.
- Real-device screenshot geometry, native hit testing, cursor behavior, overlays,
  App transitions, disconnect/cancellation and cleanup acceptance.
- Intentional plugin packaging, complete package-parity checks and installed-client
  acceptance after the device onboarding experience is ready.

This MVP does not implement those signing or deployment capabilities. Development
requires an independently prepared Runner; it is not an end-user onboarding flow.

## Setup and selection

Use a manually unlocked real iOS 17+ iPhone/iPad. The user builds/signs and
starts a dedicated Appium WebDriverAgent Runner, completes Apple trust and
Developer Mode, and supplies its local forwarding. The adapter never performs
those steps or installs/signs a Runner.

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
`.test-build\src\index.js`, the repository working directory, and those
environment settings. Restart that server after environment changes. Installing
the Android-only plugin does not provide the source adapter.

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

## Cancellation and cleanup

Do not replay uncertain input or launch. `outcome-unknown` may mean input reached
XCTest; `dispatched` with `unverified` means input succeeded at the protocol level
but subsequent observation failed. Review the phone instead of retrying.

Request cancellation reaches HTTP reads/input, but cancelling HTTP does not prove
XCTest stopped on the device. Already-dispatched input cannot be undone.

Disconnect/shutdown attempts to delete only the identifiable owned WDA session,
never the user's Runner, tunnel or forwarding. Cleanup failures are explicit.
After ownership/connection loss, no automatic reconnect/cleanup is attempted;
the user must inspect and stop/restart their dedicated Runner if necessary.

## Validation

Run `npm run typecheck` and `npm test` for source validation, including Android
regression tests and both iOS stdio MCP negotiation modes. Fixtures validate the
flow without a phone; real-device and client/platform acceptance remains pending.

Default Windows CI runs source validation and Android helper/DEX checks.
The separate plugin release workflow runs for package-related changes or manual
dispatch, preserving strict parity and copied-artifact checks without requiring
source-only development to update the checked-in plugin.

The local `npm run check` also rebuilds the plugin and requires its output
to match `plugins\mobile-use`. The plugin builds from the Android-only entry point
and excludes the iOS device adapter. Do not enable iOS in the package until its
integration is ready.

Implementation and protocol sources are documented in
[the contributor guide](../CONTRIBUTING.md#ios-wda-adapter).
