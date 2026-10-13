import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Puts text on the clipboard with the operating system's own command, so no package is needed:
 * PowerShell's Set-Clipboard on Windows (through a UTF-8 file, whatever the console's code page),
 * pbcopy on macOS, xclip on Linux. Never through a shell. Not covered by automated tests.
 */
export function writeClipboard(text: string): { ok: true } | { ok: false; message: string } {
  const timeout = 15_000;
  const result = (r: ReturnType<typeof spawnSync>, command: string) => {
    if (r.error) return { ok: false as const, message: (r.error as NodeJS.ErrnoException).code === "ENOENT" ? `${command} was not found` : r.error.message };
    if (r.status !== 0) return { ok: false as const, message: `${command} exited with ${r.status ?? "a signal"}` };
    return { ok: true as const };
  };
  if (process.platform === "win32") {
    const dir = mkdtempSync(join(tmpdir(), "ashiato-clip-"));
    const file = join(dir, "clip.txt");
    try {
      writeFileSync(file, text, "utf8");
      // single quotes: PowerShell expands nothing in them ('' is a quote)
      const quoted = `'${file.split("'").join("''")}'`;
      return result(
        spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Get-Content -Raw -Encoding UTF8 -LiteralPath ${quoted} | Set-Clipboard`], {
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
          timeout,
        }),
        "PowerShell",
      );
    } finally {
      // it holds the database's values: don't leave it behind
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (process.platform === "darwin") return result(spawnSync("pbcopy", [], { input: text, stdio: ["pipe", "ignore", "ignore"], timeout }), "pbcopy");
  // xclip stays in the background to hold the selection: with stdout / stderr connected, we'd wait for it
  return result(spawnSync("xclip", ["-selection", "clipboard"], { input: text, stdio: ["pipe", "ignore", "ignore"], timeout }), "xclip");
}
