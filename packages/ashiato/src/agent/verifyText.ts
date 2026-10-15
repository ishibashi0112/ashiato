/**
 * The results of `verify --auto` for an AI agent told no values: per step, the verdict, which action
 * failed and why (in words made from the step's own names), the names on the page like the one
 * written, the page's accessibility tree with what may show the database's values hidden, and what
 * changed in counts and columns. The rows found, the page's text and the database's messages are left
 * out: they are in the report file.
 */
import { tableId } from "../core/diff.js";
import type { Lang } from "../export/text.js";
import { dialogText } from "../chat/auto.js";
import { verdictText, type VerifyRun } from "../chat/verify.js";
import { changesLine, problemShape } from "./text.js";

const indent = (text: string, n: number) =>
  text
    .split("\n")
    .map((l) => (l ? " ".repeat(n) + l : l))
    .join("\n");

export function verifySummary(run: VerifyRun, options: { fileName: string; lang: Lang }): string {
  const { lang } = options;
  const counts = (["ok", "ng", "unchecked", "skipped", "not-run", "error"] as const)
    .map((v) => [v, run.outcomes.filter((o) => o.verdict === v).length] as const)
    .filter(([, n]) => n)
    .map(([v, n]) => `${verdictText(v, lang)} ${n}`);
  const out = [`${options.fileName}: ${counts.join(", ") || "no steps checked"}`];
  if (run.notCompared.length) {
    // `it could not be read: <the database's message>`: the message may hold values
    const reason = (r: string) => r.replace(/could not be read: .*$/s, "could not be read");
    out.push(`not compared: ${run.notCompared.map((n) => `${tableId(n.table)} (${reason(n.reason)})`).join(", ")}`);
  }
  for (const o of run.outcomes) {
    const head = `${o.step.title}: ${verdictText(o.verdict, lang)}`;
    if (o.verdict === "skipped" && !o.step.actions) {
      out.push(`${head} (no actions: a person does this step)`);
      continue;
    }
    out.push(head);
    if (o.verdict === "error") out.push("  error reading the database (its message is not shown: see the report)");
    const a = o.actions;
    if (a && o.step.actions) {
      const failedAt = a.failed ? o.step.actions.indexOf(a.failed.action) : -1;
      out.push(`  actions: ${o.step.actions.map((x, i) => `${i < a.done ? "✓" : i === failedAt ? "✗" : "-"} ${x.written}`).join(" | ")}`);
      if (a.failed) {
        out.push(`  failed: ${a.failed.valueFree.message}`);
        if (a.failed.valueFree.candidates?.length) out.push(`  on the page, with names like it: ${a.failed.valueFree.candidates.join(", ")}`);
      }
      if (a.dialogs.length) out.push(`  dialogs: ${a.dialogs.map((d) => dialogText(d, lang, false)).join(", ")}`);
    }
    if (o.diff) out.push(`  changed: ${changesLine(o.diff) || "nothing"}`);
    if (o.verdict === "ng" || o.verdict === "unchecked") {
      if (o.step.expect) out.push(`  expected: ${o.step.expect.lines.join(" / ")}`);
      if (o.problems) out.push("  differences:", ...o.problems.map((p) => indent(problemShape(p), 4)));
    }
    if (o.verdict === "ng" && a?.screen) out.push("  the page at the end (text that may show the database's values is …):", indent(a.screen.valueFree, 4));
  }
  return out.join("\n");
}
