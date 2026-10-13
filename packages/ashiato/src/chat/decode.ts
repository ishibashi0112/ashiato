/**
 * The text of a file someone saved: UTF-8 (with or without a BOM), UTF-16 with a BOM, or Shift_JIS,
 * which is what Japanese Windows editors write by default for older projects.
 */
export function decodeText(data: Uint8Array): string {
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return new TextDecoder("utf-8").decode(data.subarray(3));
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data.subarray(2));
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    // not UTF-8
  }
  try {
    return new TextDecoder("shift_jis", { fatal: true }).decode(data);
  } catch {
    throw new Error("the file is neither UTF-8 nor Shift_JIS: save it as UTF-8");
  }
}
