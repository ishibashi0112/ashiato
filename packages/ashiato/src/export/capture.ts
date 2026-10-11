/**
 * Runs in the headless browser that takes the evidence screenshots (built as `dist/capture.global.js`):
 * shows a screen replay or a screen recording at a given moment, scaled to fit, top left of the page.
 */
import { Replayer, type eventWithTime } from "rrweb";
import css from "rrweb/dist/style.css";

/** Screenshots are at most this wide. */
const MAX_WIDTH = 1280;
/** Longest wait for a replayed page's images and fonts. */
const SETTLE_MS = 2000;

const style = document.createElement("style");
style.textContent = `${css}\nhtml, body { margin: 0; background: #fff; overflow: hidden; }\n#stage { position: absolute; left: 0; top: 0; transform-origin: 0 0; }\n#stage iframe { border: 0; }\nvideo { display: block; }`;
document.head.append(style);
const stage = Object.assign(document.createElement("div"), { id: "stage" });
document.body.append(stage);

let replayer: Replayer | undefined;
let video: HTMLVideoElement | undefined;

function reset() {
  replayer?.destroy();
  replayer = undefined;
  video = undefined;
  stage.replaceChildren();
}

/** Scales the stage so `width` fits; returns the size it takes on the page. */
function fit(width: number, height: number) {
  const scale = Math.min(1, MAX_WIDTH / width);
  stage.style.transform = `scale(${scale})`;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const timeout = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits (a little) for the replayed page's images and fonts. */
async function settle(doc: Document | null | undefined) {
  if (doc) {
    const images = [...doc.images].filter((img) => !img.complete);
    const loading = images.map((img) => new Promise((r) => (img.addEventListener("load", r), img.addEventListener("error", r))));
    // fonts.ready of a replayed document can stay pending although nothing is loading: check the status first
    if (doc.fonts?.status === "loading") loading.push(doc.fonts.ready);
    await Promise.race([Promise.all(loading), timeout(SETTLE_MS)]);
  }
  await frame();
}

const until = (target: EventTarget, event: string, ms: number) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${event} event within ${ms}ms`)), ms);
    target.addEventListener(event, () => (clearTimeout(timer), resolve()), { once: true });
    target.addEventListener("error", () => (clearTimeout(timer), reject(new Error("the video can't be played"))), { once: true });
  });

const capture = {
  /** Loads replay events: a meta event and a full snapshot first. */
  replay(events: eventWithTime[]) {
    reset();
    replayer = new Replayer(events, { root: stage, showWarning: false, mouseTail: false, triggerFocus: false, skipInactive: false });
  },

  /** Shows the replay `offset` ms after its first event; returns the size of what is shown. */
  async seek(offset: number) {
    if (!replayer) throw new Error("no replay loaded");
    replayer.pause(offset);
    await settle(replayer.iframe.contentDocument);
    return fit(Number(replayer.iframe.width) || replayer.iframe.clientWidth, Number(replayer.iframe.height) || replayer.iframe.clientHeight);
  },

  async video(url: string) {
    reset();
    video = Object.assign(document.createElement("video"), { muted: true, preload: "auto", src: url });
    stage.append(video);
    if (video.readyState < 1) await until(video, "loadedmetadata", 30_000);
  },

  /** Shows the recording `seconds` after its start; returns the size of what is shown. */
  async seekVideo(seconds: number) {
    const v = video;
    if (!v) throw new Error("no video loaded");
    const seeked = until(v, "seeked", 30_000);
    v.currentTime = seconds;
    await seeked;
    await new Promise<void>((resolve) => {
      if ("requestVideoFrameCallback" in v) v.requestVideoFrameCallback(() => resolve());
      else resolve();
      setTimeout(resolve, 1000);
    });
    v.width = v.videoWidth;
    v.height = v.videoHeight;
    await frame();
    return fit(v.videoWidth, v.videoHeight);
  },
};

(window as unknown as { __ashiatoCapture: typeof capture }).__ashiatoCapture = capture;
