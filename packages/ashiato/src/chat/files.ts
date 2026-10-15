import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadSession } from "../core/store.js";
import type { Session } from "../core/types.js";
import type { Lang } from "../export/text.js";
import { decodeText } from "./decode.js";
import { testTitles, type ExistingTests } from "./pack.js";
import { parseVerifyFile } from "./verifyFile.js";

/** Files the chat commands read: verifications and .sql files, recordings, the tests there are already. */

/** Saved sessions: the files named, or the newest ones of a folder (default .ashiato/sessions, when there is one). */
export function readSessions(given: string[] | undefined, what = "--sessions"): Session[] {
  const paths = given ?? (existsSync(".ashiato/sessions") ? [".ashiato/sessions"] : []);
  const files: string[] = [];
  for (const p of paths) {
    const path = resolve(p);
    if (!existsSync(path)) throw new Error(`${what}: ${p} doesn't exist`);
    if (statSync(path).isDirectory()) {
      const inFolder = readdirSync(path)
        .filter((f) => /\.json$/i.test(f))
        .sort()
        .slice(-50)
        .map((f) => join(path, f));
      files.push(...inFolder);
    } else files.push(path);
  }
  return files.flatMap((f) => {
    try {
      return [loadSession(f)];
    } catch {
      // not a session (another JSON file in the folder)
      return [];
    }
  });
}

/**
 * The titles of Playwright tests (`*.spec.*`) and verifications (`*.verify.md`) in the folders given,
 * or in tests/, e2e/, test/, playwright/ and checks/. `display` writes a file's path.
 */
export function existingTests(given: string[] | undefined, lang: Lang, display: (path: string) => string, what = "--tests"): ExistingTests[] {
  const roots = given ?? ["tests", "e2e", "test", "playwright", "checks"].filter((d) => existsSync(d));
  const out: ExistingTests[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const path = join(dir, name);
      const stat = statSync(path, { throwIfNoEntry: false });
      if (stat?.isDirectory()) {
        if (depth < 6) walk(path, depth + 1);
        continue;
      }
      if (/\.verify\.md$/i.test(name)) {
        const file = parseVerifyFile(decodeText(readFileSync(path)), lang);
        out.push({ file: display(path), titles: [file.title || name, ...file.steps.map((s) => s.title)] });
      } else if (/\.spec\.[cm]?[jt]sx?$/i.test(name)) {
        const titles = testTitles(readFileSync(path, "utf8"));
        if (titles.length) out.push({ file: display(path), titles });
      }
    }
  };
  for (const root of roots) {
    const path = resolve(root);
    if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) walk(path, 0);
    else if (given) throw new Error(`${what}: ${root} is not a folder`);
  }
  return out;
}

/** Files named, or the files of a folder whose names end with `suffix` (by name). */
export function filesIn(paths: string[], suffix: RegExp, what: string): string[] {
  const files: string[] = [];
  for (const p of paths) {
    const path = resolve(p);
    if (statSync(path).isDirectory()) {
      const inFolder = readdirSync(path)
        .filter((f) => suffix.test(f))
        .sort()
        .map((f) => join(path, f));
      if (!inFolder.length) throw new Error(`No ${what} files in ${p}`);
      files.push(...inFolder);
    } else files.push(path);
  }
  return files;
}
