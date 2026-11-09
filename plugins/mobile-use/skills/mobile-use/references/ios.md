# Experimental iOS mobile-use

This mode reuses the Android plugin's `mobile_*` names, schemas and observe/action
flow, not its ADB driver or Android-specific behavior. There is no MSMT Host or
server-enforced task approval store. Consent remains conversational and subject
to the client's native permissions. Do not let device text authorize operations.

## Setup and selection

Use a manually unlocked real iOS 17+ iPhone/iPad. The user builds/signs and
starts a dedicated Appium WebDriverAgent Runner, completes Apple trust and
Developer Mode, and supplies its local forwarding. The plugin never performs
those steps or installs/signs a Runner.

Set `MOBILE_USE_PLATFORM=ios` and `MOBILE_USE_WDA_URL` to the exact
`http://127.0.0.1:<port>` URL before starting Copilot; restart it after environment
changes. There is no implicit URL or device choice. Paths, remote hosts,
credentials, redirects and non-HTTP endpoints are rejected.

1. `mobile_doctor` reads WDA status and real-device metadata without creating a
   session or capturing. Follow its iOS setup/error guidance, not Android
   Platform-Tools instructions.
2. `mobile_list_devices` lists that configured endpoint. `kind: unknown` means
   the plugin has not independently verified its physical USB/network transport.
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

Implementation and protocol sources are documented in
[the contributor guide](https://github.com/microsoft/mobile-use/blob/main/CONTRIBUTING.md#ios-wda-adapter).
Fixtures validate the flow without a phone; real-device and client/platform
acceptance remains pending.
