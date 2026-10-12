import type { MediaStore } from "../core/media.js";
import type { Session } from "../core/types.js";
import { readReplay } from "../export/screens.js";
import { interactionsOf, type ReplayEvent } from "./interactions.js";
import { playwrightTest } from "./playwright.js";

export interface GenerateTestOptions {
  /** The session's screen replay and recordings. Without a replay, the actions are left as TODOs. */
  media?: MediaStore;
  /** Shown in the test's header. */
  sessionFile?: string;
  /** The test's title. Default: "recorded <date>". */
  name?: string;
}

/**
 * A Playwright test made from a recording: it does again what was clicked and typed (from the
 * screen replay), and checks with `expectDbChanges` that each step changes the same rows.
 */
export async function generateTest(session: Session, options: GenerateTestOptions = {}): Promise<string> {
  const path = options.media?.replayPath();
  const tabs = path ? ((await readReplay(path)) as Map<string, ReplayEvent[]>) : undefined;
  return playwrightTest(session, { interactions: tabs ? interactionsOf(tabs) : [], sessionFile: options.sessionFile, name: options.name });
}
