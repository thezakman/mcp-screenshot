import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScreenshotError } from "./errors.js";
import { pngInfo } from "./png.js";

const run = promisify(execFile);

export async function embedDescription(
  data: Buffer,
  preExifHash: string,
  text: string | undefined,
  signal?: AbortSignal,
) {
  if (!text?.trim() || text.includes("\0"))
    throw new ScreenshotError(
      "INVALID_DESCRIPTION",
      "Enter a description without NUL characters or disable EXIF embedding.",
    );
  const directory = await mkdtemp(join(tmpdir(), "screenshot-exif-"));
  try {
    const png = join(directory, "capture.png");
    const description = join(directory, "description.txt");
    await writeFile(png, data, { mode: 0o600 });
    await writeFile(description, text, { mode: 0o600 });
    await run(
      "exiftool",
      [
        "-config",
        "",
        "-charset",
        "UTF8",
        "-overwrite_original",
        "-EXIF:UserComment<=" + description,
        png,
      ],
      { timeout: 30000, signal },
    );
    const tagged = await readFile(png);
    return {
      data: tagged,
      metadata: { ...pngInfo(tagged), pre_exif_sha256: preExifHash },
    };
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).code === "ENOENT" &&
      (err as NodeJS.ErrnoException).syscall === "spawn exiftool"
    )
      throw new ScreenshotError(
        "EXIFTOOL_UNAVAILABLE",
        "Install ExifTool on the MCP server PATH or disable EXIF embedding.",
      );
    throw err;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
