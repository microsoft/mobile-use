# Screen recording reference

Follow the first-use, device selection, and recording consent rules in
[the main skill](../SKILL.md) before using these operations.

All operations require `targetToken`, not `observationId`:

| `action.kind` | Input and behavior |
| --- | --- |
| `capabilities` | No other action fields. Returns `status: available`, `source: device-help`, `unlimitedSupported`, `maxTimeLimitSeconds` and `nativeDefaultTimeLimitSeconds`. Read-only metadata; neither creates nor stops a recording. |
| `start` | `action.filePath`: new absolute local Windows `.mp4` path with an existing writable parent. Optional `action.timeLimitSeconds`: positive integer seconds, up to 4294967295 and further restricted by live device capabilities. Omit it for unlimited recording until stopped where supported; never substitute a finite default. Dispatches once and returns `recordingId`, `status: starting`, destination and metadata without waiting for startup. |
| `status` | No other action fields. Returns `idle`, or recording metadata with `starting`, `recording`, `completed` or `saved`; `timeLimitSeconds: null` means unlimited. While `starting`, checks startup once per caller request. Failures remain errors. Does not export or capture a screenshot. |
| `stop` | `action.recordingId`: the ID from this selection's start/status. Finalizes capture, saves the silent MP4 to the original approved path without overwriting, and removes only its generated device temporary files. Returns `saved`, `filePath` and `sizeBytes`. Also saves a recording that already completed at its deadline. |

Only one active/unsaved recording is allowed per selection. Other UI tools
remain available during capture; observe afresh after start/stop, which
invalidate old observations even on failure. A specified duration stops native
recording at its deadline; omitted duration records until stopped. Neither mode
exports automatically; call stop to save. Unlimited capture can exhaust device
storage, and export needs local space for a temporary download and final copy.
Start checks native help, the destination, and the unlocked state before
dispatching capture. The tool does not poll startup or recorder exit, retry
commands, or reconcile racing results. The AI caller decides when to request
status and how to sequence or recover operations. Stop-and-save waits up to ten
seconds for native completion before exporting; it does not retry the signal.
Choose a destination with appropriate Windows folder permissions: staging and
final files inherit them, without additional per-user isolation. No audio,
streaming, helper installation or generic file transfer is provided.
Responses contain metadata and the local path, never video bytes.

## Android version differences and failure handling

These are official AOSP release baselines, not guarantees for every OEM build:

| Android | API | Native recording duration |
| --- | --- | --- |
| 11, 12, 12L, 13 | 30-33 | 1-180 seconds only. Rejects 0 (unlimited) and longer values. |
| 14, 15, 16 | 34-36 | Supports 0 for unlimited and positive durations up to 4294967295 seconds. |

All checked native versions default to 180 seconds if `--time-limit` is absent.
The plugin instead passes `--time-limit 0` for an omitted `timeLimitSeconds`,
so omission is unlimited only when the device supports it. Do not tell the
user that omission means three minutes, or that all Android 11+ phones support
unlimited. Use live `capabilities` results, not just Android version, because
OEM builds and backports may differ. Unknown future versions are not proof.
The plugin probes `--help`; `--version` is absent in the checked Android 11-15
tags and only appears in Android 16.

If `unlimitedSupported` is false and the user wants unlimited, or the requested
duration exceeds `maxTimeLimitSeconds`, explain the exact device limit and ask
for approval of a supported explicit duration. Never silently shorten the
request, chain clips, install another recorder, or change device settings.
`RECORDING_DURATION_UNSUPPORTED` is a preflight error with
`actionMayHaveRun: false`: no capture/directory was created; a later approved
supported start does not need device reselection.
`RECORDING_CAPABILITIES_UNAVAILABLE` means missing or unrecognized native help;
stop and report it, never trial-record or infer support from API level.
Other native startup or encoder errors can still be uncertain; inspect status
and never automatically replay them.

This tool uses the native ADB recorder, not the phone's Quick Settings recorder,
a MediaProjection app, or scrcpy. Their audio, permission and duration features
do not apply here. All checked native tags are video-only; this plugin outputs
silent MP4 on the primary display at 4 Mbps. Resolution/codec availability,
orientation changes, free space and OEM/device policy still affect success.
Avoid rotating mid-clip and verify playback; help does not prove a good clip.
Protected content may be blank or rejected; never use root or secure-capture
flags to bypass it. Native size, bitrate and display options are not public
arguments in this tool.

Sources checked 2026-10-30: AOSP
[Android 11](https://android.googlesource.com/platform/frameworks/av/+/android-11.0.0_r1/cmds/screenrecord/screenrecord.cpp),
[Android 13](https://android.googlesource.com/platform/frameworks/av/+/android-13.0.0_r1/cmds/screenrecord/screenrecord.cpp),
[Android 14](https://android.googlesource.com/platform/frameworks/av/+/android-14.0.0_r1/cmds/screenrecord/screenrecord.cpp),
[Android 16](https://android.googlesource.com/platform/frameworks/av/+/android-16.0.0_r1/cmds/screenrecord/screenrecord.cpp).
Research/fixtures are not real-hardware verification for every Android version.

An explicit request already naming the content, device, duration or unlimited
capture, and destination is sufficient; do not ask twice for that same scope.
Otherwise obtain missing
approval before start. Do not use blanket helper/app consent as recording
consent. Never automatically replay uncertain start/stop. A cancelled or
unverified start can leave `starting` metadata; inspect status and use its ID
only for an explicitly authorized stop. Export failures retain the device
capture. If cleanup fails after a save, status still reports the saved path;
another explicit stop retries cleanup only.

Host-command failure does not prove native capture stopped. Its error includes
the recording ID: on a still-current target, obtain an explicit stop request to
verify and signal only the owned process. Failed clips cannot be exported.
Command errors are returned without being replaced by inferred success, even if
the recorder completes concurrently. Check status before deciding whether a
further stop/save is appropriate within the approved task; never blindly replay.
Stop and status do not repeat build/TLS checks.
Saved cleanup also succeeds when the owned directory is already absent.
Failed or unsaved clips retain their device files and block
another start. There is no discard/delete operation; confirm capture stopped
before explicitly reselecting, which does not clean those retained files.
An export with no local file-size progress for 30 seconds fails explicitly;
healthy progressing transfers have no fixed total deadline. Cancellation during
the final copy removes its partial local destination. Never automatically retry
an uncertain export.

Transport loss, reselection, server restart or shutdown cancels the attached
ADB command and invalidates the recording ID. Android capture may continue;
only an explicitly specified duration supplies a fallback deadline. Unlimited
capture has none: the user must verify capture stopped on the phone.
Unexported temporary files can remain
under `/data/local/tmp/mobile-use-recording-*`. Never silently reconnect,
switch endpoints, or automatically export/recover through a new selection.
Protected content may be blank or unavailable; report it without bypasses.
