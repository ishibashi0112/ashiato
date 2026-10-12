import { CHANGE_EVENT, DIALOG_EVENT, KEY_EVENT, RESNAPSHOT_EVENT } from "../client/events.js";
import { Dom, isElement, type DomNode } from "./dom.js";
import { locatorFor, type Locator } from "./locator.js";

/** rrweb event types and sources. */
const DOM_CONTENT_LOADED = 0;
const LOAD = 1;
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const META = 4;
const CUSTOM = 5;
const MUTATION = 0;
const MOUSE = 2;
const INPUT = 5;
const CLICK = 2;
const DBL_CLICK = 4;

export interface ReplayEvent {
  type: number;
  timestamp: number;
  data?: unknown;
}

export interface Dialog {
  type: "alert" | "confirm" | "prompt";
  message: string;
  /** confirm: true / false; prompt: the text, or null when cancelled. */
  answer?: boolean | string | null;
}

/** One thing the user did on a page, as a test would do it. */
export interface Interaction {
  t: number;
  tab: string;
  kind: "goto" | "click" | "dblclick" | "fill" | "select" | "check" | "uncheck" | "press";
  /** How a test finds the element. */
  locator?: Locator;
  /** Why the element can't be found by a test. */
  unsupported?: string;
  /** Text filled in, option selected, key pressed, or URL. */
  value?: string;
  /** The value was masked when recorded (passwords, `maskAllInputs`). */
  masked?: boolean;
  /** goto: the page went there by itself, right after an action (a link, a redirect after saving). */
  followed?: boolean;
  /** fill: then leave the field, as the user did (a page that saves on `change`). */
  blur?: boolean;
  /** Dialogs the action opened, with the user's answers. */
  dialogs?: Dialog[];
  node?: number;
}

/** A page load right after an action was caused by it. */
const FOLLOW_MS = 5000;
/** A change event and the value it is about are this close together. */
const PICKED_MS = 1000;
/** Enter on a form's field or a button clicks its button this soon after. */
const KEY_CLICK_MS = 100;
const TEXT_TYPES = new Set(["", "text", "email", "password", "search", "tel", "url", "number", "date", "time", "datetime-local", "month", "week", "color"]);

/** What the user did in each tab of a screen replay, in order. */
export function interactionsOf(tabs: Map<string, ReplayEvent[]>): Interaction[] {
  const all: Interaction[] = [];
  for (const [tab, events] of tabs) all.push(...tabInteractions(tab, events));
  return all.sort((a, b) => a.t - b.t);
}

function tabInteractions(tab: string, events: ReplayEvent[]): Interaction[] {
  const out: Interaction[] = [];
  const dom = new Dom();
  let loading = false;
  /** The next full snapshot is of the same page, taken again. */
  let again = false;
  let href: string | undefined;
  let url: string | undefined;
  /** Values set by a script, kept in case a change event says a test tool or component picked them. */
  const programmatic = new Map<number, { t: number; data: Record<string, unknown> }>();
  /** Change events that came before the value they are about (the page's listener runs before rrweb's). */
  const changed = new Map<number, number>();
  /** The text in each field, as filled in or set by the page. */
  const texts = new Map<number, string>();
  /** Values an Enter press put in: rrweb records them from the change event right after it. */
  const committed = new Map<number, string>();

  const at = (target: DomNode | undefined): Pick<Interaction, "locator" | "unsupported" | "node"> => {
    const node = target && !target.tag ? target.parent : target;
    if (!node || !isElement(node)) return { unsupported: "the element is not in the screen replay" };
    const found = locatorFor(dom, node);
    return "unsupported" in found ? { unsupported: found.unsupported, node: node.id } : { locator: found, node: node.id };
  };
  const lastAction = () => [...out].reverse().find((i) => i.kind !== "goto");

  for (const e of events) {
    const data = (e.data ?? {}) as Record<string, unknown>;
    if (e.type === DOM_CONTENT_LOADED || e.type === LOAD) loading = true;
    else if (e.type === META && typeof data.href === "string") href = data.href;
    else if (e.type === FULL_SNAPSHOT) {
      dom.reset(data.node as never);
      programmatic.clear();
      changed.clear();
      texts.clear();
      committed.clear();
      // a page load, not a snapshot taken again of the same page (marked so since it was recorded,
      // else told by its URL: a single-page app that moved on then reads as a page load)
      if (href && (loading || url === undefined || (href !== url && !again))) {
        const before = lastAction();
        const followed = url !== undefined && before !== undefined && e.timestamp - before.t < FOLLOW_MS;
        out.push({ t: e.timestamp, tab, kind: "goto", value: href, ...(followed ? { followed } : {}) });
      }
      if (href) url = href;
      loading = false;
      again = false;
    } else if (e.type === INCREMENTAL && data.source === MUTATION) dom.mutate(data as never);
    else if (e.type === INCREMENTAL && data.source === MOUSE && data.type === CLICK) click(e.timestamp, dom.get(data.id as number), data);
    else if (e.type === INCREMENTAL && data.source === MOUSE && data.type === DBL_CLICK) dblclick(e.timestamp, data.id as number);
    else if (e.type === INCREMENTAL && data.source === INPUT) input(e.timestamp, dom.get(data.id as number), data);
    else if (e.type === CUSTOM) custom(e.timestamp, data.tag, (data.payload ?? {}) as Record<string, unknown>);
  }
  return out;

  function click(t: number, node: DomNode | undefined, data: Record<string, unknown>) {
    // the click Enter makes on a form's button (or on the button it was pressed on): pressing it again does that
    const last = out.at(-1);
    if (data.x === 0 && data.y === 0 && last?.kind === "press" && t - last.t <= KEY_CLICK_MS) return;
    if (node && isElement(node)) {
      const type = (node.attrs.get("type") ?? "").toLowerCase();
      // typing fills a field, and checking a box or picking an option comes as its own input event
      if (node.tag === "select" || node.tag === "option" || node.tag === "textarea") return;
      if (node.tag === "input" && (TEXT_TYPES.has(type) || type === "checkbox" || type === "radio")) return;
    }
    out.push({ t, tab, kind: "click", ...at(node) });
  }

  function dblclick(t: number, id: number) {
    // the browser sends click, click, dblclick: one double click
    const clicks = out.slice(-2).filter((i) => i.kind === "click" && i.node === id && t - i.t < 1000);
    if (clicks.length === 0) return;
    // at the second click: the action it made is stamped then
    out.splice(out.indexOf(clicks[0]!), clicks.length, { ...clicks[0]!, kind: "dblclick", t });
  }

  function input(t: number, node: DomNode | undefined, data: Record<string, unknown>) {
    if (!node || !isElement(node)) return;
    // set by the app, not typed: unless a change event says the value was picked
    const text = typeof data.text === "string" ? data.text : "";
    const typed = committed.get(node.id);
    committed.delete(node.id);
    if (typed === text) return;
    if (data.userTriggered === false) {
      const picked = changed.get(node.id);
      changed.delete(node.id);
      if (picked === undefined || t - picked > PICKED_MS) {
        texts.set(node.id, text);
        return void programmatic.set(node.id, { t, data });
      }
    }
    const type = (node.attrs.get("type") ?? "").toLowerCase();
    // rrweb masks passwords (also one a "show password" button made a text field) and, with maskAllInputs, every value
    const masked = type === "password" || node.attrs.has("data-rr-is-password") || (text.length > 0 && /^\*+$/.test(text));
    let item: Interaction;
    if (node.tag === "select") item = { t, tab, kind: "select", value: masked ? "" : text, ...(masked ? { masked } : {}), ...at(node) };
    else if (node.tag === "input" && (type === "checkbox" || type === "radio")) {
      // a radio button is unchecked by checking another one
      if (type === "radio" && !data.isChecked) return;
      item = { t, tab, kind: data.isChecked ? "check" : "uncheck", ...at(node) };
    } else if (node.tag === "textarea" || (node.tag === "input" && TEXT_TYPES.has(type))) {
      texts.set(node.id, text);
      const last = out.at(-1);
      // typing, then more typing in the same field: the same element, found as before
      if (last?.kind === "fill" && last.node === node.id && !last.unsupported) {
        const { value: _, masked: __, ...found } = last;
        return void out.splice(-1, 1, { ...found, t, value: masked ? "" : text, ...(masked ? { masked } : {}) });
      }
      item = { t, tab, kind: "fill", value: masked ? "" : text, ...(masked ? { masked } : {}), ...at(node) };
    } else if (node.tag === "input") {
      item = { t, tab, kind: "fill", value: text, ...at(node), unsupported: `an input of type ${type} can't be filled in` };
    } else return;
    const last = out.at(-1);
    if (item.kind === "fill" && last?.kind === "fill" && last.node === item.node) return void out.splice(-1, 1, item);
    out.push(item);
  }

  function custom(t: number, tag: unknown, payload: Record<string, unknown>) {
    if (tag === RESNAPSHOT_EVENT) again = true;
    else if (tag === CHANGE_EVENT) {
      const id = payload.id as number;
      const held = programmatic.get(id);
      programmatic.delete(id);
      if (held && t - held.t <= PICKED_MS) input(held.t, dom.get(id), { ...held.data, userTriggered: true });
      else changed.set(id, t);
    } else if (tag === KEY_EVENT && typeof payload.key === "string") {
      const node = dom.get(payload.id as number);
      // what was typed goes in before the key: rrweb records it from the change event the key makes
      if (node && typeof payload.value === "string") {
        if (payload.value !== (texts.get(node.id) ?? node.attrs.get("value") ?? "")) input(t, node, { text: payload.value, userTriggered: true });
        committed.set(node.id, payload.value);
      }
      out.push({ t, tab, kind: "press", value: payload.key, ...at(node) });
    } else if (tag === DIALOG_EVENT && typeof payload.type === "string") {
      // opened by the user's last action
      const by = lastAction();
      if (!by || t - by.t > 60_000) return;
      const answer = payload.answer as Dialog["answer"];
      (by.dialogs ??= []).push({ type: payload.type as Dialog["type"], message: String(payload.message ?? ""), ...(answer !== undefined ? { answer } : {}) });
    }
  }
}
