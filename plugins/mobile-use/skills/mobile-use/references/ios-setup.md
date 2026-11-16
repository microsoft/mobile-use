# iOS setup and WebDriverAgent workflow reference

Follow the consent and safety boundaries in [the main skill](../SKILL.md) before
observing or interacting with a physical iOS 17+ iPhone or iPad.

## Prerequisites and runtime modes

The plugin never signs code, modifies Apple developer profiles, pairs over USB,
enables Developer Mode, or replaces a foreign WebDriverAgent (WDA) session.
The user completes Apple pairing, Developer Mode, and signing outside chat;
signing certificates, Apple IDs, passcodes, and pairing records never belong in
conversation.

Two local iOS runtime paths are supported. Both require setting
`MOBILE_USE_PLATFORM=ios` in the MCP server launch environment and fully
quitting/reopening Copilot after configuration changes (without
`MOBILE_USE_PLATFORM=ios`, the server starts in Android mode and omits iOS
discovery and `mobile_ios_runtime`):

1. **Managed USB runtime (`MOBILE_USE_PLATFORM=ios`, `MOBILE_USE_IOS_RUNTIME=managed`)**:
   - Requires a physical iOS 17.4.1+ device connected over USB (Windows with
     Apple USB services or macOS), `go-ios` `v1.3.2` (`MOBILE_USE_GO_IOS_PATH`,
     default `ios`), and `MOBILE_USE_IOS_RUNNER_BUNDLE_ID` set to the user-built
     signed `.xctrunner` bundle ID (optional `MOBILE_USE_IOS_RUNNER_IPA` absolute
     `.ipa` path and `MOBILE_USE_IOS_STATE_DIR`). Do not set `MOBILE_USE_WDA_URL`.
     Restart Copilot after setting these variables.
   - `mobile_doctor` and `mobile_list_devices` are strictly read-only and never
     start tunnels, mount developer images, or install apps.
   - After explicit user approval for an enumerated `ios:usb:<UDID>` endpoint,
     call `mobile_ios_runtime` with `action: { kind: "start", endpointId, installRunner: false }`
     (`installRunner: true` only when the user explicitly approves installing or
     replacing the configured signed `.ipa`).
   - `start` returns `state: "preparing"` and a `runtimeToken`. Poll
     `action: { kind: "status" }`. When `state` reaches
     `"awaiting-developer-trust"`, ask the user to verify Developer App trust in
     iOS Settings on that device. Never call `confirm_trust` until the user
     explicitly confirms trust.
   - Call `action: { kind: "confirm_trust", runtimeToken }`, then poll `status`
     while `"starting"` until `"ready"` or `"failed"`.
   - Once `"ready"`, call `mobile_select_device` for that `ios:usb:<UDID>`
     endpoint. Stop managed resources explicitly with
     `action: { kind: "stop", runtimeToken }`; stopping retains the installed
     Runner and local pairing/image caches.
2. **External user-managed WDA (`MOBILE_USE_PLATFORM=ios`, `MOBILE_USE_IOS_RUNTIME=external`, default for iOS mode)**:
   - Requires a real unlocked iOS 17+ device with a dedicated user-started WDA
     Runner and local port forwarding, plus `MOBILE_USE_PLATFORM=ios` and
     `MOBILE_USE_WDA_URL` set to the exact `http://127.0.0.1:<port>` endpoint,
     followed by a full Copilot restart.
   - Do not share the Runner with Appium or another client: foreign WDA sessions
     are rejected (`WDA_SESSION_CONFLICT`), never taken over or deleted.
   - Shutdown deletes only the identifiable WDA HTTP session created by
     `mobile_select_device`, leaving the user's Runner and port forwarding intact.

## iOS observation, gestures, text, and app rules

- **Selection**: `mobile_select_device` verifies physical iOS 17+ identity and
  creates an owned WDA session without launching an app or capturing a screen.
- **Coordinates and screenshots**: Element `bounds` and gesture coordinates are
  reported and accepted in **screenshot pixels**; the adapter converts them to
  iOS points using verified display scale. `includeScreenshot: false` skips PNG
  capture across observation, revalidation, and post-action reads and blocks
  coordinate taps and swipes. UI trees omit secure text subtrees, while
  screenshots are unredacted.
- **Taps and swipes**: Use eligible `elementRef` controls determined by native
  iOS roles (not Android clickable flags), or screenshot coordinates with full
  `target.bounds` / swipe `bounds` when visual fallback is needed. `double_tap`
  runs as one W3C touch sequence preserving `delayMs` without any helper
  `prepare` step. `long_press` is a fixed one-second stationary press; never
  substitute it for `tap`.
- **Keys**: `mobile_press_key` supports `HOME` (and hardware volume keys where
  enabled by schema). `BACK` and `ENTER` are unsupported on iOS; never simulate
  `BACK` with an unapproved edge-swipe guess.
- **Text input**: `mobile_input_text` (`action.kind: "type_text"`) types 1-256
  UTF-16 code units (including Unicode and emoji without helper preparation) at
  the **current cursor** of one unchanged, enabled, visible, focused
  non-password native iOS editor. Unlike Android's text helper, WDA cannot
  guarantee insertion at the end of existing text. Control characters and line
  breaks are rejected; never clear or submit fields automatically.
- **App management**: `mobile_app_management` supports `foreground` and `launch`
  only, where `packageName` is the exact iOS **Bundle ID**. `list`, `terminate`,
  `install`, and `uninstall` are unsupported on iOS.
- **Android-only tools**: `mobile_wake`, `mobile_screen_recording`, and
  `mobile_start_adb_server` are Android-only; never call WDA unlock, capture
  passcode screens, start WDA MJPEG streams as a recording substitute, or fail
  over from an iOS error to ADB.
