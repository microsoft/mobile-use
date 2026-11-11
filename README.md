# mobile-use

Use GitHub Copilot to observe and interact with a **real Android 11+ phone or
tablet** from Windows, over USB or modern paired wireless ADB.

Read screens or UI text, tap and swipe, enter text, manage apps, and record
silent screen videos on a device you explicitly select.

An **experimental iOS 17+ adapter** is included but not yet supported. Personal
signing and real-device acceptance remain pending; see the
[iOS MVP status](docs/ios-mvp.md).

**Experimental:** this is a proof of concept, not a released or
production-supported product. USB workflows, including screen recording, have
been tested on one Android 11 phone. Paired-wireless acceptance remains
**unverified**.

## Requirements

- Windows and GitHub Copilot App with plugin support.
- A maintained Node.js release, minimum **22.2.0**; Node 24 LTS is recommended.
- Current official [Android SDK Platform-Tools](https://developer.android.com/tools/releases/platform-tools).
- A real Android 11+ device exposing Wireless debugging, plus either a
  data-capable USB cable or a trusted, reachable local network for wireless.

Node and Platform-Tools are not bundled. Android Studio and Java are not
required to use the plugin. Windows may need the phone manufacturer's
[USB driver](https://developer.android.com/studio/run/oem-usb).

## Install the plugin

The Awesome Copilot marketplace listing is not available yet. A prebuilt plugin
is checked into this repository; from a checkout, run this in PowerShell:

```powershell
copilot plugin install (Resolve-Path .\plugins\mobile-use).Path
```

No npm install or build is needed to use that package. Install the
`plugins\mobile-use` folder, not the repository root. Confirm the plugin and its
tools appear in Copilot before using a phone.
For local development builds and updating the installed copy, see the
[build instructions](CONTRIBUTING.md#build-and-check-the-plugin).

## Connect your device

Ask Copilot: **"Help me set up mobile-use."** It checks requirements and guides
you through the next missing step.

1. Extract Platform-Tools so ADB is at
   `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`, or add its folder to PATH.
   For a custom location, you can also set `MOBILE_USE_ADB_PATH` to the full
   `adb.exe` path. Reopen Copilot after environment changes.
2. For USB, enable [Developer options and USB debugging](https://developer.android.com/studio/debug/dev-options),
   connect a data-capable cable, unlock the phone, and authorize your trusted
   computer on the phone.
3. For wireless, enable **Wireless debugging** and follow
   [Android's pairing instructions](https://developer.android.com/tools/adb#connect-to-a-device-over-wi-fi)
   in your own terminal. Only modern paired wireless is supported.
4. Ask Copilot to list devices and choose the exact USB or wireless endpoint.

You perform settings changes, debugging authorization, and pairing yourself.
Enter passwords and pairing codes only on the phone or in the local ADB prompt,
never in chat. Copilot asks before starting a missing local ADB server.

## Use with Copilot

Name the selected device and the non-sensitive task you want performed:

> On the selected USB phone, describe the current screen.

> Read the current UI without taking screenshots.

> In this demo app, tap the visible search field and append `sample-01`.
> Do not submit it.

> List installed app package names on the selected phone.

Copilot checks the screen before input and verifies the result. Some custom or
protected screens may not support observation or input. Double-tap and Unicode
text entry require separate approval to upload and run a bundled helper.
Text entry appends without submitting.

### Screen recording

Start a recording, check its status, and stop/save a silent MP4 to a new local
Windows path you approve. Other phone tools remain usable while recording.

Choose a duration, or omit the time limit to request unlimited recording where
supported. Copilot checks the phone's limits first; Android 11-13 typically
allows only 1-180 seconds. Timed recordings still need **stop** to save, and
existing files are never overwritten. See the
[recording guide](CONTRIBUTING.md#screen-recording) for details and Android
compatibility.

## Safety and privacy

Use approved, non-sensitive content and respect Copilot's permission prompts.
Installation and debugging trust are **not** permission to control a phone.
Do not use this POC to submit messages or forms, make purchases, change settings
or accounts, grant permissions, or enter credentials. Authenticate manually;
never expose authentication screens or bypass device policy.

Screenshots, UI text, and app metadata may be processed by Copilot's configured
model service. Screenshot-free observation still exposes UI text. Saving
evidence requires approval of its content and destination.

App installation and uninstallation need specific approval; uninstalling
deletes app data, and force-stopping may lose unsaved work. Recording needs its
own approval for the device, content, duration, and save location. Keep the
phone unlocked and away from sensitive content during capture.

Unlimited recording can fill storage. After a disconnect or plugin exit,
verify capture stopped on the phone; unsaved recordings may remain there.
Use one controller per phone and reselect the device after disconnection.
Exiting the plugin does not stop the shared ADB server or revoke debugging trust.

The checked-in plugin supports real Android devices, not emulators or cloud
devices. The iOS adapter remains experimental and is not an accepted capability.
There is no audio recording, streaming, or general-purpose file transfer.

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
