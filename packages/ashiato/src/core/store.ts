import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Session } from "./types.js";

export function sessionPath(dir: string, session: Session): string {
  const stamp = session.startedAt.replace(/[:.]/g, "-");
  return join(dir, `${stamp}.json`);
}

export function saveSession(file: string, session: Session): void {
  mkdirSync(dirname(file), { recursive: true });
  // write then rename, so a crash mid-write never leaves a half-written session file
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(session, null, 2));
  renameSync(tmp, file);
}

export function loadSession(file: string): Session {
  const s = JSON.parse(readFileSync(file, "utf8")) as Session;
  if (s.version !== 1 || !Array.isArray(s.steps)) throw new Error(`${file} is not an ashiato session file`);
  return s;
}
