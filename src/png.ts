import { createHash } from "node:crypto";
import { ScreenshotError } from "./errors.js";
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const IEND = Buffer.from("0000000049454e44ae426082", "hex");
const TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let crc = n;
  for (let i = 0; i < 8; i++)
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
export function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) crc = TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const invalid = () =>
  new ScreenshotError(
    "INVALID_IMAGE",
    "Capture did not produce a complete PNG with valid chunks.",
  );
export function pngEdges(header: Buffer, tail: Buffer) {
  if (
    header.length < 33 ||
    !header.subarray(0, 8).equals(SIGNATURE) ||
    header.readUInt32BE(8) !== 13 ||
    header.toString("ascii", 12, 16) !== "IHDR" ||
    !tail.equals(IEND) ||
    crc32(header.subarray(12, 29)) !== header.readUInt32BE(29)
  )
    throw invalid();
  const width = header.readUInt32BE(16),
    height = header.readUInt32BE(20);
  const depths: Record<number, number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (
    !width ||
    !height ||
    width * height > 150_000_000 ||
    !depths[header[25]]?.includes(header[24]) ||
    header[26] !== 0 ||
    header[27] !== 0 ||
    header[28] > 1
  )
    throw invalid();
  return { width, height };
}
export function pngInfo(data: Buffer) {
  if (data.length < 57 || data.length > 64 * 1024 * 1024) throw invalid();
  const dimensions = pngEdges(data.subarray(0, 33), data.subarray(-12));
  let offset = 8,
    idatBytes = 0,
    seenIdat = false,
    endedIdat = false;
  while (offset < data.length) {
    if (offset + 12 > data.length) throw invalid();
    const length = data.readUInt32BE(offset),
      end = offset + 12 + length;
    if (end > data.length) throw invalid();
    const type = data.toString("ascii", offset + 4, offset + 8);
    if (
      !/^[A-Za-z]{4}$/.test(type) ||
      crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)
    )
      throw invalid();
    if (type === "IHDR" && offset !== 8) throw invalid();
    if (type === "IDAT") {
      if (endedIdat) throw invalid();
      seenIdat = true;
      idatBytes += length;
    } else if (seenIdat) endedIdat = true;
    if (type === "IEND" && (end !== data.length || length !== 0 || !idatBytes))
      throw invalid();
    offset = end;
  }
  return {
    ...dimensions,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}
