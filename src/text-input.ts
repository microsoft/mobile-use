import { prepareHelper, verifyHelper } from "./device-helper.js";
import type { DeviceCommand, DeviceHelper } from "./device-helper.js";
import { MobileUseError } from "./errors.js";
import { textHelperBase64, textHelperSha256 } from "./text-helper-data.js";
import type { ForegroundApp, PreparedTextInput, ScreenElement } from "./types.js";

export function isAdbText(text: string): boolean {
  return text.length > 0 && !/[^A-Za-z0-9 .,_-]/.test(text);
}

export function validateText(text: string): void {
  const valid = text.length >= 1 && text.length <= 256 && [...text].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return !(code >= 0xd800 && code <= 0xdfff) &&
      (code >= 0x20 || code === 9 || code === 10 || code === 13) &&
      !(code >= 0x7f && code <= 0x9f) && code !== 0xfffe && code !== 0xffff;
  });
  if (!valid) {
    throw new MobileUseError(
      "UNSUPPORTED_TEXT", "Text must contain 1-256 UTF-16 code units of well-formed Unicode text.",
      "Use valid Unicode, including emoji and combining characters. Tabs and line breaks are supported; other control characters and unpaired surrogates are not.",
    );
  }
}

function helperError(actionMayHaveRun = false): MobileUseError {
  return new MobileUseError(
    "TEXT_HELPER_UNAVAILABLE", "The approved text helper is missing, changed, or incompatible with this Android build.",
    "Stop input and revoke this helper's session consent. Ask for fresh approval before mobile_input_text with action.kind prepare. Never fall back to clipboard, keyboard changes, or replay uncertain input.",
    false, actionMayHaveRun,
  );
}

const helper: DeviceHelper = {
  name: "text", fileName: "text.dex", mainClass: "dev.mobileuse.text.TextMain",
  base64: textHelperBase64, sha256: textHelperSha256,
  ready: "MOBILE_USE_TEXT_V1_READY", unavailable: helperError,
};

export function prepareTextInput(command: DeviceCommand, signal?: AbortSignal): Promise<PreparedTextInput> {
  return prepareHelper(command, helper, signal);
}

export async function unicodeHierarchy(command: DeviceCommand, remotePath: string, rotation: number, signal?: AbortSignal): Promise<Buffer> {
  if (!Number.isInteger(rotation) || rotation < 0 || rotation > 3) {
    throw new MobileUseError("DISPLAY_STATE_UNAVAILABLE", "Cannot read Unicode hierarchy without verified rotation.", "Observe again with verified primary-display state.");
  }
  await verifyHelper(command, helper, remotePath, signal);
  const output = await command([
    "shell", `CLASSPATH=${remotePath}`, "app_process", "/", helper.mainClass, "--dump", String(rotation),
  ], signal ? { signal } : {});
  const phase = helperFailurePhase(output.toString("utf8"));
  if (phase) {
    throw new MobileUseError("HIERARCHY_UNAVAILABLE", `The Unicode hierarchy helper failed during ${phase}.`,
      "Stop input and report this stage without including UI content. No input was sent; do not fall back to a lossy hierarchy.");
  }
  return output;
}

function helperFailurePhase(response: string): string | undefined {
  const failure = /^MOBILE_USE_TEXT_V1_ERROR_(REQUEST|CONNECT|CONFIGURE|ROOT|WINDOW|HIERARCHY|TARGET|WRITE|VERIFY|DISCONNECT)(?:_(MISSING|DISPLAY|TYPE|ACTIVE|FOCUS|REGISTRATION|READ|LIMIT|PREFIX|HASH|OWNER|ENDING|NONE|USER|AMBIGUOUS|CHANGED))?\r?\n?$/.exec(response);
  return failure ? failure[1] + (failure[2] ? `_${failure[2]}` : "") : undefined;
}

export async function appendUnicodeText(
  command: DeviceCommand, remotePath: string | undefined, text: string,
  field: ScreenElement, foreground: ForegroundApp, signal?: AbortSignal,
): Promise<void> {
  validateText(text);
  if (!remotePath) {
    throw new MobileUseError(
      "TEXT_HELPER_NOT_PREPARED", "Unicode and extended punctuation input require explicit preparation of the bundled text helper.",
      "Obtain explicit approval or use matching scoped session consent to upload and run the text helper, then call mobile_input_text with action.kind prepare and observe again.",
    );
  }
  if (!field.textHash || !/^[0-9a-f]{64}$/.test(field.textHash)) {
    throw new MobileUseError("ELEMENT_CHANGED", "Unicode input requires the exact text fingerprint from a prepared-helper observation.", "Observe the approved text field again. No input was sent.");
  }
  const observedWindowIdentity = field.windowIdentity;
  const windowIdentity = /^([0-9a-f]{1,8}):u(0|[1-9]\d*)$/.exec(observedWindowIdentity ?? "");
  if (!observedWindowIdentity || !windowIdentity || Number(windowIdentity[2]) !== foreground.userId) {
    throw new MobileUseError("ELEMENT_CHANGED", "Unicode input requires the original observed window identity.", "Observe the approved text field again. No input was sent.");
  }
  const numbers = [4, foreground.userId, field.bounds.x, field.bounds.y, field.bounds.width, field.bounds.height];
  if (!numbers.every((number) => Number.isInteger(number) && number >= 0 && number <= 0x7fffffff)) {
    throw new MobileUseError("INVALID_INPUT", "The text target has invalid user or bounds metadata.", "Observe a native text field on the primary display again.");
  }
  const header = Buffer.alloc(numbers.length * 4);
  numbers.forEach((number, index) => header.writeInt32BE(number, index * 4));
  const parts = [header];
  for (const value of [observedWindowIdentity, foreground.packageName, field.className, field.resourceId ?? "", field.textHash, text]) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(4);
    length.writeInt32BE(bytes.length);
    parts.push(length, bytes);
  }
  const payload = Buffer.concat(parts).toString("base64");
  if (payload.length > 32768) throw new MobileUseError("INVALID_INPUT", "The text target exceeds the helper's payload limit.", "Use a shorter, observable native text field.");
  await verifyHelper(command, helper, remotePath, signal);
  // Only base64 crosses the device shell; text and field metadata are never shell syntax.
  const response = (await command([
    "shell", `CLASSPATH=${remotePath}`, "app_process", "/", helper.mainClass, payload,
  ], { mutating: true, ...(signal ? { signal } : {}) })).toString("utf8").trim();
  if (response === "MOBILE_USE_TEXT_V1_OK") return;
  const changed = /^MOBILE_USE_TEXT_V1_ELEMENT_CHANGED(?:_(USER|WINDOW_MISSING|WINDOW_DISPLAY|WINDOW_TYPE|WINDOW_ACTIVE|WINDOW_ID|ROOT_PACKAGE|FIELD_VISIBLE|FIELD_EDITABLE|FIELD_FOCUS|FIELD_ENABLED|FIELD_PASSWORD|FIELD_PACKAGE|FIELD_CLASS|FIELD_ID|FIELD_BOUNDS|FIELD_AMBIGUOUS|FIELD_MISSING|FIELD_REFRESH|FIELD_TEXT|FIELD_WINDOW))?$/.exec(response);
  if (changed) {
    throw new MobileUseError("ELEMENT_CHANGED", changed[1]
      ? `The Unicode text target failed its ${changed[1]} check before input.`
      : "The focused text field, app, or Android user changed before text input.", "Observe and focus the approved non-password field again. No text was written.");
  }
  if (response === "MOBILE_USE_TEXT_V1_UNSUPPORTED") {
    throw new MobileUseError("TEXT_INPUT_UNSUPPORTED", "The field does not support bounded text-setting, or its resulting text plus exposed label/hint exceeds 4096 UTF-16 code units.", "Use an editable native field that exposes ACTION_SET_TEXT. No clipboard or keyboard fallback was attempted.");
  }
  const phase = helperFailurePhase(response);
  const actionMayHaveRun = !["REQUEST", "CONNECT", "CONFIGURE", "ROOT", "WINDOW", "HIERARCHY", "TARGET"].includes(phase?.split("_")[0] ?? "");
  throw new MobileUseError(
    "TEXT_INPUT_FAILED", phase
      ? `The Unicode text helper failed during ${phase}.`
      : "Android did not confirm the requested text in the original focused field.",
    actionMayHaveRun
      ? "Observe the field before continuing. Text may have changed; never automatically retry or fall back to another input method."
      : "Observe the approved field again. No text was written; never automatically retry or fall back to another input method.",
    false, actionMayHaveRun,
  );
}
