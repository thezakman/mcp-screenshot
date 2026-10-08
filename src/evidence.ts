import { pngInfo, pngEdges } from "./png.js";
export { pngInfo } from "./png.js";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rename,
  rm,
  realpath,
  lstat,
  link,
} from "node:fs/promises";
import {
  join,
  resolve,
  isAbsolute,
  relative,
  dirname,
  basename,
} from "node:path";
import { homedir } from "node:os";
import { assertDirectory, readBounded, openRegular } from "./storage.js";
import { parseManifest, manifestSchema } from "./manifest.js";
import { ScreenshotError } from "./errors.js";
import type { WindowInfo } from "./native.js";
const ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f-]{36}$/;
export const DEFAULT_ROOT = join(homedir(), "Pictures", "mcp-screenshot");
export interface EvidenceContext {
  case_id?: string;
  label?: string;
  note?: string;
  exchange_id?: string;
  tags?: string[];
}
export interface CaptureMetadata {
  captured_at: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  mode: "window" | "display";
  window?: WindowInfo;
  display?: number;
  verification: "window_identity_and_bounds" | "display_selected";
  warnings: string[];
}
export interface Evidence extends CaptureMetadata {
  schema_version: 1;
  id: string;
  context: EvidenceContext;
  association: "caller_supplied_unverified" | "none";
  image: string;
}
export class EvidenceStore {
  readonly root: string;
  constructor(root = process.env.MCP_SCREENSHOT_DIR ?? DEFAULT_ROOT) {
    if (!isAbsolute(root))
      throw new ScreenshotError(
        "INVALID_PATH",
        "MCP_SCREENSHOT_DIR must be absolute.",
      );
    this.root = resolve(root);
  }
  private async rootPath(create = false) {
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
    return realpath(this.root);
  }
  async save(
    data: Buffer,
    meta: CaptureMetadata,
    context: EvidenceContext = {},
  ): Promise<Evidence & { path: string; manifest_path: string }> {
    const actual = pngInfo(data);
    if (
      actual.sha256 !== meta.sha256 ||
      actual.width !== meta.width ||
      actual.height !== meta.height ||
      actual.bytes !== meta.bytes
    )
      throw new ScreenshotError(
        "INVALID_METADATA",
        "Capture metadata does not match the PNG.",
      );
    const root = await this.rootPath(true);
    const id = `${meta.captured_at.replace(/[:.]/g, "-")}_${randomUUID()}`;
    const temp = await mkdtemp(join(root, ".pending-"));
    const dir = join(root, id);
    const evidence: Evidence = {
      ...meta,
      schema_version: 1,
      id,
      context,
      association: context.exchange_id ? "caller_supplied_unverified" : "none",
      image: "screenshot.png",
    };
    try {
      manifestSchema.parse(evidence);
      await writeFile(join(temp, evidence.image), data, {
        flag: "wx",
        mode: 0o600,
      });
      await writeFile(
        join(temp, "evidence.json"),
        JSON.stringify(evidence, null, 2) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      // Publish the PNG + sidecar together. Readers never see a half-written evidence item.
      await rename(temp, dir);
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      throw error;
    }
    return {
      ...evidence,
      path: join(dir, evidence.image),
      manifest_path: join(dir, "evidence.json"),
    };
  }
  private validId(id: string) {
    if (!ID_PATTERN.test(id))
      throw new ScreenshotError(
        "INVALID_ID",
        "Use an evidence ID returned by this server.",
      );
  }
  async get(id: string, withImage = false, imageLimit = 64 * 1024 * 1024) {
    this.validId(id);
    const root = await this.rootPath(),
      directory = join(root, id);
    await assertDirectory(directory);
    const manifestPath = join(directory, "evidence.json");
    const evidence = parseManifest(
      await readBounded(manifestPath, 64 * 1024),
      id,
    );
    const path = join(directory, "screenshot.png");
    const { file, stat } = await openRegular(path, 64 * 1024 * 1024);
    let data: Buffer | undefined;
    let actual: {
      sha256: string;
      width: number;
      height: number;
      bytes: number;
    };
    try {
      const hash = createHash("sha256");
      const scratch = Buffer.alloc(64 * 1024);
      const chunks: Buffer[] = [];
      const header = Buffer.alloc(33);
      const tail = Buffer.alloc(12);
      let offset = 0;
      while (offset < stat.size) {
        const { bytesRead } = await file.read(
          scratch,
          0,
          Math.min(scratch.length, stat.size - offset),
          offset,
        );
        if (!bytesRead)
          throw new ScreenshotError(
            "FILE_CHANGED",
            "Evidence changed while hashing.",
          );
        const chunk = scratch.subarray(0, bytesRead);
        hash.update(chunk);
        if (offset < 33)
          chunk.copy(header, offset, 0, Math.min(bytesRead, 33 - offset));
        if (offset + bytesRead > stat.size - 12)
          chunk.copy(
            tail,
            Math.max(0, offset - (stat.size - 12)),
            Math.max(0, stat.size - 12 - offset),
          );
        if (withImage && stat.size <= imageLimit)
          chunks.push(Buffer.from(chunk));
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
          "Evidence changed while hashing.",
        );
      const info = pngEdges(header, tail);
      actual = {
        width: info.width,
        height: info.height,
        bytes: offset,
        sha256: hash.digest("hex"),
      };
      if (withImage && stat.size <= imageLimit) data = Buffer.concat(chunks);
    } finally {
      await file.close();
    }
    if (
      actual.sha256 !== evidence.sha256 ||
      actual.width !== evidence.width ||
      actual.height !== evidence.height ||
      actual.bytes !== evidence.bytes
    ) {
      throw new ScreenshotError(
        "INTEGRITY_MISMATCH",
        "PNG no longer matches its recorded SHA-256 and dimensions.",
      );
    }
    if (withImage && stat.size > imageLimit)
      evidence.warnings.push(
        "Inline image omitted: exceeds the inline limit; full PNG remains on disk.",
      );
    return {
      ...evidence,
      path,
      manifest_path: manifestPath,
      integrity: "verified" as const,
      ...(withImage ? { data } : {}),
    };
  }
  async list(
    options: {
      case_id?: string;
      exchange_id?: string;
      query?: string;
      after?: string;
      limit?: number;
    } = {},
  ) {
    if (options.after) this.validId(options.after);
    let root: string;
    try {
      root = await this.rootPath();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        items: [],
        next_cursor: null,
        skipped: [],
        ordering: "capture_time_ascending",
        integrity: "not_checked_use_get_evidence",
      };
    }
    const entries = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && ID_PATTERN.test(d.name))
      .map((d) => d.name)
      .sort()
      .filter((id) => !options.after || id > options.after);
    const items: {
      id: string;
      captured_at: string;
      label?: string;
      case_id?: string;
      exchange_id?: string;
      width: number;
      height: number;
    }[] = [];
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    let scanned = 0,
      cursor: string | undefined;
    const skipped: string[] = [];
    for (const id of entries) {
      if (scanned++ >= 500) break;
      cursor = id;
      try {
        this.validId(id);
        const dir = join(root, id);
        await assertDirectory(dir);
        const item = parseManifest(
          await readBounded(join(dir, "evidence.json"), 64 * 1024),
          id,
        );
        if (options.case_id && item.context?.case_id !== options.case_id)
          continue;
        if (
          options.exchange_id &&
          item.context?.exchange_id !== options.exchange_id
        )
          continue;
        if (
          options.query &&
          ![
            item.context?.label,
            item.context?.note,
            ...(item.context?.tags ?? []),
          ]
            .join(" ")
            .toLowerCase()
            .includes(options.query.toLowerCase())
        )
          continue;
        items.push({
          id,
          captured_at: item.captured_at,
          label: item.context?.label,
          case_id: item.context?.case_id,
          exchange_id: item.context?.exchange_id,
          width: item.width,
          height: item.height,
        });
        if (items.length === limit) break;
      } catch {
        skipped.push(id);
      }
    }
    return {
      items,
      next_cursor: cursor && entries.some((id) => id > cursor!) ? cursor : null,
      skipped,
      ordering: "capture_time_ascending",
      integrity: "not_checked_use_get_evidence",
    };
  }
  // Optional export is a copy. Canonical image and manifest always remain in the evidence store.
  async exportCopy(data: Buffer, requested: string): Promise<string> {
    if (!isAbsolute(requested) || !requested.toLowerCase().endsWith(".png"))
      throw new ScreenshotError(
        "INVALID_PATH",
        "save_path must be an absolute .png path inside MCP_SCREENSHOT_DIR.",
      );
    const root = await this.rootPath(true),
      path = resolve(requested);
    // Require an existing parent to avoid creating directories through symlinks.
    const parent = await realpath(dirname(path));
    const parentRel = relative(root, parent);
    if (parentRel.startsWith("..") || isAbsolute(parentRel))
      throw new ScreenshotError(
        "INVALID_PATH",
        "Export parent resolves outside the evidence directory.",
      );
    const final = join(parent, basename(path));
    const temp = await mkdtemp(join(parent, ".pending-export-"));
    const staged = join(temp, "screenshot.png");
    try {
      await writeFile(staged, data, { flag: "wx", mode: 0o600 });
      // Atomic no-overwrite publication; a failed export leaves no partial destination.
      await link(staged, final);
      return final;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}
