import { XMLParser, XMLValidator } from "fast-xml-parser";
import { isRecord, MobileUseError } from "../errors.js";
import type { Rect, ScreenElement } from "../types.js";
import type { WdaElement } from "./wda.js";

const pointerTypes = new Set([
  "XCUIElementTypeButton", "XCUIElementTypeLink", "XCUIElementTypeCell",
  "XCUIElementTypeSwitch", "XCUIElementTypeTextField", "XCUIElementTypeSearchField", "XCUIElementTypeTextView",
]);
const editorTypes = new Set(["XCUIElementTypeTextField", "XCUIElementTypeSearchField", "XCUIElementTypeTextView"]);
const scrollTypes = new Set(["XCUIElementTypeScrollView", "XCUIElementTypeTable", "XCUIElementTypeCollectionView"]);

export interface IosNode {
  element: Omit<ScreenElement, "ref">;
  name: string;
  path: string;
  window: string | null;
}

function invalid(): never {
  throw new MobileUseError("HIERARCHY_UNAVAILABLE", "The WDA hierarchy is malformed or exceeds the observation limits.",
    "Stop input. Use an observable, non-sensitive native screen; do not fall back to raw commands.");
}

export function pixels(rect: Rect, scale: number): Rect {
  const x = Math.round(rect.x * scale);
  const y = Math.round(rect.y * scale);
  return { x, y, width: Math.round((rect.x + rect.width) * scale) - x,
    height: Math.round((rect.y + rect.height) * scale) - y };
}

export function parseIosHierarchy(xml: string, scale: number, appId: string,
  display: { width: number; height: number }): { nodes: IosNode[]; protectedContentOmitted: boolean } {
  if (Buffer.byteLength(xml) > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml) ||
    XMLValidator.validate(xml) !== true) invalid();
  const tree: unknown = new XMLParser({
    preserveOrder: true, ignoreDeclaration: true, ignoreAttributes: false,
    attributeNamePrefix: "", parseAttributeValue: false, parseTagValue: false,
    trimValues: false, htmlEntities: true,
  }).parse(xml);
  if (!Array.isArray(tree) || tree.length !== 1 || !isRecord(tree[0])) invalid();
  const root = tree[0];
  const roots = Array.isArray(root.AppiumAUT) ? root.AppiumAUT : [root];
  if (roots.length !== 1 || !isRecord(roots[0]) || !Array.isArray(roots[0].XCUIElementTypeApplication)) invalid();
  const pending = [{ value: roots[0], path: "0", depth: 0, window: null as string | null }];
  const nodes: IosNode[] = [];
  let visited = 0;
  let bytes = 0;
  let protectedContentOmitted = false;
  const attribute = (attrs: Record<string, unknown>, name: string): string => {
    const value = attrs[name];
    if (value === undefined) return "";
    if (typeof value !== "string" || value.length > 4096) invalid();
    return value;
  };
  const flag = (attrs: Record<string, unknown>, name: string): boolean | null => {
    const value = attribute(attrs, name);
    if (!value) return null;
    if (value !== "true" && value !== "false") invalid();
    return value === "true";
  };
  while (pending.length) {
    const frame = pending.pop();
    if (!frame || !isRecord(frame.value) || ++visited > 2000 || frame.depth > 64) invalid();
    const keys = Object.keys(frame.value).filter((key) => key !== ":@");
    const type = keys.length === 1 ? keys[0] : undefined;
    if (!type || !/^XCUIElementType[A-Za-z]+$/.test(type) ||
      (type === "XCUIElementTypeApplication" && frame.depth !== 0)) invalid();
    const children: unknown = frame.value[type];
    const attrs: unknown = frame.value[":@"];
    if (!Array.isArray(children) || !isRecord(attrs)) invalid();
    if (type === "XCUIElementTypeSecureTextField") { protectedContentOmitted = true; continue; }
    const coordinates = ["x", "y", "width", "height"].map((key) => {
      const value = attribute(attrs, key);
      if (!/^-?\d+(?:\.\d+)?$/.test(value) || Math.abs(Number(value)) > 32768) invalid();
      return Number(value);
    });
    const [x = 0, y = 0, width = 0, height = 0] = coordinates;
    if (width < 0 || height < 0) invalid();
    const bounds = pixels({ x, y, width, height }, scale);
    const name = attribute(attrs, "name");
    const label = attribute(attrs, "label");
    const value = attribute(attrs, "value");
    const enabled = flag(attrs, "enabled");
    const visible = flag(attrs, "visible");
    const window = type === "XCUIElementTypeWindow" ? JSON.stringify([name, bounds]) : frame.window;
    if (visible === true && bounds.x >= 0 && bounds.y >= 0 && bounds.width > 0 && bounds.height > 0 &&
      bounds.x + bounds.width <= display.width && bounds.y + bounds.height <= display.height &&
      (name || label || value || pointerTypes.has(type) || scrollTypes.has(type))) {
      const element: Omit<ScreenElement, "ref"> = {
        bounds, className: type, label, text: value || (editorTypes.has(type) ? "" : label),
        resourceId: name || null, packageName: appId,
        editable: editorTypes.has(type), enabled, focused: null, password: false,
        clickable: pointerTypes.has(type), scrollable: scrollTypes.has(type),
      };
      bytes += Buffer.byteLength(JSON.stringify(element));
      if (nodes.length >= 500 || bytes > 512 * 1024) invalid();
      nodes.push({ element, name, path: frame.path, window });
    }
    for (let index = children.length - 1; index >= 0; index--) {
      pending.push({ value: children[index], path: `${frame.path}.${index}`, depth: frame.depth + 1, window });
    }
  }
  return { nodes, protectedContentOmitted };
}

export function matchesWdaElement(node: IosNode, live: WdaElement, scale: number): boolean {
  return node.element.className === live.type && node.name === live.name &&
    node.element.label === live.label && node.element.text === (live.value || (node.element.editable ? "" : live.label)) &&
    node.element.enabled === live.enabled && live.visible &&
    JSON.stringify(node.element.bounds) === JSON.stringify(pixels(live.rect, scale));
}

export function nodeSignature(node: IosNode): string {
  return JSON.stringify([node.element, node.name, node.path, node.window]);
}
