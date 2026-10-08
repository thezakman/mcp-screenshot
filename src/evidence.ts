import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, readFile, readdir, rename, rm, realpath, lstat } from "node:fs/promises";
import { join, resolve, isAbsolute, relative, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { constants } from "node:fs";
import { ScreenshotError } from "./errors.js";
import type { WindowInfo } from "./native.js";
export const DEFAULT_ROOT = join(homedir(), "Pictures", "mcp-screenshot");
export interface EvidenceContext {
  case_id?: string; label?: string; note?: string; exchange_id?: string; tags?: string[];
}
export interface CaptureMetadata {
  captured_at: string; width: number; height: number; bytes: number; sha256: string;
  mode: "window" | "display"; window?: WindowInfo; display?: number;
  verification: "window_identity_and_bounds" | "display_selected";
  warnings: string[];
}
export interface Evidence extends CaptureMetadata {
  schema_version: 1; id: string; context: EvidenceContext;
  association: "caller_supplied_unverified" | "none";
  image: string;
}
export function pngInfo(data: Buffer) {
  if (data.length < 45 || !data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || data.toString("ascii",12,16) !== "IHDR" || data.readUInt32BE(8) !== 13 || data.toString("ascii",data.length-8,data.length-4) !== "IEND") {
    throw new ScreenshotError("INVALID_IMAGE", "Capture did not produce a complete PNG.");
  }
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (!width || !height || width * height > 150_000_000) throw new ScreenshotError("INVALID_IMAGE", "PNG dimensions are invalid or exceed 150 megapixels.");
  return { width, height, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
}
export class EvidenceStore {
  readonly root: string;
  constructor(root = process.env.MCP_SCREENSHOT_DIR ?? DEFAULT_ROOT) {
    if (!isAbsolute(root)) throw new ScreenshotError("INVALID_PATH", "MCP_SCREENSHOT_DIR must be absolute.");
    this.root = resolve(root);
  }
  private async rootPath() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    return realpath(this.root);
  }
  async save(data: Buffer, meta: CaptureMetadata, context: EvidenceContext = {}): Promise<Evidence & { path: string; manifest_path: string }> {
    const root = await this.rootPath();
    const id = `${meta.captured_at.replace(/[:.]/g,"-")}_${randomUUID()}`;
    const temp = await mkdtemp(join(root, ".pending-"));
    const dir = join(root, id);
    const evidence: Evidence = { ...meta, schema_version: 1, id, context,
      association: context.exchange_id ? "caller_supplied_unverified" : "none", image: "screenshot.png" };
    try {
      await writeFile(join(temp, evidence.image), data, { flag: "wx", mode: 0o600 });
      await writeFile(join(temp, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      // Publish the PNG + sidecar together. Readers never see a half-written evidence item.
      await rename(temp, dir);
    } catch (error) { await rm(temp, { recursive: true, force: true }); throw error; }
    return { ...evidence, path: join(dir, evidence.image), manifest_path: join(dir, "evidence.json") };
  }
  private validId(id: string) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f-]{36}$/.test(id)) throw new ScreenshotError("INVALID_ID", "Use an evidence ID returned by this server.");
  }
  async get(id: string, withImage = false) {
    this.validId(id);
    const root = await this.rootPath(), directory = join(root, id);
    if ((await lstat(directory)).isSymbolicLink()) throw new ScreenshotError("INVALID_PATH", "Evidence directories cannot be symlinks.");
    const manifestPath = join(directory, "evidence.json");
    const readBounded = async (path: string, limit: number) => {
      const { open } = await import("node:fs/promises");
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > limit) throw new ScreenshotError("EVIDENCE_TOO_LARGE", "Evidence exceeds its size limit.");
        return await file.readFile();
      } finally { await file.close(); }
    };
    const evidence = JSON.parse((await readBounded(manifestPath, 64 * 1024)).toString()) as Evidence;
    if (evidence.schema_version !== 1 || evidence.id !== id || evidence.image !== "screenshot.png") throw new ScreenshotError("INVALID_MANIFEST", "Invalid evidence manifest.");
    const path = join(directory, "screenshot.png");
    const data = await readBounded(path, 64 * 1024 * 1024);
    const actual = pngInfo(data);
    if (actual.sha256 !== evidence.sha256 || actual.width !== evidence.width || actual.height !== evidence.height || actual.bytes !== evidence.bytes) {
      throw new ScreenshotError("INTEGRITY_MISMATCH", "PNG no longer matches its recorded SHA-256 and dimensions.");
    }
    return { ...evidence, path, manifest_path: manifestPath, integrity: "verified" as const, ...(withImage ? { data } : {}) };
  }
  async list(options: { case_id?: string; after?: string; limit?: number } = {}) {
    if (options.after) this.validId(options.after);
    const root = await this.rootPath();
    const entries = (await readdir(root, { withFileTypes: true })).filter(d => d.isDirectory() && !d.name.startsWith("."))
      .map(d => d.name).sort().filter(id => !options.after || id > options.after);
    const items: { id: string; captured_at: string; label?: string; case_id?: string; exchange_id?: string; width: number; height: number }[] = [];
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    let scanned = 0, cursor: string | undefined;
    const skipped: string[] = [];
    for (const id of entries) {
      if (scanned++ >= 500) break;
      cursor = id;
      try {
        this.validId(id);
        const file = join(root,id,"evidence.json");
        const stat = await lstat(file);
        if (!stat.isFile() || stat.size > 64*1024) throw new Error("Invalid manifest");
        const item = JSON.parse(await readFile(file, "utf8")) as Evidence;
        if (item.id !== id || item.schema_version !== 1) throw new Error("Invalid manifest");
        if (options.case_id && item.context?.case_id !== options.case_id) continue;
        items.push({ id, captured_at: item.captured_at, label: item.context?.label, case_id: item.context?.case_id, exchange_id: item.context?.exchange_id, width:item.width, height:item.height });
        if (items.length === limit) break;
      } catch { skipped.push(id); }
    }
    return { items, next_cursor: cursor && entries.some(id => id > cursor!) ? cursor : null, skipped,
      ordering: "capture_time_ascending", integrity: "not_checked_use_get_evidence" };
  }
  // Optional export is a copy. Canonical image and manifest always remain in the evidence store.
  async exportCopy(data: Buffer, requested: string): Promise<string> {
    if (!isAbsolute(requested) || !requested.toLowerCase().endsWith(".png")) throw new ScreenshotError("INVALID_PATH", "save_path must be an absolute .png path inside MCP_SCREENSHOT_DIR.");
    const root = await this.rootPath(), path = resolve(requested);
    // Require an existing parent to avoid creating directories through symlinks.
    const parent = await realpath(dirname(path));
    const parentRel = relative(root, parent);
    if (parentRel.startsWith("..") || isAbsolute(parentRel)) throw new ScreenshotError("INVALID_PATH", "Export parent resolves outside the evidence directory.");
    const final = join(parent, basename(path));
    await writeFile(final, data, { flag: "wx", mode: 0o600 });
    return final;
  }
}
