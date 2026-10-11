import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MediaStore } from "../src/core/media.js";
import type { Session } from "../src/core/types.js";

const newSession = (): Session => ({ version: 1, id: "s", startedAt: "2026-10-11T00:00:00.000Z", dialect: "sqlite", tables: [], steps: [] });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ashiato-media-"));
  const file = join(dir, "2026-10-11T00-00-00-000Z.json");
  const session = newSession();
  let changes = 0;
  const media = new MediaStore(file, session, () => changes++);
  return { dir, session, media, changes: () => changes };
}

describe("MediaStore", () => {
  it("appends replay batches as lines next to the session file", () => {
    const { dir, session, media, changes } = setup();
    media.appendReplay("tab1", [{ type: 4, timestamp: 1 }]);
    media.appendReplay("tab1", []);
    media.appendReplay("tab2", [{ type: 2, timestamp: 2 }]);
    expect(session.replay).toEqual({ file: "2026-10-11T00-00-00-000Z.replay.ndjson" });
    expect(changes()).toBe(1);
    const lines = readFileSync(join(dir, session.replay!.file), "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).tab)).toEqual(["tab1", "tab2"]);
    expect(media.replayPath()).toBe(join(dir, session.replay!.file));
  });

  it("rejects bad replay input", () => {
    const { media } = setup();
    expect(() => media.appendReplay("../x", [])).toThrow("invalid tab id");
    expect(() => media.appendReplay("t", "nope" as unknown as unknown[])).toThrow("array");
  });

  it("stores screen recordings chunk by chunk", () => {
    const { dir, session, media } = setup();
    const v = media.startVideo("video/webm;codecs=vp9", "2026-10-11T00:00:05.000Z");
    expect(v).toMatchObject({ id: 1, file: "2026-10-11T00-00-00-000Z.video-1.webm" });
    media.appendVideo(1, Buffer.from("ab"));
    media.appendVideo(1, Buffer.from("cd"));
    media.stopVideo(1, "2026-10-11T00:00:09.000Z");
    expect(() => media.appendVideo(1, Buffer.from("e"))).toThrow("already finished");
    expect(readFileSync(join(dir, v.file), "utf8")).toBe("abcd");
    expect(media.videoFile(1)).toMatchObject({ size: 4, mimeType: "video/webm;codecs=vp9" });
    expect(media.startVideo("video/webm", "2026-10-11T00:01:00.000Z").id).toBe(2);
    expect(session.videos?.map((x) => x.endedAt)).toEqual(["2026-10-11T00:00:09.000Z", undefined]);
    expect(() => media.startVideo("text/html", "2026-10-11T00:01:00.000Z")).toThrow("unsupported");
  });

  it("only reads files next to the session file, and never writes when read-only", () => {
    const { dir } = setup();
    writeFileSync(join(dir, "secret.txt"), "x");
    const session = newSession();
    session.videos = [{ id: 1, file: "../../" + dir.split("/").pop() + "/secret.txt", mimeType: "video/webm", startedAt: "t" }];
    const ro = new MediaStore(join(dir, "other", "s.json"), session, undefined, true);
    expect(ro.videoFile(1)).toBeUndefined();
    expect(() => ro.appendReplay("t", [{}])).toThrow("read-only");
  });
});
