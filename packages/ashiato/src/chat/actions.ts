import type { Lang } from "../export/text.js";

/**
 * The actions of a step that `ashiato verify --auto` carries out with Playwright, written by the chat
 * under a line `操作:` (`Actions:`), one per line:
 *
 *   操作:
 *   - 開く: /orders/new
 *   - 選ぶ: 得意先 = C001
 *   - 入力: 数量 = 3
 *   - 押す: 登録
 *   - 確認: 「登録しました」が表示される
 *
 * Elements are named as the page's accessibility tree names them (`ashiato pack` shows it): a button or
 * link by its name, a field by its label. No CSS or XPath.
 */
export type ActionVerb = "open" | "fill" | "select" | "check" | "uncheck" | "click" | "press" | "wait" | "expect" | "dialog";

export interface StepAction {
  line: number;
  /** As written, without the bullet. */
  written: string;
  verb: ActionVerb;
  /**
   * open: the path or URL. fill, select, check, uncheck, expect (a field's value): the field's label.
   * click: the button's or link's name (or the text, with `byText`). press: the key.
   */
  target?: string;
  /** fill, select, expect (a field's value): the value. dialog: the text typed in a prompt. */
  value?: string;
  /** wait, expect: the text that is shown (or, with `hidden`, not shown). */
  shown?: string;
  hidden?: boolean;
  /** wait: how long. */
  ms?: number;
  /** dialog: OK (true) or Cancel (false). */
  accept?: boolean;
  /** click: the target is a text on the page, not a button or link (`押す: 文字「次へ」`). */
  byText?: boolean;
  /**
   * fill, select, check, uncheck, expect (a field's value): the target is a kind of element, not a
   * name (`入力: spinbutton = 3 (「P001」の行)`): the one element with one of these roles in the scope,
   * for elements without a name.
   */
  roles?: string[];
  /** The element is in a table row: the one showing this text, or the first or last row. Without a target (click), the row itself. */
  row?: RowScope;
}

export type RowScope = { text: string } | { at: "first" | "last" };

export interface ActionProblem {
  line: number;
  message: string;
}

const VERBS: Record<string, ActionVerb> = {
  開く: "open",
  ひらく: "open",
  表示する: "open",
  open: "open",
  goto: "open",
  入力: "fill",
  入力する: "fill",
  入れる: "fill",
  fill: "fill",
  type: "fill",
  選ぶ: "select",
  選択: "select",
  選択する: "select",
  select: "select",
  choose: "select",
  チェック: "check",
  チェックする: "check",
  チェックを入れる: "check",
  check: "check",
  チェックを外す: "uncheck",
  uncheck: "uncheck",
  押す: "click",
  クリック: "click",
  クリックする: "click",
  click: "click",
  キー: "press",
  キーを押す: "press",
  press: "press",
  key: "press",
  待つ: "wait",
  wait: "wait",
  確認: "expect",
  確認する: "expect",
  確かめる: "expect",
  expect: "expect",
  verify: "expect",
  ダイアログ: "dialog",
  dialog: "dialog",
};

const TEXT = {
  en: {
    verb: (word: string) =>
      `"${word}" is not an action: use open, fill, select, check, uncheck, click, press, wait, expect or dialog (開く / 入力 / 選ぶ / チェック / チェックを外す / 押す / キー / 待つ / 確認 / ダイアログ).`,
    shape: "Write each action as `verb: what`, e.g. `click: Save` or `fill: Quantity = 3`.",
    notBullet: "Write each action on a line of its own starting with `- `.",
    none: "Write the actions under `Actions:`, one per line starting with `- `.",
    open: "Write the page to open: `open: /orders/new` (a path of the app, or a URL).",
    pair: (verb: string) => `Write it as \`${verb}: label = value\` (the field's label as the page names it, then the value).`,
    name: "Write the name of what to act on, as the page names it.",
    wait: 'Write what to wait for: `wait: "Saved" is shown`, `wait: "Loading" is not shown` or `wait: 2 seconds`.',
    expect: 'Write what to check: `expect: "Saved" is shown`, `expect: "Error" is not shown` or `expect: Quantity = 3` (a field\'s value).',
    waitLong: "Wait at most 60 seconds.",
    key: "Write the key: `press: Enter` (Tab, Escape, ArrowDown, Control+A...).",
    dialog: "Write the answer to the next dialog: `dialog: OK`, `dialog: Cancel`, or the text to type in a prompt.",
    role: (word: string, verb: string, fits: string) => `${verb} can't act on a ${word}: use ${fits}.`,
  },
  ja: {
    verb: (word: string) => `「${word}」は操作の種類ではありません。開く・入力・選ぶ・チェック・チェックを外す・押す・キー・待つ・確認・ダイアログのどれかで書いてください。`,
    shape: "操作は「押す: 登録」「入力: 数量 = 3」のように「種類: 対象」の形で書いてください。",
    notBullet: "操作は 1 行に 1 つ、「- 」で始めて書いてください。",
    none: "「操作:」の下に、操作を 1 行に 1 つ、「- 」で始めて書いてください。",
    open: "開く画面を「開く: /orders/new」のように書いてください(アプリのパスか URL)。",
    pair: (verb: string) => `「${verb}: 欄の名前 = 値」の形で書いてください(欄の名前は画面のラベルのとおり)。`,
    name: "操作する対象の名前を、画面に出ているとおりに書いてください。",
    wait: "待つものを「待つ: 「登録しました」が表示される」「待つ: 「読み込み中」が表示されない」「待つ: 2 秒」のように書いてください。",
    expect: "確かめることを「確認: 「登録しました」が表示される」「確認: 「エラー」が表示されない」「確認: 数量 = 3」(入力欄の値)のように書いてください。",
    waitLong: "待つのは 60 秒までにしてください。",
    key: "押すキーを「キー: Enter」のように書いてください(Tab、Escape、ArrowDown、Control+A なども使えます)。",
    dialog: "次に出るダイアログへの答えを「ダイアログ: OK」「ダイアログ: キャンセル」、または prompt に入れる文字で書いてください。",
    role: (word: string, verb: string, fits: string) => `「${verb}」は ${word} には使えません。${fits} を書いてください。`,
  },
};

/**
 * Kinds of elements written in place of a name, for elements that have none: the roles of the
 * accessibility tree, and words for them. The element is then the one of that kind in the scope.
 */
const ROLE_WORDS: Record<string, string[]> = {
  textbox: ["textbox"],
  searchbox: ["searchbox"],
  spinbutton: ["spinbutton"],
  combobox: ["combobox"],
  listbox: ["listbox"],
  checkbox: ["checkbox"],
  radio: ["radio"],
  switch: ["switch"],
  入力欄: ["textbox", "searchbox", "spinbutton"],
  field: ["textbox", "searchbox", "spinbutton"],
  リストボックス: ["combobox", "listbox"],
  "list box": ["combobox", "listbox"],
  チェックボックス: ["checkbox"],
  "check box": ["checkbox"],
  ラジオボタン: ["radio"],
  "radio button": ["radio"],
};
/** The roles each verb can act on. */
const VERB_ROLES: Partial<Record<ActionVerb, string[]>> = {
  fill: ["textbox", "searchbox", "spinbutton", "combobox"],
  expect: ["textbox", "searchbox", "spinbutton", "combobox", "listbox"],
  select: ["combobox", "listbox"],
  check: ["checkbox", "radio", "switch"],
  uncheck: ["checkbox", "radio", "switch"],
};

/** `spinbutton` → the roles it stands for, when the verb can act on them; a message when it can't. */
function rolesOf(target: string, verb: ActionVerb, word: string, t: Text): string[] | string | undefined {
  const roles = ROLE_WORDS[target.toLowerCase().replace(/\s+/g, " ")];
  if (!roles) return undefined;
  const fits = VERB_ROLES[verb] ?? [];
  const usable = roles.filter((r) => fits.includes(r));
  return usable.length ? usable : t.role(target, word, fits.join(" / "));
}

/** `操作:`, `**操作:**`, `### Actions` */
const MARKER = /^(?:操作|操作手順|actions?)\s*[:：]?$/i;

/**
 * The actions of a step, from the lines of its text (`first` is the line number of `lines[0]`):
 * the bullets under a line `操作:`, up to the first line that isn't one. Lines in code blocks don't count.
 */
export function parseActions(lines: string[], first: number, lang: Lang): { actions?: StepAction[]; problems: ActionProblem[] } {
  const t = TEXT[lang];
  const problems: ActionProblem[] = [];
  let actions: StepAction[] | undefined;
  let fence: string | undefined;
  let open = false;
  let markerLine = 0;
  lines.forEach((raw, i) => {
    const line = first + i;
    const fenceMark = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1];
    if (fence) {
      if (fenceMark && fenceMark[0] === fence[0] && fenceMark.length >= fence.length) fence = undefined;
      return;
    }
    if (fenceMark) {
      fence = fenceMark;
      open = false;
      return;
    }
    const plain = raw.trim().replace(/^#{3,}\s*/, "").replace(/^(\*\*|__)(.*)\1([:：]?)$/, "$2$3").trim();
    if (!actions && MARKER.test(plain)) {
      actions = [];
      open = true;
      markerLine = line;
      return;
    }
    if (!open || !raw.trim()) return;
    const bullet = /^\s*(?:[-*+・]|\d+[.)])\s+(.*)$/.exec(raw);
    if (!bullet) {
      // the actions end at the first line of text after them; one right under the marker is a slip
      if (!actions!.length) problems.push({ line, message: t.notBullet });
      open = false;
      return;
    }
    const parsed = parseAction(bullet[1]!.trim(), line, t);
    if (typeof parsed === "string") problems.push({ line, message: parsed });
    else actions!.push(parsed);
  });
  if (actions && !actions.length && !problems.length) problems.push({ line: markerLine, message: t.none });
  return { ...(actions ? { actions } : {}), problems };
}

type Text = (typeof TEXT)["en"];

function parseAction(text: string, line: number, t: Text): StepAction | string {
  const m = /^(.+?)\s*[:：]\s*(.*)$/.exec(text.replace(/^\*\*(.+?)\*\*/, "$1"));
  if (!m) return t.shape;
  const word = m[1]!.trim().replace(/^\*\*|\*\*$/g, "");
  const verb = VERBS[word.toLowerCase()] ?? VERBS[word.replace(/\s+/g, "")];
  if (!verb) return /\s/.test(word.trim()) && word.length > 20 ? t.shape : t.verb(word);
  const rest = m[2]!.trim();
  const action: StepAction = { line, written: text, verb };
  switch (verb) {
    case "open": {
      const url = unquote(rest);
      if (!url) return t.open;
      return { ...action, target: url };
    }
    case "fill":
    case "select": {
      const scoped = withRow(rest);
      const pair = splitPair(scoped.text);
      if (!pair || !pair.label) return t.pair(word);
      const roles = rolesOf(pair.label, verb, word, t);
      if (typeof roles === "string") return roles;
      return { ...action, target: pair.label, value: pair.value, ...(roles ? { roles } : {}), ...scoped.row };
    }
    case "check":
    case "uncheck": {
      const scoped = withRow(rest);
      const name = unquote(scoped.text);
      if (!name) return t.name;
      const roles = rolesOf(name, verb, word, t);
      if (typeof roles === "string") return roles;
      return { ...action, target: name, ...(roles ? { roles } : {}), ...scoped.row };
    }
    case "click": {
      const scoped = withRow(rest);
      const byText = /^(?:文字|テキスト|text)\s*(?=[「『"'])/i.exec(scoped.text);
      const name = unquote(byText ? scoped.text.slice(byText[0].length) : scoped.text);
      // `押す: (「1042」の行)` clicks the row
      if (!name && !scoped.row) return t.name;
      return { ...action, ...(name ? { target: name } : {}), ...(byText ? { byText: true } : {}), ...scoped.row };
    }
    case "press": {
      const key = keyName(unquote(rest));
      if (!key) return t.key;
      return { ...action, target: key };
    }
    case "wait": {
      const ms = duration(rest);
      if (ms !== undefined) return ms > 60_000 ? t.waitLong : { ...action, ms };
      const shown = shownText(rest);
      if (!shown) return t.wait;
      return { ...action, ...shown };
    }
    case "expect": {
      const shown = shownText(rest);
      if (shown) return { ...action, ...shown };
      const scoped = withRow(rest);
      const pair = splitPair(scoped.text);
      if (!pair || !pair.label) return t.expect;
      const roles = rolesOf(pair.label, verb, word, t);
      if (typeof roles === "string") return roles;
      return { ...action, target: pair.label, value: pair.value, ...(roles ? { roles } : {}), ...scoped.row };
    }
    case "dialog": {
      const answer = rest.trim();
      if (!answer) return t.dialog;
      const plain = answer.replace(/\s*(?:を押す|を選ぶ|で答える|と答える)$/, "").trim();
      if (/^(?:ok|はい|yes|accept|承認|了解)$/i.test(plain)) return { ...action, accept: true };
      if (/^(?:キャンセル|いいえ|no|cancel|dismiss)$/i.test(plain)) return { ...action, accept: false };
      return { ...action, accept: true, value: unquote(answer) };
    }
  }
}

/** 「登録」, 『登録』, "登録", '登録' and `登録` → 登録. */
export function unquote(text: string): string {
  const s = text.trim();
  const pairs: [string, string][] = [
    ["「", "」"],
    ["『", "』"],
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["“", "”"],
  ];
  for (const [open, close] of pairs) if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) return s.slice(open.length, -close.length);
  return s;
}

/** `label = value`, split at the first = that isn't in quotes. */
function splitPair(text: string): { label: string; value: string } | undefined {
  let quote: string | undefined;
  const close: Record<string, string> = { "「": "」", "『": "』", '"': '"', "'": "'", "`": "`" };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      continue;
    }
    if (close[c] && (i === 0 || /[\s=＝]/.test(text[i - 1]!))) quote = close[c];
    else if (c === "=" || c === "＝") return { label: unquote(text.slice(0, i)), value: unquote(text.slice(i + 1)) };
  }
  return undefined;
}

/** A row scope at the end: `(「1042」の行)`, `(最後の行)`, `(row "1042")`, `(in the last row)`. Other parentheses are part of the name. */
function withRow(text: string): { text: string; row?: { row: RowScope } } {
  const m = /^(.*?)\s*[(（]([^()（）]*)[)）]\s*$/.exec(text);
  if (!m) return { text };
  const inside = m[2]!.trim();
  const at = /^(?:(最初|先頭|1\s*行目)の?行?|(最後|末尾)の行|(?:in\s+)?the\s+(first|last)\s+row|(first|last)\s+row)$/i.exec(inside);
  if (at) return { text: m[1]!, row: { row: { at: at[1] || /first/i.test(at[3] ?? at[4] ?? "") ? "first" : "last" } } };
  const ja = /^(.+?)\s*(?:の|が\s*ある|を含む)\s*行$/.exec(inside);
  const en = /^(?:in\s+)?(?:the\s+)?row(?:\s+with)?\s+(.+)$/i.exec(inside);
  const shown = ja?.[1] ?? en?.[1];
  if (!shown) return { text };
  const value = unquote(shown);
  return value ? { text: m[1]!, row: { row: { text: value } } } : { text };
}

/** 「登録しました」が表示される → shown; 「エラー」が表示されない → hidden. */
function shownText(text: string): { shown: string; hidden?: true } | undefined {
  const m = /^(「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'|“[^”]*”)\s*(.*)$/.exec(text.trim());
  if (!m) return undefined;
  const shown = unquote(m[1]!);
  if (!shown) return undefined;
  const rest = m[2]!.replace(/[。.]$/, "").trim();
  if (!rest) return { shown };
  if (/(?:ない|消える|なくなる|is\s+not|isn't|not\s+(?:shown|visible|displayed)|disappears?|is\s+gone|goes\s+away|hidden)/i.test(rest)) return { shown, hidden: true };
  if (/^(?:が|と|は|を)?\s*(?:画面に)?\s*(?:表示|出|ある|見え|is\s+shown|is\s+visible|is\s+displayed|appears?|shows?|visible|shown)/i.test(rest)) return { shown };
  return undefined;
}

/** `2 秒`, `500 ミリ秒`, `2s`, `2 seconds`, `500ms` → milliseconds. */
function duration(text: string): number | undefined {
  const m = /^([\d.]+)\s*(秒|ミリ秒|s|secs?|seconds?|ms|milliseconds?)$/i.exec(text.trim().replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10)));
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(/^(?:ミリ秒|ms|milliseconds?)$/i.test(m[2]!) ? n : n * 1000);
}

const KEYS: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  エンター: "Enter",
  tab: "Tab",
  タブ: "Tab",
  esc: "Escape",
  escape: "Escape",
  エスケープ: "Escape",
  space: "Space",
  スペース: "Space",
  backspace: "Backspace",
  delete: "Delete",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  上: "ArrowUp",
  下: "ArrowDown",
  左: "ArrowLeft",
  右: "ArrowRight",
};

/** A key as Playwright names it: Enter, Tab, Escape, ArrowDown, Control+A, F2... */
function keyName(text: string): string | undefined {
  const parts = text.replace(/\s*(?:キー)$/, "").split("+").map((p) => p.trim());
  if (!parts.length || parts.some((p) => !p)) return undefined;
  const named = parts.map((p) => {
    const known = KEYS[p.toLowerCase()];
    if (known) return known;
    if (/^(?:ctrl|control)$/i.test(p)) return "Control";
    if (/^(?:shift|alt|meta)$/i.test(p)) return p[0]!.toUpperCase() + p.slice(1).toLowerCase();
    if (/^f\d{1,2}$/i.test(p)) return p.toUpperCase();
    if (/^[A-Za-z][a-z]*[A-Z][A-Za-z]*$|^(?:Enter|Tab|Escape|Space|Backspace|Delete|Home|End|PageUp|PageDown|Insert)$/.test(p)) return p;
    return [...p].length === 1 ? p : undefined;
  });
  return named.every(Boolean) ? named.join("+") : undefined;
}
