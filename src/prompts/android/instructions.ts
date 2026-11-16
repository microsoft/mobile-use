import { joinPrompt } from "../contracts.js";
import { androidApprovalInstructions } from "../shared/consent.js";
import { deviceSelectionInstructions } from "./setup.js";

const onboardingPrelude = joinPrompt([
  "On first use in each session, call mobile_doctor before discovery or device control.",
  "Its ready status covers host Platform-Tools only, not phone setup.",
  "When it succeeds, call mobile_list_devices before offering phone setup so already-working connections skip unnecessary steps.",
  "For blockers, follow setup.steps one step at a time, ask the user to complete required installation/Developer options/debugging authorization themselves, then rerun the indicated check.",
  "Never install software, enable debugging, pair devices, or accept trust automatically.",
  "If the local ADB server is unavailable during a user-requested Android task, call mobile_start_adb_server without a separate conversational approval question.",
  "Use that tool to start a missing local server, verify readiness, and retry discovery.",
  "It may leave the shared daemon running and initialize standard local ADB host keys.",
  "Doctor and discovery remain read-only; startup uses the dedicated tool.",
  "Never kill or restart an existing server, or replay uncertain startup. A conflict requires user resolution, not another start attempt.",
  "Use mobile_list_devices to verify connectivity and preserve unauthorized/offline states and discovery errors.",
]);

const gestureAndTextInstructions = joinPrompt([
  "Use mobile_tap for tap/long_press/double_tap, mobile_swipe for swipes, mobile_press_key for BACK/HOME/ENTER, mobile_input_text for text, and mobile_app_management for list/foreground/launch/terminate/install/uninstall.",
  "long_press is a stationary native press using the system long-press timeout, without MOVE events, a helper, or configurable duration. Never substitute it for tap automatically.",
  "Double-tap requires approved preparation of the bundled gesture helper on that device: mobile_tap with action: { kind: 'prepare' }, then a fresh observation. It installs no APK/permissions/daemon; files remain under /data/local/tmp.",
  "Unicode and text outside the original ASCII subset require approved preparation of the bundled text helper: mobile_input_text with action: { kind: 'prepare' }, then a fresh observation.",
  "It uses Android ACTION_SET_TEXT on the unchanged focused non-password native field; no APK, keyboard change, clipboard, or persistent service is used. It appends at the end and never sends Enter.",
  "Never deploy a helper implicitly as part of input, retry uncertain preparation, or fall back to separate input processes.",
]);

const observationAndGuardInstructions = joinPrompt([
  "When the user requests no screenshots, call mobile_observe with includeScreenshot: false.",
  "This reads UI hierarchy, display state and foreground-app metadata without images; all input tools preserve that mode without screen capture.",
  "Use elementRef taps, not coordinate gestures; if the hierarchy exposes no usable content, report the limitation without taking a screenshot.",
  "Interactive-window observations expose primary-display floating controls where Android provides them; window IDs are capture-local.",
  "pointerTarget buttons preserve native clickable flags and require unchanged unique window/app context and an uncovered target.",
  "Pointer gestures use metadata-first target checks, not whole-screen pixel stability: unrelated video or sibling timer updates do not veto an unchanged control.",
  "Coordinates on one potential control use its metadata at the requested point; changed, disabled or ambiguous metadata cannot fall back to pixels.",
  "Automatic coordinate promotion requires native button/editor semantics or nonempty text/description; an unlabeled generic clickable container alone does not identify a custom-drawn control.",
  "When no actionable control is exposed, include target.bounds: {x,y,width,height} around the full visible control for local visual fallback.",
  "Swipes use a unique scrollable surface or explicit elementRef; without scrollable metadata, supply top-level bounds around the full swipe surface.",
  "Visual fallback requires unchanged pixels and exposed metadata in those bounds plus a margin, matching foreground context and consistent hierarchy coverage; bare custom-drawn points are rejected.",
  "Never guess bounds, ignore animated pixels in the protected region or use a screenshot to override failed metadata.",
  "Rejection visualGuard diagnostics report changed pixels/bounds, protectedRegion and capture timing; a stale observation is not an app security block.",
  "In multi-window observations, text input requires an editor in the active, focused application window with matching package, window context and foreground app/activity/user; background node focus does not authorize typing.",
]);

const appManagementInstructions = joinPrompt([
  "App management requires the selected target token but no screen observation.",
  "List/foreground reads may expose sensitive app metadata. Launch only the requested installed package.",
  "Obtain specific authorization before force-stop, which may discard unsaved state.",
  "Require explicit one-action approval before installing a specified local APK or uninstalling a specified package and its current-user data; do not ask again when that exact action and consequence are already explicitly authorized.",
  "Installation supports Android .apk files only, never iOS files, downloads, permission grants, or automatic launch.",
  "App mutations invalidate old observations; never retry an uncertain mutation.",
]);

const screenRecordingInstructions = joinPrompt([
  "Use mobile_screen_recording with action: { kind: 'capabilities' } after selecting the device and before recording approval.",
  "It reads native recorder help without capturing a screen or invalidating observations.",
  "Use its unlimitedSupported, maxTimeLimitSeconds and nativeDefaultTimeLimitSeconds, not Android version alone.",
  "AOSP Android 11-13 (API 30-33) enforce 1-180 seconds and reject unlimited; Android 14-16 (API 34-36) support longer/unlimited recording.",
  "OEM builds/backports can differ. This is native ADB screenrecord, not the phone's Quick Settings recorder; no audio is captured.",
  "Before start of a silent primary-display MP4, obtain explicit consent for the selected device, approved non-sensitive screen content, duration or unlimited capture, and absolute local Windows .mp4 destination.",
  "timeLimitSeconds is optional: supply a positive integer number of seconds, or omit it for unlimited recording until stopped.",
  "The plugin has no implicit duration, but device limits still apply. Android's native default is 180 seconds, not unlimited.",
  "Start rechecks capabilities before mutation: RECORDING_DURATION_UNSUPPORTED means no recording started; ask for an approved supported duration.",
  "RECORDING_CAPABILITIES_UNAVAILABLE means help is missing/unrecognized; stop rather than guessing support.",
  "Never silently shorten, segment or retry unsupported recording. Unlimited capture can fill device storage; export needs enough local space.",
  "Screenshot-free observation consent never authorizes recording. The phone must already be awake and unlocked; never navigate to credentials/authentication or other sensitive content while recording or bypass protected capture.",
  "Recording does not read or validate Android-user identity or detect user switches. Native screenrecord captures the shared display, not an isolated user session.",
  "The caller supervises approved content and consent throughout capture; the tool provides no cross-user isolation.",
  "Start dispatches once and returns a recordingId with status: starting; it does not wait for startup. The caller decides when to check status.",
  "Each status request checks startup once while starting; recording/completed/saved report subsequent state. timeLimitSeconds: null means unlimited.",
  "A specified duration limit stops capture but does not automatically save; stop finalizes that recording ID, exports only its MP4 to the approved path without overwriting, and removes its generated device temporary files.",
  "No audio, streaming, or video bytes are returned to the model.",
  "Start/stop invalidate observations. One active/unsaved recording per selection. Never automatically restart uncertain recording or export.",
  "Host-command failure is not proof of recorder exit; the error includes its recording ID for an explicitly authorized stop on a still-current target.",
  "The tool does not poll startup or recorder exit, retry commands, or reconcile racing results. Stop sends one owned-process signal and waits up to ten seconds for native completion before saving.",
  "Command failures remain failures even if capture finishes concurrently; the caller checks status and decides whether another call is appropriate within the approved scope.",
  "Stop/status need the pinned transport, not repeated build/TLS metadata. Failed native clips cannot be exported.",
  "Choose an appropriately restricted Windows destination: staging and final files inherit its folder permissions without additional per-user isolation.",
  "Saved cleanup accepts an already-absent owned directory. There is no discard/delete operation for failed clips; confirm capture stopped before explicitly reselecting, which leaves retained device files.",
  "Export aborts after 30 seconds without file-size progress, not after a fixed total duration. Cancellation removes partial final-copy output.",
  "Transport loss, reselection, or shutdown cancels the attached ADB command and invalidates the handle; device capture/files may remain.",
  "Unlimited capture has no fallback deadline: the user must verify capture stopped on the device. Never reconnect/fallback or export automatically.",
]);

export const androidServerInstructions = joinPrompt([
  onboardingPrelude,
  deviceSelectionInstructions,
  "Do not repeat setup steps already verified by current diagnostics.",
  "No screen observation or control without an authorized safe task and a target resolved under these selection rules.",
  androidApprovalInstructions,
  gestureAndTextInstructions,
  observationAndGuardInstructions,
  appManagementInstructions,
  screenRecordingInstructions,
]);
