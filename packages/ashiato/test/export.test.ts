import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli/main.js";
import { MediaStore } from "../src/core/media.js";
import type { Session } from "../src/core/types.js";
import { evidenceWorkbook } from "../src/export/excel.js";
import type { Evidence } from "../src/export/evidence.js";
import { evidenceHtml } from "../src/export/html.js";
import { exportEvidence } from "../src/export/index.js";
import { momentsOf } from "../src/export/screens.js";
import { langOf } from "../src/export/text.js";
import { colName, Workbook } from "../src/export/xlsx.js";
import { zip } from "../src/export/zip.js";
import { sampleSession } from "./fixtures/session.js";

/** Reads a zip archive, checking each file's CRC. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const raw = buf.subarray(start, start + size);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    expect(crc32(data) >>> 0, name).toBe(crc);
    files.set(name, data);
    p += 46 + nameLen;
  }
  return files;
}

const evidence = (session: Session, more: Partial<Evidence> = {}): Evidence => ({
  session,
  steps: session.steps,
  lang: "en",
  screens: new Map(),
  exportedAt: "2026-10-11T05:00:00.000Z",
  ...more,
});

const text = (files: Map<string, Buffer>, name: string) => files.get(name)!.toString("utf8");

describe("zip", () => {
  it("writes archives that inflate back to the same bytes", async () => {
    const big = Buffer.from("ashiato ".repeat(10_000));
    const files = unzip(await zip([{ name: "a.txt", data: "hello" }, { name: "dir/日本語.bin", data: big }, { name: "img.jpeg", data: Buffer.from([1, 2, 3]), store: true }]));
    expect([...files.keys()]).toEqual(["a.txt", "dir/日本語.bin", "img.jpeg"]);
    expect(files.get("a.txt")!.toString()).toBe("hello");
    expect(files.get("dir/日本語.bin")!.equals(big)).toBe(true);
    expect([...files.get("img.jpeg")!]).toEqual([1, 2, 3]);
  });
});

describe("xlsx writer", () => {
  it("names columns like Excel", () => {
    expect([0, 25, 26, 51, 52, 701, 702, 16383].map(colName)).toEqual(["A", "Z", "AA", "AZ", "BA", "ZZ", "AAA", "XFD"]);
  });

  it("makes sheet names valid and unique", () => {
    const book = new Workbook();
    expect(book.sheet("a/b:c*d?e[f]g\\h").name).toBe("a b c d e f g h");
    expect(book.sheet("'quoted'").name).toBe("quoted");
    expect(book.sheet("x".repeat(40)).name).toBe("x".repeat(31));
    expect(book.sheet("X".repeat(40)).name).toBe(`${"X".repeat(27)} (2)`);
    expect(book.sheet("").name).toBe("Sheet");
  });

  it("anchors pictures below the rows before them and reserves the rows they cover", async () => {
    const book = new Workbook();
    const sheet = book.sheet("s");
    sheet.add("caption");
    sheet.picture({ data: Buffer.from([0xff, 0xd8, 0xff]), type: "jpeg", width: 200, height: 100 });
    // 100 px = 5 rows of 20 px, plus one
    expect(sheet.add("next")).toBe(7);
    const files = unzip(await book.toBuffer());
    expect(text(files, "[Content_Types].xml")).toContain('<Override PartName="/xl/drawings/drawing1.xml"');
    expect(text(files, "xl/worksheets/sheet1.xml")).toContain('<drawing r:id="rId1"/>');
    expect(text(files, "xl/worksheets/_rels/sheet1.xml.rels")).toContain('Target="../drawings/drawing1.xml"');
    const drawing = text(files, "xl/drawings/drawing1.xml");
    expect(drawing).toContain("<xdr:row>1</xdr:row>");
    expect(drawing).toContain(`<xdr:ext cx="${200 * 9525}" cy="${100 * 9525}"/>`);
    expect(text(files, "xl/drawings/_rels/drawing1.xml.rels")).toContain('Target="../media/image1.jpeg"');
    expect([...files.get("xl/media/image1.jpeg")!]).toEqual([0xff, 0xd8, 0xff]);
  });
});

describe("evidence workbook", () => {
  let files: Map<string, Buffer>;
  beforeAll(async () => {
    files = unzip(await evidenceWorkbook(evidence(sampleSession())));
  });
  const sheet = (n: number) => text(files, `xl/worksheets/sheet${n}.xml`);

  it("has a summary, a list of every change, and a sheet per step", () => {
    const names = [...text(files, "xl/workbook.xml").matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);
    expect(names).toEqual(["Summary", "All changes", "#1 click button &quot;保存&quot;", "#2 outside actions", "#3 checkpoint 3", "#4 click button &quot;削除&quot;", "#5 checkpoint 5"]);
    // the summary links each step to its sheet
    expect(sheet(1)).toContain(`<hyperlink ref="A10" location="'#1 click button &quot;保存&quot;'!A1"/>`);
    expect(sheet(1)).toContain('<autoFilter ref="A9:J14"/>');
    // the list of changes: header kept in view, filterable, one line per changed column
    expect(sheet(2)).toContain('state="frozen"');
    expect(sheet(2)).toMatch(/<t xml:space="preserve">qty<\/t><\/is><\/c><c r="H\d+" s="\d+"><v>50<\/v><\/c><c r="I\d+" s="\d+"><v>40<\/v>/);
  });

  it("keeps database values as they are: numbers, text that looks like a number, long IDs, booleans, NULL", () => {
    const step = sheet(3);
    expect(step).toMatch(/<c r="B\d+" s="\d+"><v>1042<\/v><\/c>/);
    expect(step).toContain('<t xml:space="preserve">00123</t>');
    // 17 digits: Excel would round it as a number
    expect(step).toContain('<t xml:space="preserve">9007199254740993</t>');
    expect(step).toMatch(/t="b"><v>1<\/v>/);
    expect(step).toContain('<t xml:space="preserve">NULL</t>');
    // an update shows the row before and after
    expect(step).toContain('<t xml:space="preserve">Before</t>');
    expect(step).toContain('<t xml:space="preserve">After</t>');
  });

  it("writes text Excel reads back unchanged: markup, control characters and its own _xHHHH_ escapes", () => {
    const step = sheet(4);
    expect(step).toContain("line1_x000D_\nline2 _x0001_ _x005F_x0041_ &lt;tag&gt; &amp; &quot;q&quot;");
    expect(step).not.toMatch(/[\x00-\x08\x0b-\x1f]/);
  });

  it("says why a step has no rows, which tables it couldn't compare, and which tables came and went", () => {
    expect(sheet(5)).toContain("No rows changed in the watched tables.");
    expect(sheet(7)).toContain("New table: dbo.empty_new is watched from this step on");
    expect(sheet(7)).toContain("Table gone: dbo.old_work was dropped");
    expect(sheet(4)).toContain("Not compared: dbo.big (200000 rows (more than max rows 100000))");
    expect(sheet(4)).toContain("No primary key");
  });

  it("is in Japanese when asked", async () => {
    const ja = unzip(await evidenceWorkbook(evidence(sampleSession(), { lang: "ja" })));
    expect(text(ja, "xl/workbook.xml")).toContain('<sheet name="概要"');
    expect(text(ja, "xl/workbook.xml")).toContain('<sheet name="#2 操作外の変更"');
    expect(text(ja, "xl/worksheets/sheet3.xml")).toContain("変更後");
    expect(text(ja, "xl/styles.xml")).toContain('<name val="Yu Gothic"/>');
  });
});

describe("evidence HTML", () => {
  it("is self-contained and escapes what the database holds", () => {
    const html = evidenceHtml(evidence(sampleSession()));
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"`);
    expect(html).not.toMatch(/<script|<link|src="http/i);
    expect(html).toContain("&#60;tag&#62; &#38; &#34;q&#34;");
    expect(html).not.toContain("\u0001");
    expect(html).toContain('<a href="#step-4">#4</a>');
    expect(html).toContain('<p class="ins">New table: dbo.empty_new is watched');
    expect(html).toContain('<p class="del">Table gone: dbo.old_work was dropped');
  });

  it("shows the key and the changed columns of a table with only updates, and caps long tables", () => {
    const session = sampleSession();
    session.steps[0]!.diff.tables[1]!.updated[0]!.before.extra = "same";
    session.steps[0]!.diff.tables[1]!.updated[0]!.after.extra = "same";
    session.steps[3]!.diff.tables[0]!.deleted = Array.from({ length: 250 }, (_, i) => ({ id: i, customer: "x" }));
    const html = evidenceHtml(evidence(session));
    const stock = html.slice(html.indexOf("<h3>dbo.stock"), html.indexOf("</table>", html.indexOf("<h3>dbo.stock")));
    expect(stock).toContain(">item_id<");
    expect(stock).toContain(">qty<");
    expect(stock).not.toContain(">name<");
    expect(stock).not.toContain(">extra<");
    expect(html).toContain("50 more rows are not shown here: see the Excel export.");
  });
});

describe("exportEvidence", () => {
  it("leaves out steps without changes when asked, without needing a browser", async () => {
    const { files, notes } = await exportEvidence(sampleSession(), { formats: ["html", "xlsx"], lang: "en", changedOnly: true, browser: "/no/such/browser" });
    expect(notes).toEqual([]);
    const html = files.html!.toString();
    expect(html).toContain('id="step-1"');
    expect(html).not.toContain('id="step-3"');
    // tables that came or went count as a change, as in the timeline
    expect(html).toContain('id="step-5"');
    expect(html).toContain("<tr><th>Steps</th><td>4 / 5</td></tr>");
    expect(text(unzip(files.xlsx!), "xl/workbook.xml")).not.toContain("#3 checkpoint 3");
  });

  it("still writes Excel when the screenshots can't be taken, and says why", async () => {
    const session = sampleSession();
    const media = new MediaStore(join(mkdtempSync(join(tmpdir(), "ashiato-export-")), "session.json"), session);
    media.appendReplay("tab-1", [{ type: 4, timestamp: Date.parse(session.startedAt), data: { href: "http://localhost/", width: 800, height: 600 } }]);
    const { files, notes } = await exportEvidence(session, { formats: ["xlsx"], lang: "en", media, browser: "/no/such/browser" });
    expect(notes).toEqual(["Screenshots were not taken: Browser not found: /no/such/browser"]);
    expect(text(unzip(files.xlsx!), "xl/worksheets/sheet1.xml")).toContain("Screenshots were not taken: Browser not found: /no/such/browser");
  });

  it("needs a browser for PDF, and says which one it looked for", async () => {
    await expect(exportEvidence(sampleSession(), { formats: ["pdf"], browser: "/no/such/browser" })).rejects.toThrow("Browser not found: /no/such/browser");
  });

  it("picks the language from the locale", () => {
    expect(langOf("ja-JP")).toBe("ja");
    expect(langOf("ja")).toBe("ja");
    expect(langOf("en-US")).toBe("en");
    expect(langOf("de")).toBe("en");
  });

  it("takes screenshots just before a user action and at its checkpoint, none for outside changes", () => {
    const [save, outside, manual] = sampleSession().steps;
    expect(momentsOf(save!).map((m) => [m.moment, m.t])).toEqual([
      ["before", Date.parse(save!.action!.startedAt) - 1],
      ["after", Date.parse(save!.at)],
    ]);
    expect(momentsOf(outside!)).toEqual([]);
    expect(momentsOf(manual!).map((m) => m.moment)).toEqual(["after"]);
  });
});

describe("ashiato export", () => {
  const saved = () => {
    const dir = mkdtempSync(join(tmpdir(), "ashiato-export-"));
    const file = join(dir, "2026-10-11T04-00-00-000Z.json");
    writeFileSync(file, JSON.stringify(sampleSession()));
    return { dir, file };
  };

  it("writes the evidence next to the session file", async () => {
    const { dir, file } = saved();
    await main(["export", file, "--lang", "en", "--no-screens"]);
    expect(readdirSync(dir).sort()).toEqual(["2026-10-11T04-00-00-000Z.json", "2026-10-11T04-00-00-000Z.xlsx"]);
  });

  it("writes several formats to the --out path or folder", async () => {
    const { dir, file } = saved();
    await main(["export", file, "--format", "xlsx,html", "--out", join(dir, "out", "login.xlsx")]);
    expect(readdirSync(join(dir, "out")).sort()).toEqual(["login.html", "login.xlsx"]);
    await main(["export", file, "--format", "html", "--out", `${join(dir, "folder")}/`]);
    expect(readdirSync(join(dir, "folder"))).toEqual(["2026-10-11T04-00-00-000Z.html"]);
    expect(readFileSync(join(dir, "folder", "2026-10-11T04-00-00-000Z.html"), "utf8")).toContain("<!doctype html>");
  });

  it("rejects unknown formats and languages", async () => {
    const { file } = saved();
    await expect(main(["export", file, "--format", "docx"])).rejects.toThrow("Unknown export format: docx");
    await expect(main(["export", file, "--lang", "fr"])).rejects.toThrow("--lang must be ja or en");
  });
});
