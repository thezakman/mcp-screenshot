import { open, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { ScreenshotError } from "./errors.js";

export async function assertDirectory(path: string) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new ScreenshotError(
      "INVALID_PATH",
      "Expected a regular evidence directory.",
    );
}

export async function openRegular(path: string, limit: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new ScreenshotError(
        "EVIDENCE_TOO_LARGE",
        "Evidence exceeds its size limit or is not a regular file.",
      );
    return { file, stat };
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function readBounded(path: string, limit: number) {
  const { file, stat } = await openRegular(path, limit);
  try {
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (!bytesRead)
        throw new ScreenshotError(
          "FILE_CHANGED",
          "Evidence changed while reading.",
        );
      offset += bytesRead;
    }
    const after = await file.stat();
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new ScreenshotError(
        "FILE_CHANGED",
        "Evidence changed while reading.",
      );
    return buffer;
  } finally {
    await file.close();
  }
}
