import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  renameOver(tmp, file);
}

/**
 * On Windows, replacing a file fails while another process has it open for a moment (antivirus,
 * search indexer, OneDrive): retry briefly, then write the file directly.
 */
function renameOver(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      return renameSync(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw e;
      if (attempt >= 10) {
        copyFileSync(from, to);
        rmSync(from, { force: true });
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}

export function loadSession(file: string): Session {
  const s = JSON.parse(readFileSync(file, "utf8")) as Session;
  if (s.version !== 1 || !Array.isArray(s.steps)) throw new Error(`${file} is not an ashiato session file`);
  return s;
}
