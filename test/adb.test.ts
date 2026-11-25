import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { AdbClient, adbEnvironment, AdbTrackParser, createTransportMonitor, executeCommand, parseDeviceList, resolveAdbExecutable } from "../src/adb.js";
import type { AdbFileSystem, CommandOptions, TransportMonitor } from "../src/adb.js";
import { LocalAdbServer } from "../src/adb-server.js";
import { MobileUseError } from "../src/errors.js";
import type { DeviceEndpoint } from "../src/types.js";
import { hasCode, INVENTORY, USB_LINE } from "./helpers.js";

test("inventory preserves complete states and never hides unsupported endpoints", () => {
  const devices = parseDeviceList(INVENTORY + "LOCKED unauthorized transport_id:19\nOFF offline transport_id:20\nemulator-5554 device transport_id:21\nOLD device\n");
  assert.deepEqual(devices.map((device) => device.kind), ["usb", "network", "usb", "usb", "emulator", "usb"]);
  assert.equal(devices[0]?.transportId, "7");
  assert.equal(devices[0]?.model, "POC Phone");
  assert.ok(devices.slice(2).every((device) => !device.selectable));
  assert.deepEqual(parseDeviceList("List of devices attached\r\n\r\n"), []);
  for (const malformed of [
    "", "* daemon failed to start *", "List of devices attached\nonly-a-serial\n",
    INVENTORY + USB_LINE, "List of devices attached\nA device transport_id:7\nB device transport_id:7\n",
  ]) assert.throws(() => parseDeviceList(malformed), hasCode("INVALID_DEVICE_LIST"));
});

test("only ADB's final transport field determines routing, not product/device metadata", () => {
  const devices = parseDeviceList("List of devices attached\nPOC_PHONE device usb:1-2 product:transport_id:0 device:transport_id:81 model:POC_Phone transport_id:7\n");
  assert.equal(devices[0]?.transportId, "7");
  assert.equal(devices[0]?.model, "POC Phone");
  assert.equal(devices[0]?.selectable, true);
  const metadataOnly = parseDeviceList("List of devices attached\nPOC_PHONE device product:transport_id:7\n");
  assert.equal(metadataOnly[0]?.transportId, null);
  assert.equal(metadataOnly[0]?.selectable, false);
  const noSerial = parseDeviceList("List of devices attached\n(no serial number) device transport_id:7\n");
  assert.equal(noSerial[0]?.endpointId, "(no serial number)");
  assert.equal(noSerial[0]?.state, "device");
  assert.equal(noSerial[0]?.selectable, false);
  assert.equal(parseDeviceList("List of devices attached\n(no serial number)\tdevice\ttransport_id:7\n")[0]?.endpointId, "(no serial number)");
  const permissions = parseDeviceList("List of devices attached\nLOCKED no permissions usb:1-3 transport_id:8\n");
  assert.equal(permissions[0]?.state, "no permissions");
  assert.equal(permissions[0]?.selectable, false);
});

test("transport IDs must be canonical nonzero uint64 values; zero must never mean implicit selection", () => {
  for (const invalid of ["0", "00", "007", "-1", "1other", "18446744073709551616"]) {
    assert.throws(() => parseDeviceList(`List of devices attached\nPOC_PHONE device transport_id:${invalid}\n`), hasCode("INVALID_DEVICE_LIST"));
  }
  assert.equal(parseDeviceList("List of devices attached\nPOC_PHONE device transport_id:18446744073709551615\n")[0]?.transportId, "18446744073709551615");
});

test("ADB track framing handles bytewise packets, multiple frames, and an empty inventory", () => {
  const parser = new AdbTrackParser();
  const body = `${USB_LINE}\n`;
  const wire = Buffer.from(`OKAY${Buffer.byteLength(body).toString(16).padStart(4, "0")}${body}0000`);
  const frames = [];
  for (const byte of wire) frames.push(...parser.push(Buffer.from([byte])));
  assert.equal(frames.length, 2);
  assert.equal(frames[0]?.[0]?.transportId, "7");
  assert.deepEqual(frames[1], []);
});

test("ADB track framing rejects protocol failure, malformed sizes, and unbounded data", () => {
  assert.throws(() => new AdbTrackParser().push(Buffer.from("FAIL0000")), hasCode("ADB_SERVER_UNAVAILABLE"));
  assert.throws(() => new AdbTrackParser().push(Buffer.from("OKAYzzzz")), hasCode("INVALID_DEVICE_LIST"));
  assert.throws(() => new AdbTrackParser().push(Buffer.alloc(1024 * 1024 + 1)), hasCode("INVALID_DEVICE_LIST"));
});

test("inventory limits reject excessive output rather than silently dropping devices", () => {
  for (const output of [
    " ".repeat(512 * 1024 + 1),
    `List of devices attached\n${"A".repeat(513)} device transport_id:1\n`,
    `List of devices attached\n${Array.from({ length: 257 }, (_value, index) => `PHONE_${index} device transport_id:${index + 1}`).join("\n")}`,
  ]) assert.throws(() => parseDeviceList(output), hasCode("INVALID_DEVICE_LIST"));
});

async function executableFixture(t: TestContext) {
  const base = path.resolve(".test-artifacts");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, "adb lookup "));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const binaryName = process.platform === "win32" ? "adb.exe" : "adb";
  const sdk = path.join(directory, "Android SDK");
  const tools = path.join(sdk, "platform-tools");
  await mkdir(tools, { recursive: true });
  const executable = path.join(tools, binaryName);
  await writeFile(executable, "not executable; lookup fixture only", { mode: 0o755 });
  if (process.platform !== "win32") await chmod(executable, 0o755);
  return { directory, sdk, tools, executable, binaryName };
}

function studioSdkXml(sdkPath: string, optionName = "androidSdkAbsolutePath"): string {
  const escaped = sdkPath.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;");
  return `<application>\n  <component name="AndroidSdkPathStore">\n    <option name="${optionName}" value="${escaped}" />\n  </component>\n</application>\n`;
}

function virtualWindowsFs(entries: {
  files?: Record<string, string>;
  directories?: readonly string[];
}): AdbFileSystem {
  const winKey = (targetPath: string): string => {
    const normalized = path.win32.normalize(targetPath).toLowerCase();
    return /^[a-z]:\\$/.test(normalized) ? normalized : normalized.replace(/\\+$/, "");
  };
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const children = new Map<string, Map<string, string>>();
  const addDirectory = (directoryPath: string): void => {
    let current = path.win32.normalize(directoryPath);
    if (!/^[A-Za-z]:\\$/.test(current)) current = current.replace(/\\+$/, "");
    while (current) {
      directories.add(winKey(current));
      const parent = path.win32.dirname(current);
      if (parent === current) break;
      const base = path.win32.basename(current);
      const parentKey = winKey(parent);
      let map = children.get(parentKey);
      if (!map) {
        map = new Map<string, string>();
        children.set(parentKey, map);
      }
      if (!map.has(base.toLowerCase())) map.set(base.toLowerCase(), base);
      current = parent;
    }
  };
  for (const directoryPath of entries.directories ?? []) addDirectory(directoryPath);
  for (const [filePath, content] of Object.entries(entries.files ?? {})) {
    files.set(winKey(filePath), content);
    addDirectory(path.win32.dirname(filePath));
  }
  return {
    exists: (targetPath) => files.has(winKey(targetPath)) || directories.has(winKey(targetPath)),
    isFile: (targetPath) => files.has(winKey(targetPath)),
    isExecutable: (targetPath) => files.has(winKey(targetPath)),
    listDirectories: (directoryPath) => [...(children.get(winKey(directoryPath))?.values() ?? [])],
    readTextFile: (filePath, maxBytes) => {
      const content = files.get(winKey(filePath));
      if (content === undefined || content.length < 1 || Buffer.byteLength(content) > maxBytes) return undefined;
      return content;
    },
  };
}

function virtualPosixFs(entries: {
  files?: Record<string, string>;
  nonExecutableFiles?: Record<string, string>;
  directories?: Record<string, readonly string[]>;
  brokenEntries?: readonly string[];
}): AdbFileSystem {
  const executableFiles = new Map(Object.entries(entries.files ?? {}));
  const nonExecutable = new Map(Object.entries(entries.nonExecutableFiles ?? {}));
  const directories = new Map(Object.entries(entries.directories ?? {}));
  const broken = new Set(entries.brokenEntries ?? []);
  return {
    exists: (targetPath) =>
      executableFiles.has(targetPath) || nonExecutable.has(targetPath) ||
      broken.has(targetPath) || directories.has(targetPath),
    isFile: (targetPath) => executableFiles.has(targetPath) || nonExecutable.has(targetPath),
    isExecutable: (targetPath) => executableFiles.has(targetPath),
    listDirectories: (directoryPath) => [...(directories.get(directoryPath) ?? [])],
    readTextFile: (filePath, maxBytes) => {
      const content = executableFiles.get(filePath) ?? nonExecutable.get(filePath);
      if (content === undefined || content.length < 1 || Buffer.byteLength(content) > maxBytes) return undefined;
      return content;
    },
  };
}

test("Windows executable lookup respects explicit, SDK, and quoted PATH entries without cwd fallback", () => {
  const directory = "C:\\Users\\alice\\fixture";
  const sdk = "C:\\Users\\alice\\fixture\\Android SDK";
  const tools = "C:\\Users\\alice\\fixture\\Android SDK\\platform-tools";
  const executable = "C:\\Users\\alice\\fixture\\Android SDK\\platform-tools\\adb.exe";
  const fs = virtualWindowsFs({ files: { [executable]: "pe" } });
  assert.equal(resolveAdbExecutable({ MOBILE_USE_ADB_PATH: executable }, "win32", fs), executable);
  assert.equal(resolveAdbExecutable({ ANDROID_HOME: sdk }, "win32", fs), executable);
  assert.equal(resolveAdbExecutable({ ANDROID_SDK_ROOT: sdk }, "win32", fs), executable);
  assert.equal(resolveAdbExecutable({ LOCALAPPDATA: directory, ANDROID_HOME: sdk }, "win32", fs), executable);
  assert.equal(resolveAdbExecutable({ PATH: `"${tools}"` }, "win32", fs), executable);
  assert.throws(() => resolveAdbExecutable({ MOBILE_USE_ADB_PATH: ".\\adb.exe" }, "win32", fs), hasCode("ADB_CONFIG_UNSUPPORTED"));
  assert.throws(() => resolveAdbExecutable({ MOBILE_USE_ADB_PATH: "\\platform-tools\\adb.exe" }, "win32", fs), hasCode("ADB_CONFIG_UNSUPPORTED"));
  assert.throws(() => resolveAdbExecutable({ MOBILE_USE_ADB_PATH: "/platform-tools/adb.exe" }, "win32", fs), hasCode("ADB_CONFIG_UNSUPPORTED"));
  assert.throws(() => resolveAdbExecutable({ MOBILE_USE_ADB_PATH: `${directory}\\adb.cmd` }, "win32", fs), hasCode("ADB_CONFIG_UNSUPPORTED"));
  assert.throws(() => resolveAdbExecutable({ MOBILE_USE_ADB_PATH: `${directory}\\missing.exe` }, "win32", fs), hasCode("ADB_NOT_FOUND"));
  assert.throws(() => resolveAdbExecutable({ PATH: "." }, "win32", fs), hasCode("ADB_NOT_FOUND"));
  assert.throws(() => resolveAdbExecutable({ ANDROID_HOME: ".", ANDROID_SDK_ROOT: "." }, "win32", fs), hasCode("ADB_NOT_FOUND"));
  const driveRelativeFs = virtualWindowsFs({ files: { "\\sdk\\platform-tools\\adb.exe": "pe" } });
  assert.throws(() => resolveAdbExecutable({
    ANDROID_SDK_ROOT: "\\sdk", ANDROID_HOME: "/sdk", LOCALAPPDATA: "\\local", PATH: "\\sdk\\platform-tools",
  }, "win32", driveRelativeFs), hasCode("ADB_NOT_FOUND"));
  for (const unsupported of ["freebsd", "openbsd", "sunos", "aix"] as const) {
    assert.throws(() => resolveAdbExecutable({}, unsupported, fs), hasCode("UNSUPPORTED_HOST"));
  }
});

test("Windows Android Studio custom SDK discovery respects tier priority and handles stale, malformed, and ambiguous configs", () => {
  const root = "C:\\Users\\alice\\workspace";
  const makeSdk = (name: string) => {
    const sdk = `${root}\\${name}`;
    const tools = `${sdk}\\platform-tools`;
    const adb = `${tools}\\adb.exe`;
    return { sdk, tools, adb };
  };
  const explicitSdk = makeSdk("explicit-sdk");
  const sdkRoot = makeSdk("sdk-root");
  const androidHome = makeSdk("android-home");
  const studioCustom = makeSdk("studio & custom");
  const studioOther = makeSdk("studio-other");
  const defaultLocalAppData = `${root}\\LocalAppData`;
  const defaultAdb = `${defaultLocalAppData}\\Android\\Sdk\\platform-tools\\adb.exe`;
  const pathSdk = makeSdk("path-sdk");
  const appData = `${root}\\RoamingAppData`;
  const profileHome = "C:\\Users\\bob";
  const homeCustomAdb = `${profileHome}\\Custom\\Sdk\\platform-tools\\adb.exe`;

  const baseFiles: Record<string, string> = {
    [explicitSdk.adb]: "pe",
    [sdkRoot.adb]: "pe",
    [androidHome.adb]: "pe",
    [studioCustom.adb]: "pe",
    [studioOther.adb]: "pe",
    [defaultAdb]: "pe",
    [pathSdk.adb]: "pe",
    [homeCustomAdb]: "pe",
    ["C:\\Users\\outside-sdk\\platform-tools\\adb.exe"]: "pe",
    ["\\sdk\\platform-tools\\adb.exe"]: "pe",
    [`${profileHome}\\AppData\\Roaming\\Google\\AndroidStudio2025.2\\options\\android.sdk.path.xml`]:
      studioSdkXml("$USER_HOME$/Custom/Sdk"),
  };
  const fsWithStudio = (profiles: Record<string, string>, extraDirs: readonly string[] = []) => {
    const files = { ...baseFiles };
    for (const [profile, xml] of Object.entries(profiles)) {
      files[`${appData}\\Google\\${profile}\\options\\android.sdk.path.xml`] = xml;
    }
    return virtualWindowsFs({ files, directories: extraDirs });
  };

  const singleProfileFs = fsWithStudio({
    "AndroidStudio2025.1": studioSdkXml(studioCustom.sdk.replaceAll("\\", "/")),
  });
  const fullEnv: NodeJS.ProcessEnv = {
    MOBILE_USE_ADB_PATH: explicitSdk.adb,
    ANDROID_SDK_ROOT: sdkRoot.sdk,
    ANDROID_HOME: androidHome.sdk,
    APPDATA: appData,
    LOCALAPPDATA: defaultLocalAppData,
    PATH: pathSdk.tools,
  };
  // Explicit and environment SDK tiers resolve before scanning Android Studio profiles.
  const noStudioScanFs: AdbFileSystem = {
    ...singleProfileFs,
    listDirectories: () => assert.fail("Android Studio config directories must not be scanned when an earlier tier resolves"),
    readTextFile: () => assert.fail("Android Studio XML must not be read when an earlier tier resolves"),
  };
  assert.equal(resolveAdbExecutable(fullEnv, "win32", noStudioScanFs), explicitSdk.adb);
  const { MOBILE_USE_ADB_PATH: _1, ...withoutExplicit } = fullEnv;
  assert.equal(resolveAdbExecutable(withoutExplicit, "win32", noStudioScanFs), sdkRoot.adb);
  const { ANDROID_SDK_ROOT: _2, ...withoutSdkRoot } = withoutExplicit;
  assert.equal(resolveAdbExecutable(withoutSdkRoot, "win32", noStudioScanFs), androidHome.adb);
  const { ANDROID_HOME: _3, ...withoutEnvSdks } = withoutSdkRoot;
  assert.equal(resolveAdbExecutable(withoutEnvSdks, "win32", singleProfileFs), studioCustom.adb);

  // Agreeing profiles (including case/slash/trailing-separator differences and unset profiles) remain unambiguous.
  const agreeingFs = fsWithStudio({
    "AndroidStudio2025.1": studioSdkXml(`${studioCustom.sdk.replaceAll("\\", "/")}/`),
    "AndroidStudio2024.3": studioSdkXml(studioCustom.sdk.toUpperCase()),
    "AndroidStudio2024.2": studioSdkXml(`${studioCustom.sdk}\\`),
    "AndroidStudio2024.1": "<application>\n  <component name=\"AndroidSdkPathStore\" />\n</application>\n",
  }, [`${appData}\\Google\\AndroidStudio2023.3`]);
  assert.equal(resolveAdbExecutable(withoutEnvSdks, "win32", agreeingFs), studioCustom.adb);

  // $USER_HOME$ macro expansion works via USERPROFILE when APPDATA is omitted.
  assert.equal(resolveAdbExecutable({ USERPROFILE: profileHome }, "win32", agreeingFs), homeCustomAdb);

  // Conflicting SDK paths across AndroidStudio* profiles never guess; fall through to default SDK and PATH.
  const conflictingFs = fsWithStudio({
    "AndroidStudio2025.1": studioSdkXml(studioCustom.sdk),
    "AndroidStudio2025.2": studioSdkXml(studioOther.sdk),
  });
  assert.equal(resolveAdbExecutable(withoutEnvSdks, "win32", conflictingFs), defaultAdb);
  assert.throws(() => resolveAdbExecutable({ APPDATA: appData }, "win32", conflictingFs), hasCode("ADB_NOT_FOUND"));

  // Stale, drive-relative, macro-traversal, and malformed Android Studio configs fall through cleanly without crashing.
  for (const invalidXml of [
    studioSdkXml(`${root}\\removed-sdk`),
    "<application><broken",
    `<!DOCTYPE application [<!ENTITY x "y">]>${studioSdkXml(studioCustom.sdk)}`,
    studioSdkXml("relative\\sdk"),
    studioSdkXml("\\sdk"),
    studioSdkXml("/sdk"),
    studioSdkXml("$PROJECT_DIR$/sdk"),
    studioSdkXml("$USER_HOME$/../outside-sdk"),
    studioSdkXml("$USER_HOME$\\..\\outside-sdk"),
    studioSdkXml("$USER_HOME$/./Custom/Sdk"),
    studioSdkXml(`${studioCustom.sdk}\\..\\studio-other`),
  ]) {
    const invalidFs = fsWithStudio({ "AndroidStudio2025.1": invalidXml });
    assert.equal(resolveAdbExecutable({
      APPDATA: appData, USERPROFILE: "C:\\Users\\alice", LOCALAPPDATA: defaultLocalAppData,
    }, "win32", invalidFs), defaultAdb);
    assert.equal(resolveAdbExecutable({
      APPDATA: appData, USERPROFILE: "C:\\Users\\alice", PATH: pathSdk.tools,
    }, "win32", invalidFs), pathSdk.adb);
    assert.throws(() => resolveAdbExecutable({
      APPDATA: appData, USERPROFILE: "C:\\Users\\alice",
    }, "win32", invalidFs), hasCode("ADB_NOT_FOUND"));
  }
});

test("macOS and Linux executable lookup resolves explicit, env SDK, Android Studio XML, default SDK, and colon PATH while requiring X_OK", () => {
  const macHome = "/Users/alice";
  const macGoogle = `${macHome}/Library/Application Support/Google`;
  const macXml = `${macGoogle}/AndroidStudio2025.1/options/android.sdk.path.xml`;
  const macCustomAdb = "/Volumes/Dev/Android/sdk/platform-tools/adb";
  const macDefaultAdb = `${macHome}/Library/Android/sdk/platform-tools/adb`;
  const macPathAdb = "/opt/homebrew/bin/adb";
  const macExplicitAdb = "/usr/local/android/adb";
  const macEnvAdb = "/Users/alice/env-sdk/platform-tools/adb";
  const macFs = virtualPosixFs({
    directories: { [macGoogle]: ["AndroidStudio2025.1"] },
    files: {
      [macXml]: studioSdkXml("/Volumes/Dev/Android/sdk"),
      [macCustomAdb]: "elf",
      [macDefaultAdb]: "elf",
      [macPathAdb]: "elf",
      [macExplicitAdb]: "elf",
      [macEnvAdb]: "elf",
    },
  });

  assert.equal(resolveAdbExecutable({
    MOBILE_USE_ADB_PATH: macExplicitAdb, ANDROID_SDK_ROOT: "/Users/alice/env-sdk", HOME: macHome, PATH: "/usr/bin:/opt/homebrew/bin",
  }, "darwin", macFs), macExplicitAdb);
  assert.equal(resolveAdbExecutable({
    ANDROID_SDK_ROOT: "/Users/alice/env-sdk", HOME: macHome, PATH: "/usr/bin:/opt/homebrew/bin",
  }, "darwin", macFs), macEnvAdb);
  assert.equal(resolveAdbExecutable({ HOME: macHome, PATH: "/usr/bin:/opt/homebrew/bin" }, "darwin", macFs), macCustomAdb);

  const macNoCustomFs = virtualPosixFs({ files: { [macDefaultAdb]: "elf", [macPathAdb]: "elf" } });
  assert.equal(resolveAdbExecutable({ HOME: macHome, PATH: "/usr/bin:/opt/homebrew/bin" }, "darwin", macNoCustomFs), macDefaultAdb);
  assert.equal(resolveAdbExecutable({ PATH: `"/usr/bin":"/opt/homebrew/bin"` }, "darwin", macNoCustomFs), macPathAdb);

  // Non-executable (e.g. 0644) SDK adb candidates are skipped rather than masking a working PATH executable,
  // and an explicit MOBILE_USE_ADB_PATH override pointing to a non-executable binary fails with ADB_CONFIG_UNSUPPORTED.
  const macNonExecSdkFs = virtualPosixFs({
    directories: { [macGoogle]: ["AndroidStudio2025.1"] },
    files: {
      [macXml]: studioSdkXml("/Volumes/Dev/Android/sdk"),
      [macPathAdb]: "elf",
    },
    nonExecutableFiles: {
      [macEnvAdb]: "0644-elf",
      [macCustomAdb]: "0644-elf",
      [macDefaultAdb]: "0644-elf",
    },
  });
  assert.equal(resolveAdbExecutable({
    ANDROID_SDK_ROOT: "/Users/alice/env-sdk", HOME: macHome, PATH: "/usr/bin:/opt/homebrew/bin",
  }, "darwin", macNonExecSdkFs), macPathAdb);
  assert.throws(() => resolveAdbExecutable({
    ANDROID_SDK_ROOT: "/Users/alice/env-sdk", HOME: macHome,
  }, "darwin", macNonExecSdkFs), hasCode("ADB_NOT_FOUND"));
  assert.throws(() => resolveAdbExecutable({
    MOBILE_USE_ADB_PATH: macDefaultAdb,
  }, "darwin", macNonExecSdkFs), hasCode("ADB_CONFIG_UNSUPPORTED"));

  for (const badOverride of ["./adb", "adb", "C:\\Android\\Sdk\\platform-tools\\adb.exe", "/opt/adb.sh", "/opt/adb/", "/"]) {
    assert.throws(() => resolveAdbExecutable({ MOBILE_USE_ADB_PATH: badOverride }, "darwin", macFs), hasCode("ADB_CONFIG_UNSUPPORTED"));
  }
  assert.throws(() => resolveAdbExecutable({ MOBILE_USE_ADB_PATH: "/opt/missing-adb" }, "darwin", macFs), hasCode("ADB_NOT_FOUND"));

  const linuxHome = "/home/alice";
  const linuxGoogle = `${linuxHome}/.config/Google`;
  const linuxXmlOne = `${linuxGoogle}/AndroidStudio2024.3/options/android.sdk.path.xml`;
  const linuxXmlTwo = `${linuxGoogle}/AndroidStudio2025.1/options/android.sdk.path.xml`;
  const linuxCustomAdb = `${linuxHome}/CustomSdk/platform-tools/adb`;
  const linuxDefaultAdb = `${linuxHome}/Android/Sdk/platform-tools/adb`;
  const linuxPathAdb = "/usr/bin/adb";

  const linuxUnambiguousFs = virtualPosixFs({
    directories: { [linuxGoogle]: ["AndroidStudio2024.3", "AndroidStudio2025.1"] },
    files: {
      [linuxXmlOne]: studioSdkXml("$USER_HOME$/CustomSdk/"),
      [linuxXmlTwo]: studioSdkXml("$USER_HOME$/CustomSdk"),
      [linuxCustomAdb]: "elf",
      [linuxDefaultAdb]: "elf",
    },
  });
  assert.equal(resolveAdbExecutable({ HOME: linuxHome }, "linux", linuxUnambiguousFs), linuxCustomAdb);

  // Agreeing /opt/android-sdk and /opt/android-sdk/ profiles canonicalize to the same SDK, and root "/" is preserved.
  const linuxTrailingSlashFs = virtualPosixFs({
    directories: { [linuxGoogle]: ["AndroidStudio2024.3", "AndroidStudio2025.1"] },
    files: {
      [linuxXmlOne]: studioSdkXml("/opt/android-sdk"),
      [linuxXmlTwo]: studioSdkXml("/opt/android-sdk/"),
      "/opt/android-sdk/platform-tools/adb": "elf",
    },
  });
  assert.equal(resolveAdbExecutable({ HOME: linuxHome }, "linux", linuxTrailingSlashFs), "/opt/android-sdk/platform-tools/adb");

  const linuxRootSdkFs = virtualPosixFs({
    directories: { [linuxGoogle]: ["AndroidStudio2025.1"] },
    files: {
      [linuxXmlTwo]: studioSdkXml("/"),
      "/platform-tools/adb": "elf",
    },
  });
  assert.equal(resolveAdbExecutable({ HOME: linuxHome }, "linux", linuxRootSdkFs), "/platform-tools/adb");

  // $USER_HOME$ macro traversal is rejected before path joining, even if the traversed SDK path exists.
  const linuxMacroTraversalFs = virtualPosixFs({
    directories: { [linuxGoogle]: ["AndroidStudio2025.1"] },
    files: {
      [linuxXmlTwo]: studioSdkXml("$USER_HOME$/../outside-sdk"),
      "/home/outside-sdk/platform-tools/adb": "elf",
      [linuxPathAdb]: "elf",
    },
  });
  assert.throws(() => resolveAdbExecutable({ HOME: linuxHome }, "linux", linuxMacroTraversalFs), hasCode("ADB_NOT_FOUND"));
  assert.equal(resolveAdbExecutable({ HOME: linuxHome, PATH: "/usr/bin" }, "linux", linuxMacroTraversalFs), linuxPathAdb);

  // Environment SDKs short-circuit before scanning Android Studio directories on POSIX too.
  const linuxNoStudioScanFs: AdbFileSystem = {
    ...linuxTrailingSlashFs,
    listDirectories: () => assert.fail("POSIX Studio directories must not be scanned when ANDROID_SDK_ROOT/ANDROID_HOME resolves"),
    readTextFile: () => assert.fail("POSIX Studio XML must not be read when ANDROID_SDK_ROOT/ANDROID_HOME resolves"),
  };
  assert.equal(resolveAdbExecutable({
    ANDROID_SDK_ROOT: "/opt/android-sdk", HOME: linuxHome,
  }, "linux", linuxNoStudioScanFs), "/opt/android-sdk/platform-tools/adb");
  assert.equal(resolveAdbExecutable({
    ANDROID_HOME: "/opt/android-sdk", HOME: linuxHome,
  }, "linux", linuxNoStudioScanFs), "/opt/android-sdk/platform-tools/adb");

  const linuxNonExecFs = virtualPosixFs({
    files: { [linuxPathAdb]: "elf" },
    nonExecutableFiles: { [linuxDefaultAdb]: "0644-elf" },
  });
  assert.equal(resolveAdbExecutable({ HOME: linuxHome, PATH: "/bin:/usr/bin" }, "linux", linuxNonExecFs), linuxPathAdb);
  assert.throws(() => resolveAdbExecutable({ MOBILE_USE_ADB_PATH: linuxDefaultAdb }, "linux", linuxNonExecFs), hasCode("ADB_CONFIG_UNSUPPORTED"));

  const linuxAmbiguousFs = virtualPosixFs({
    directories: { [linuxGoogle]: ["AndroidStudio2024.3", "AndroidStudio2025.1"] },
    files: {
      [linuxXmlOne]: studioSdkXml("/opt/sdk-one"),
      [linuxXmlTwo]: studioSdkXml("/opt/sdk-two"),
      "/opt/sdk-one/platform-tools/adb": "elf",
      "/opt/sdk-two/platform-tools/adb": "elf",
      [linuxPathAdb]: "elf",
    },
  });
  assert.equal(resolveAdbExecutable({ HOME: linuxHome, PATH: "/bin:/usr/bin" }, "linux", linuxAmbiguousFs), linuxPathAdb);
  assert.throws(() => resolveAdbExecutable({ HOME: linuxHome }, "linux", linuxAmbiguousFs), hasCode("ADB_NOT_FOUND"));
});

test("adbEnvironment preserves required Windows and POSIX host variables without leaking secrets or ADB overrides", () => {
  const sanitized = adbEnvironment({
    PATH: "/usr/bin:/bin",
    HOME: "/home/alice",
    USER: "alice",
    LOGNAME: "alice",
    TMPDIR: "/tmp/user-1000",
    XDG_CONFIG_HOME: "/home/alice/.config",
    XDG_CACHE_HOME: "/home/alice/.cache",
    XDG_RUNTIME_DIR: "/run/user/1000",
    LANG: "en_US.UTF-8",
    SystemRoot: "C:\\Windows",
    USERPROFILE: "C:\\Users\\alice",
    PRIVATE_TEST_SECRET: "secret",
    ANDROID_SERIAL: "ABC123",
    ADB_SERVER_SOCKET: "tcp:127.0.0.1:5037",
    ADB_VENDOR_KEYS: "/tmp/private-key",
    MOBILE_USE_ADB_PATH: "/usr/bin/adb",
  });
  assert.equal(sanitized.PATH, "/usr/bin:/bin");
  assert.equal(sanitized.HOME, "/home/alice");
  assert.equal(sanitized.USER, "alice");
  assert.equal(sanitized.LOGNAME, "alice");
  assert.equal(sanitized.TMPDIR, "/tmp/user-1000");
  assert.equal(sanitized.XDG_CONFIG_HOME, "/home/alice/.config");
  assert.equal(sanitized.XDG_CACHE_HOME, "/home/alice/.cache");
  assert.equal(sanitized.XDG_RUNTIME_DIR, "/run/user/1000");
  assert.equal(sanitized.LANG, "en_US.UTF-8");
  assert.equal(sanitized.PRIVATE_TEST_SECRET, undefined);
  assert.equal(sanitized.ANDROID_SERIAL, undefined);
  assert.equal(sanitized.ADB_SERVER_SOCKET, undefined);
  assert.equal(sanitized.ADB_VENDOR_KEYS, undefined);
  assert.equal(sanitized.MOBILE_USE_ADB_PATH, undefined);
});

test("Windows SDK lookup supports per-user defaults and skips non-executable directories", () => {
  const userProfile = "C:\\Users\\alice";
  const local = "C:\\Users\\alice\\AppData\\Local";
  const tools = "C:\\Users\\alice\\AppData\\Local\\Android\\Sdk\\platform-tools";
  const executable = "C:\\Users\\alice\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe";
  const unavailableSdk = "C:\\Users\\alice\\directory-not-an-executable";
  const fs = virtualWindowsFs({
    files: { [executable]: "pe" },
    directories: [`${unavailableSdk}\\platform-tools\\adb.exe`],
  });
  assert.equal(resolveAdbExecutable({ LOCALAPPDATA: local }, "win32", fs), executable);
  assert.equal(resolveAdbExecutable({ USERPROFILE: userProfile }, "win32", fs), executable);
  assert.equal(resolveAdbExecutable({ ANDROID_HOME: unavailableSdk, PATH: tools }, "win32", fs), executable);
});

test("host filesystem lookup verifies real files, Android Studio XML, directory guards, and POSIX execute permissions", async (t) => {
  const { directory, sdk, tools, executable, binaryName } = await executableFixture(t);
  assert.equal(resolveAdbExecutable({ MOBILE_USE_ADB_PATH: executable }), executable);
  assert.equal(resolveAdbExecutable({ ANDROID_SDK_ROOT: sdk }), executable);
  assert.equal(resolveAdbExecutable({ PATH: `"${tools}"` }), executable);

  const unavailableSdk = path.join(directory, "directory-not-an-executable");
  await mkdir(path.join(unavailableSdk, "platform-tools", binaryName), { recursive: true });
  assert.equal(resolveAdbExecutable({ ANDROID_HOME: unavailableSdk, PATH: tools }), executable);

  const studioHome = path.join(directory, "studio-home");
  const studioOptions = process.platform === "win32"
    ? path.join(studioHome, "AppData", "Roaming", "Google", "AndroidStudio2025.1", "options")
    : process.platform === "darwin"
      ? path.join(studioHome, "Library", "Application Support", "Google", "AndroidStudio2025.1", "options")
      : path.join(studioHome, ".config", "Google", "AndroidStudio2025.1", "options");
  await mkdir(studioOptions, { recursive: true });
  await writeFile(path.join(studioOptions, "android.sdk.path.xml"), studioSdkXml(sdk));
  const studioEnv: NodeJS.ProcessEnv = process.platform === "win32"
    ? { USERPROFILE: studioHome }
    : { HOME: studioHome };
  assert.equal(resolveAdbExecutable(studioEnv), executable);

  if (process.platform !== "win32") {
    const nonExecSdk = path.join(directory, "non-exec-sdk");
    const nonExecTools = path.join(nonExecSdk, "platform-tools");
    await mkdir(nonExecTools, { recursive: true });
    const nonExecAdb = path.join(nonExecTools, "adb");
    await writeFile(nonExecAdb, "non-executable fixture", { mode: 0o644 });
    await chmod(nonExecAdb, 0o644);
    assert.equal(resolveAdbExecutable({ ANDROID_SDK_ROOT: nonExecSdk, PATH: tools }), executable);
    assert.throws(() => resolveAdbExecutable({ MOBILE_USE_ADB_PATH: nonExecAdb }), hasCode("ADB_CONFIG_UNSUPPORTED"));
  }
});

test("ADB commands pin the local server and exclude unrelated credentials and implicit targets", async (t) => {
  const { executable } = await executableFixture(t);
  let routed: readonly string[] = [];
  let environment: NodeJS.ProcessEnv = {};
  let request: CommandOptions | undefined;
  const client = new AdbClient({
    MOBILE_USE_ADB_PATH: executable, PATH: process.env.PATH ?? "",
    USERPROFILE: process.env.USERPROFILE ?? "", PRIVATE_TEST_SECRET: "do not forward", ANDROID_SERIAL: "unselected",
  }, async (exe, args, options) => {
    assert.equal(exe, executable);
    routed = args;
    environment = options.env;
    request = options;
    return Buffer.from([0, 255, 13, 10]);
  }, process.platform);
  assert.deepEqual(await client.run(["-t", "7", "exec-out", "screencap", "-p"]), Buffer.from([0, 255, 13, 10]));
  assert.deepEqual(routed, ["-H", "127.0.0.1", "-P", "5037", "-t", "7", "exec-out", "screencap", "-p"]);
  assert.equal(environment.PRIVATE_TEST_SECRET, undefined);
  assert.equal(environment.ANDROID_SERIAL, undefined);
  assert.equal(environment.MOBILE_USE_ADB_PATH, undefined);
  assert.ok(request?.signal);
  client.stop();
  assert.equal(request.signal.aborted, true);
  await assert.rejects(client.run(["devices", "-l"]), hasCode("SERVER_STOPPED"));
});

test("remote or non-default ADB server overrides fail before starting a command", async (t) => {
  const { executable } = await executableFixture(t);
  for (const extra of [
    { ADB_SERVER_SOCKET: "tcp:remote.example:5037" },
    { ANDROID_ADB_SERVER_ADDRESS: "192.0.2.20" },
    { ANDROID_ADB_SERVER_PORT: "5038" },
  ]) {
    const client = new AdbClient({ MOBILE_USE_ADB_PATH: executable, ...extra }, async () => {
      assert.fail("unsupported configuration must not run adb");
    }, process.platform);
    await assert.rejects(client.run(["devices", "-l"]), hasCode("ADB_CONFIG_UNSUPPORTED"));
    await assert.rejects(client.startServer(), hasCode("ADB_CONFIG_UNSUPPORTED"));
    client.stop();
  }
});

test("bounded process execution is binary-safe and sanitizes failures", async () => {
  const env = { ...process.env };
  const bytes = await executeCommand(process.execPath, ["-e", "process.stdout.write(Buffer.from([0,255,13,10]))"], { env });
  assert.deepEqual(bytes, Buffer.from([0, 255, 13, 10]));
  await assert.rejects(executeCommand(process.execPath, ["-e", "process.stderr.write('private fixture text');process.exit(1)"], { env }), (error: unknown) => {
    hasCode("ADB_FAILED")(error);
    assert.ok(error instanceof MobileUseError);
    assert.doesNotMatch(JSON.stringify(error), /private fixture text/);
    return true;
  });
  await assert.rejects(executeCommand(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(17*1024*1024))"], { env }), hasCode("ADB_OUTPUT_LIMIT"));
});

test("an explicit zero process timeout allows recording commands beyond the default fifteen seconds", { timeout: 25_000 }, async () => {
  const result = await executeCommand(process.execPath, ["-e", "setTimeout(() => process.stdout.write('completed'), 16000)"], {
    env: { ...process.env }, timeoutMs: 0,
  });
  assert.equal(result.toString("utf8"), "completed");
});

test("app rejection diagnostics preserve operation-specific errors without leaking details or implying transport loss", async () => {
  for (const [diagnostic, code] of [
    ["Failure [INSTALL_FAILED_INVALID_APK: private file not found]", "APP_INSTALL_FAILED"],
    ["Failure [DELETE_FAILED_INTERNAL_ERROR: private package not found]", "APP_UNINSTALL_FAILED"],
    ["Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package com.example.offline signatures do not match]", "APP_INSTALL_FAILED"],
    ["adb: failed to install C:\\private\\unauthorized.apk: Failure [INSTALL_FAILED_INVALID_APK]", "APP_INSTALL_FAILED"],
    ["Failure [DELETE_FAILED_INTERNAL_ERROR: Package com.example.offline could not be removed]", "APP_UNINSTALL_FAILED"],
    ["Failure [DELETE_FAILED_OWNER_BLOCKED: Package com.example.unauthorized is protected]", "APP_UNINSTALL_FAILED"],
  ] as const) {
    for (const stream of ["stdout", "stderr"]) {
      await assert.rejects(executeCommand(process.execPath, ["-e", `process.${stream}.write(${JSON.stringify(diagnostic)});process.exit(1)`], {
        env: { ...process.env }, mutating: true,
      }), (error: unknown) => {
        hasCode(code)(error);
        assert.ok(error instanceof MobileUseError && error.actionMayHaveRun && !error.retryable);
        assert.doesNotMatch(JSON.stringify(error), /private|not found|com\.example|unauthorized\.apk/);
        return true;
      });
    }
  }
});

test("failed text-helper processes report only allowlisted diagnostics and never accept a success marker on nonzero exit", async () => {
  for (const [output, diagnostic, marker, exception] of [
    ["MOBILE_USE_TEXT_V1_OK\n", "java.lang.IllegalStateException: private UI content", "OK", "IllegalStateException"],
    ["MOBILE_USE_TEXT_V1_ERROR_ROOT\n", "java.lang.IllegalStateException: private root details", "ERROR_ROOT", "IllegalStateException"],
    ["MOBILE_USE_TEXT_V1_ERROR_VERIFY\n", "java.lang.NoSuchMethodError: private method details", "ERROR_VERIFY", "NoSuchMethodError"],
    ["MOBILE_USE_TEXT_V1_private-output\n", "private UI content", "missing", "unavailable"],
  ]) {
    await assert.rejects(executeCommand(process.execPath, [
      "-e", `process.stdout.write(${JSON.stringify(output)});process.stderr.write(${JSON.stringify(diagnostic)});process.exit(1)`,
      "--", "dev.mobileuse.text.TextMain",
    ], { env: { ...process.env }, mutating: true }), (error: unknown) => {
      hasCode("ADB_FAILED")(error);
      assert.ok(error instanceof MobileUseError);
      assert.equal(error.message, `The text helper process failed (exit 1; result ${marker}; exception ${exception}).`);
      assert.ok(error.actionMayHaveRun && !error.retryable);
      assert.doesNotMatch(JSON.stringify(error), /private|UI content|method details/);
      return true;
    });
  }
});

test("actual offline and unauthorized device diagnostics retain their transport error codes", async () => {
  for (const [diagnostic, code] of [
    ["error: device offline", "DEVICE_OFFLINE"],
    ["error: device unauthorized", "DEVICE_UNAUTHORIZED"],
  ] as const) {
    for (const stream of ["stdout", "stderr"]) {
      await assert.rejects(executeCommand(process.execPath, ["-e", `process.${stream}.write(${JSON.stringify(diagnostic)});process.exit(1)`], {
        env: { ...process.env }, mutating: true,
      }), (error: unknown) => {
        hasCode(code)(error);
        assert.ok(error instanceof MobileUseError && error.actionMayHaveRun && !error.retryable);
        return true;
      });
    }
  }
});

test("process execution honors an operation-specific deadline and preserves uncertain delivery", async () => {
  await assert.rejects(executeCommand(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
    env: { ...process.env }, timeoutMs: 200, mutating: true,
  }), (error: unknown) => {
    hasCode("ADB_TIMEOUT")(error);
    assert.ok(error instanceof MobileUseError && error.actionMayHaveRun && !error.retryable);
    return true;
  });
});

test("a missing local ADB server is not misreported as a lost phone transport", async () => {
  for (const details of [
    "adb.exe: cannot connect to daemon at tcp:127.0.0.1:5037: cannot connect to 127.0.0.1:5037: No connection could be made (10061)",
    "* failed to start daemon *",
    "adb: failed to check server version: cannot connect to server",
    "ADB server didn't ACK",
  ]) {
    await assert.rejects(executeCommand(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(details)});process.exit(1)`], {
      env: { ...process.env },
    }), (error: unknown) => {
      hasCode("ADB_SERVER_UNAVAILABLE")(error);
      assert.ok(error instanceof MobileUseError);
      assert.match(error.remediation, /Use mobile_start_adb_server/);
      assert.doesNotMatch(error.remediation, /\b(?:ask|approval|permission)\b/i);
      assert.equal(error.actionMayHaveRun, false);
      assert.equal(error.retryable, true);
      assert.doesNotMatch(JSON.stringify(error), /10061|didn't ACK/);
      return true;
    });
  }
  await assert.rejects(executeCommand(process.execPath, ["-e", "process.stderr.write('cannot connect to 192.0.2.1:37001: connection refused');process.exit(1)"], {
    env: { ...process.env }, mutating: true,
  }), (error: unknown) => {
    hasCode("TRANSPORT_LOST")(error);
    assert.ok(error instanceof MobileUseError);
    assert.equal(error.actionMayHaveRun, true);
    assert.equal(error.retryable, false);
    return true;
  });
});

test("local startup pins the executable, sanitizes the daemon environment, and parses raw inventory", async (t) => {
  const { executable } = await executableFixture(t);
  const server = new LocalAdbServer();
  let startupCalls = 0;
  let startupSignal: AbortSignal | undefined;
  server.ensureRunning = async (exe, env, version, signal) => {
    startupCalls++;
    startupSignal = signal;
    assert.equal(exe, executable);
    assert.equal(version, 41);
    assert.equal(env.PRIVATE_TEST_SECRET, undefined);
    assert.equal(env.ANDROID_SERIAL, undefined);
    assert.equal(env.ADB_SERVER_SOCKET, undefined);
    assert.equal(env.ADB_VENDOR_KEYS, undefined);
    return { startupAttempted: true, inventory: Buffer.from(`${USB_LINE}\n`) };
  };
  const calls: string[][] = [];
  const client = new AdbClient({
    MOBILE_USE_ADB_PATH: executable, PRIVATE_TEST_SECRET: "do not forward", ANDROID_SERIAL: "unselected",
    ADB_VENDOR_KEYS: "private fixture key path",
  }, async (_exe, args) => {
    calls.push([...args]);
    return Buffer.from("Android Debug Bridge version 1.0.41\nVersion 36.0.0-12345\n");
  }, process.platform, server);
  t.after(() => client.stop());
  const result = await client.startServer();
  assert.equal(result.status, "ready");
  assert.equal(result.serverAddress, "127.0.0.1:5037");
  assert.equal(result.startupAttempted, true);
  assert.equal(result.devices[0]?.endpointId, "POC_PHONE");
  assert.equal(startupCalls, 1);
  assert.deepEqual(calls, [["-H", "127.0.0.1", "-P", "5037", "version"]], "no ADB client discovery/start-server/kill-server");
  assert.ok(startupSignal);
  client.stop();
  assert.equal(startupSignal.aborted, true);
  await assert.rejects(client.startServer(), hasCode("SERVER_STOPPED"));
  assert.equal(startupCalls, 1);
});

test("ordinary inventory uses read-only protocol discovery and never launches an ADB client", async (t) => {
  const { executable } = await executableFixture(t);
  const server = new LocalAdbServer();
  let queries = 0;
  server.inventory = async (signal) => {
    assert.ok(signal);
    queries++;
    return Buffer.from(`${USB_LINE}\n`);
  };
  const client = new AdbClient({ MOBILE_USE_ADB_PATH: executable }, async () =>
    assert.fail("inventory must not invoke a client with automatic daemon startup/replacement"), process.platform, server);
  t.after(() => client.stop());
  assert.equal((await client.run(["devices", "-l"])).toString(), `List of devices attached\n${USB_LINE}\n`);
  assert.equal(queries, 1);
});

test("malformed post-start inventory is an error with startup uncertainty, not an empty list", async (t) => {
  const { executable } = await executableFixture(t);
  const server = new LocalAdbServer();
  server.ensureRunning = async () => ({ startupAttempted: true, inventory: Buffer.from("malformed\n") });
  const client = new AdbClient({ MOBILE_USE_ADB_PATH: executable }, async () =>
    Buffer.from("Android Debug Bridge version 1.0.41\nVersion 36.0.0\n"), process.platform, server);
  t.after(() => client.stop());
  await assert.rejects(client.startServer(), (error: unknown) => {
    hasCode("INVALID_DEVICE_LIST")(error);
    assert.ok(error instanceof MobileUseError);
    assert.equal(error.actionMayHaveRun, true);
    assert.equal(error.retryable, false);
    return true;
  });
});

test("cancelling a spawned mutating command reports uncertainty and stops that child only", async () => {
  const controller = new AbortController();
  const pending = executeCommand(process.execPath, ["-e", "setTimeout(()=>{},30000)"], {
    env: { ...process.env }, signal: controller.signal, mutating: true,
  });
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(pending, (error: unknown) => {
      hasCode("CANCELLED")(error);
      assert.ok(error instanceof MobileUseError);
      assert.equal(error.actionMayHaveRun, true);
      assert.equal(error.retryable, false);
      return true;
    });
  } finally {
    clearTimeout(timer);
  }
});

test("the command deadline is enforced rather than leaving an owned subprocess alive", { timeout: 20_000 }, async () => {
  await assert.rejects(executeCommand(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { env: { ...process.env } }), hasCode("ADB_TIMEOUT"));
});

async function monitorFixture(t: TestContext, answer = true) {
  let peer: Socket | undefined;
  let monitor: TransportMonitor | undefined;
  let request = "";
  const server = createServer();
  const connected = new Promise<void>((resolve) => {
    server.once("connection", (socket) => {
      peer = socket;
      socket.on("data", (data: Buffer) => {
        request += data.toString("ascii");
        if (answer && request.length === 24) {
          const body = `${USB_LINE}\n`;
          socket.write("OK");
          socket.write(`AY${Buffer.byteLength(body).toString(16).padStart(4, "0")}${body}`);
        }
      });
      resolve();
    });
  });
  t.after(async () => {
    monitor?.close();
    peer?.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const factory = createTransportMonitor(() => createConnection({ host: "127.0.0.1", port: address.port }));
  return {
    factory, connected,
    get peer() { assert.ok(peer); return peer; },
    get request() { return request; },
    own(value: TransportMonitor) { monitor = value; return value; },
  };
}

test("the tracking socket uses the exact service and reports server closure after readiness", async (t) => {
  const fixture = await monitorFixture(t);
  let notifyLost: (() => void) | undefined;
  const lost = new Promise<void>((resolve) => { notifyLost = resolve; });
  const frames: DeviceEndpoint[][] = [];
  const monitor = fixture.own(await fixture.factory((inventory) => frames.push(inventory), () => notifyLost?.(), new AbortController().signal));
  assert.equal(fixture.request, "0014host:track-devices-l");
  assert.equal(monitor.initial[0]?.transportId, "7");
  fixture.peer.write("0000");
  fixture.peer.end();
  await lost;
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[1], []);
});

test("cancelling pending monitoring rejects immediately without a lingering readiness deadline", async (t) => {
  const fixture = await monitorFixture(t, false);
  const controller = new AbortController();
  const pending = fixture.factory(() => assert.fail("no inventory expected"), () => assert.fail("not yet ready"), controller.signal);
  await fixture.connected;
  controller.abort();
  await assert.rejects(pending, hasCode("CANCELLED"));
});

test("intentional tracking close does not masquerade as transport loss", async (t) => {
  const fixture = await monitorFixture(t);
  let lost = 0;
  const monitor = fixture.own(await fixture.factory(() => {}, () => { lost++; }, new AbortController().signal));
  monitor.close();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lost, 0);
});
