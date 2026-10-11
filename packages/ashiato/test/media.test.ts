import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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

  it("asks each tab for a full snapshot until it sent one", () => {
    const { media } = setup();
    // a page that was open before the recorder started sends only changes at first
    expect(media.appendReplay("tab1", [{ type: 3, timestamp: 1 }])).toEqual({ snapshot: true });
    expect(media.appendReplay("tab1", [{ type: 4, timestamp: 2 }, { type: 2, timestamp: 2 }])).toEqual({ snapshot: false });
    expect(media.appendReplay("tab1", [])).toEqual({ snapshot: false });
    expect(media.appendReplay("tab2", [{ type: 3, timestamp: 3 }])).toEqual({ snapshot: true });
  });

  it("rejects bad replay input", () => {
    const { media, session } = setup();
    expect(() => media.appendReplay("../x", [])).toThrow("invalid tab id");
    expect(() => media.appendReplay("t", "nope" as unknown as unknown[])).toThrow("array");
    for (const bad of [null, 1, [], {}, { type: 2 }, { type: "2", timestamp: 1 }, { type: 2, timestamp: null }]) {
      expect(() => media.appendReplay("t", [{ type: 4, timestamp: 1 }, bad])).toThrow("rrweb events");
    }
    expect(session.replay).toBeUndefined();
  });

  it("stops growing the replay file at its limit", () => {
    const { media, dir, session } = setup();
    media.maxReplayBytes = 200;
    media.appendReplay("t", [{ type: 2, timestamp: 1, data: "x".repeat(100) }]);
    expect(() => media.appendReplay("t", [{ type: 3, timestamp: 2, data: "x".repeat(100) }])).toThrow("limit of 200 bytes");
    expect(readFileSync(join(dir, session.replay!.file), "utf8").split("\n")).toHaveLength(2);
  });

  it("ends a recording left open when the next one starts, or when the session is opened again", () => {
    const { dir, session, media } = setup();
    const a = media.startVideo("video/webm", "2026-10-11T00:00:00.000Z");
    media.appendVideo(a.id, Buffer.from("ab"));
    const lastWrite = new Date("2026-10-11T00:00:07.000Z");
    utimesSync(join(dir, a.file), lastWrite, lastWrite);
    // its timeline tab was closed without stopping it
    const b = media.startVideo("video/webm", "2026-10-11T00:01:00.000Z");
    expect(session.videos![0]!.endedAt).toBe(lastWrite.toISOString());
    // one being written right now (another timeline tab) stays open
    media.appendVideo(b.id, Buffer.from("cd"));
    media.startVideo("video/webm", "2026-10-11T00:01:01.000Z");
    expect(session.videos![1]!.endedAt).toBeUndefined();

    const reopened = { ...newSession(), videos: [{ ...b }, { id: 9, file: "gone.webm", mimeType: "video/webm", startedAt: "2026-10-11T00:02:00.000Z" }] };
    new MediaStore(join(dir, "2026-10-11T00-00-00-000Z.json"), reopened, undefined, true);
    expect(reopened.videos.map((v) => v.endedAt)).toEqual([expect.stringMatching(/^\d{4}-/), "2026-10-11T00:02:00.000Z"]);
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
    // a directory where the file should be is not served either
    mkdirSync(join(dir, "other", "r.ndjson"), { recursive: true });
    session.replay = { file: "r.ndjson" };
    expect(ro.replayPath()).toBeUndefined();
    expect(() => ro.appendReplay("t", [{}])).toThrow("read-only");
  });
});
