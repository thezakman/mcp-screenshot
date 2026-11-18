import { configuredRoot } from "./settings.js";
import { readReviews, appendReview, digest } from "./reviews.js";
import type { reviewInput } from "./reviews.js";
import type { z } from "zod";
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
import {
  parseManifest,
  manifestSchema,
  MAX_MANIFEST_BYTES,
} from "./manifest.js";
import { ScreenshotError } from "./errors.js";
import type { WindowInfo } from "./native.js";
async function resolveManifest(directory: string) {
  const path = join(directory, "metadata.json");
  try {
    await lstat(path);
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(directory, "evidence.json");
  }
}
const ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f-]{36}$/;
const CAPTURE_FOLDER =
  /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}(?:-[2-9]\d*|-1\d+)?$/;
export function captureFolder(at: string) {
  return new Date(at)
    .toISOString()
    .replace("T", "_")
    .replace(/[:.]/g, "-")
    .replace(/Z$/, "");
}
export const DEFAULT_ROOT = join(homedir(), "Pictures", "mcp-screenshot");
export interface EvidenceContext {
  description?: { text: string; language: string; source: "ai" | "user" };
  case_id?: string;
  label?: string;
  note?: string;
  exchange_id?: string;
  source_item_id?: string;
  tags?: string[];
}
export interface CaptureMetadata {
  pre_exif_sha256?: string;
  sensitive?: boolean | null;
  redactions?: import("./redaction.js").Mask[];
  original?: { image: "screenshot_original.png"; sha256: string };
  selection?: {
    method: "user_confirmed_frozen_preview";
    source_sha256: string;
    confirmed_at: string;
  };
  crop?: {
    region: import("./regions.js").Region;
    source_width: number;
    source_height: number;
    profile?: string;
  };
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
export function projectFolder(caseId?: string) {
  if (!caseId?.trim())
    return `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID()}`;
  const value = caseId.trim();
  if (ID_PATTERN.test(value)) return value;
  const slug =
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 70) || "projeto";
  if (slug === value && !["sem-projeto", "profiles", "exports"].includes(slug))
    return slug;
  return `${slug}-${createHash("sha256").update(value).digest("hex").slice(0, 10)}`;
}
export class EvidenceStore {
  root: string;
  constructor(root = configuredRoot()) {
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
    original?: Buffer,
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
    const app = meta.window?.app ?? "desktop";
    const slug = /burp/i.test(app)
      ? "burp-suite"
      : /chrome/i.test(app)
        ? "chrome"
        : /iterm/i.test(app)
          ? "iterm2"
          : app
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "")
              .slice(0, 80) || "application";
    if (!context.case_id?.trim())
      context = { ...context, case_id: projectFolder() };
    const project = projectFolder(context.case_id);
    const folder = join(root, project, slug);
    await mkdir(join(root, project), { recursive: true, mode: 0o700 });
    await assertDirectory(join(root, project));
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await assertDirectory(folder);
    const temp = await mkdtemp(join(folder, ".pending-"));
    const stagedApp = temp;
    let dir: string | undefined;
    const evidence: Evidence = {
      ...meta,
      schema_version: 1,
      id,
      context,
      association: context.exchange_id ? "caller_supplied_unverified" : "none",
      sensitive: meta.sensitive ?? null,
      image: meta.redactions?.length
        ? "screenshot_redacted.png"
        : "screenshot.png",
      ...(original
        ? {
            original: {
              image: "screenshot_original.png",
              sha256: pngInfo(original).sha256,
            },
          }
        : {}),
    };
    try {
      const validated = manifestSchema.parse(evidence);
      const manifest = JSON.stringify(validated, null, 2) + "\n";
      if (Buffer.byteLength(manifest, "utf8") > MAX_MANIFEST_BYTES)
        throw new ScreenshotError(
          "MANIFEST_TOO_LARGE",
          "Evidence metadata exceeds 64 KiB. Shorten notes, titles or warnings before retrying.",
        );

      await writeFile(join(stagedApp, evidence.image), data, {
        flag: "wx",
        mode: 0o600,
      });
      if (original && evidence.original)
        await writeFile(join(stagedApp, evidence.original.image), original, {
          flag: "wx",
          mode: 0o600,
        });
      await writeFile(join(stagedApp, "metadata.json"), manifest, {
        flag: "wx",
        mode: 0o600,
      });
      // Exclusive mkdir reserves a timestamp even across separate server processes.
      const base = captureFolder(meta.captured_at);
      for (let suffix = 1; suffix <= 10000; suffix++) {
        const candidate = join(
          folder,
          base + (suffix === 1 ? "" : `-${suffix}`),
        );
        try {
          await mkdir(candidate, { mode: 0o700 });
          dir = candidate;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      if (!dir) throw new Error("CAPTURE_NAME_EXHAUSTED");
      await link(join(temp, evidence.image), join(dir, evidence.image));
      if (evidence.original)
        await link(
          join(temp, evidence.original.image),
          join(dir, evidence.original.image),
        );
      // The manifest is the commit marker: readers ignore folders without it.
      await link(join(temp, "metadata.json"), join(dir, "metadata.json"));
    } catch (error) {
      if (dir) await rm(dir, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    return {
      ...evidence,
      path: join(dir!, evidence.image),
      manifest_path: join(dir!, "metadata.json"),
    };
  }
  private async locations(root: string) {
    const result = new Map<string, string>();
    const ambiguous = new Set<string>();
    const warnings: { path: string; code: string }[] = [];
    const register = (id: string, path: string) => {
      if (result.has(id) && result.get(id) !== path) ambiguous.add(id);
      else result.set(id, path);
    };
    // Bounded depth covers flat, app/ID, ID/app, and project/app/ID layouts.
    const visit = async (directory: string, depth: number) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const path = join(directory, entry.name);
        if (CAPTURE_FOLDER.test(entry.name)) {
          try {
            const raw = JSON.parse(
              (
                await readBounded(
                  await resolveManifest(path),
                  MAX_MANIFEST_BYTES,
                )
              ).toString(),
            );
            if (
              raw &&
              typeof raw === "object" &&
              typeof raw.id === "string" &&
              ID_PATTERN.test(raw.id)
            )
              register(raw.id, path);
            else
              warnings.push({
                path: relative(root, path),
                code: "INVALID_MANIFEST",
              });
          } catch (error) {
            // Missing commit markers are incomplete saves, not evidence.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
              warnings.push({
                path: relative(root, path),
                code:
                  error instanceof ScreenshotError
                    ? error.code
                    : "INVALID_MANIFEST",
              });
          }
        } else if (ID_PATTERN.test(entry.name)) {
          const children = await readdir(path, { withFileTypes: true });
          if (
            children.some(
              (c) =>
                c.isFile() &&
                ["metadata.json", "evidence.json"].includes(c.name),
            )
          )
            register(entry.name, path);
          else {
            const apps = children.filter(
              (c) => c.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(c.name),
            );
            const legacyApps: string[] = [];
            for (const app of apps) {
              const entries = await readdir(join(path, app.name), {
                withFileTypes: true,
              });
              if (
                entries.some(
                  (c) =>
                    c.isFile() &&
                    ["metadata.json", "evidence.json"].includes(c.name),
                )
              ) {
                legacyApps.push(join(path, app.name));
              }
            }
            if (legacyApps.length) {
              for (const app of legacyApps) register(entry.name, app);
            } else if (depth < 2) await visit(path, depth + 1);
            else register(entry.name, path);
          }
        } else if (
          depth < 2 &&
          /^[a-z0-9][a-z0-9-]*$/.test(entry.name) &&
          !(depth === 0 && ["profiles", "exports"].includes(entry.name))
        ) {
          await visit(path, depth + 1);
        }
      }
    };
    await visit(root, 0);
    return { locations: result, ambiguous, warnings };
  }
  private validId(id: string) {
    if (!ID_PATTERN.test(id))
      throw new ScreenshotError(
        "INVALID_ID",
        "Use an evidence ID returned by this server.",
      );
  }
  async get(
    id: string,
    withImage = false,
    imageLimit = 64 * 1024 * 1024,
    includeHistory = false,
  ) {
    this.validId(id);
    const root = await this.rootPath();
    const inventory = await this.locations(root);
    if (inventory.ambiguous.has(id))
      throw new ScreenshotError(
        "AMBIGUOUS_EVIDENCE",
        "Multiple evidence folders claim ID " +
          id +
          ". Resolve the duplicate folders before reading, reviewing or exporting this ID; no copy was chosen automatically.",
      );
    const directory = inventory.locations.get(id) ?? join(root, id);
    await assertDirectory(directory);
    const manifestPath = await resolveManifest(directory);
    const manifestBytes = await readBounded(manifestPath, MAX_MANIFEST_BYTES);
    const evidence = parseManifest(manifestBytes, id);
    const path = join(directory, evidence.image);
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
    const { review, history } = await readReviews(
      directory,
      id,
      evidence.sha256,
    );
    return {
      ...evidence,
      review,
      ...(includeHistory ? { review_history: history } : {}),
      manifest_sha256: digest(manifestBytes),
      path,
      manifest_path: manifestPath,
      integrity: "verified" as const,
      ...(withImage ? { data } : {}),
    };
  }
  async review(id: string, input: z.infer<typeof reviewInput>) {
    const item = await this.get(id);
    return {
      id,
      review: await appendReview(dirname(item.path), id, item.sha256, input),
    };
  }
  async list(
    options: {
      review_status?:
        "unreviewed" | "accepted" | "needs_recapture" | "rejected";
      case_id?: string;
      exchange_id?: string;
      source_item_id?: string;
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
        discovery_warnings: [],
        ambiguous_ids: [],
        discovery_complete: true,
        ordering: "capture_time_ascending",
        integrity: "not_checked_use_get_evidence",
      };
    }
    const { locations, ambiguous, warnings } = await this.locations(root);
    const entries = [...locations.keys()]
      .sort()
      .filter((id) => !options.after || id > options.after);
    const items: {
      id: string;
      captured_at: string;
      label?: string;
      case_id?: string;
      exchange_id?: string;
      source_item_id?: string;
      width: number;
      height: number;
      review_status: string;
      review_revision: number;
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
        if (ambiguous.has(id)) {
          skipped.push(id);
          continue;
        }
        const dir = locations.get(id)!;
        await assertDirectory(dir);
        const item = parseManifest(
          await readBounded(await resolveManifest(dir), MAX_MANIFEST_BYTES),
          id,
        );
        if (
          options.source_item_id &&
          item.context.source_item_id !== options.source_item_id
        )
          continue;
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
            item.context?.description?.text,
            ...(item.context?.tags ?? []),
          ]
            .join(" ")
            .toLowerCase()
            .includes(options.query.toLowerCase())
        )
          continue;
        const { review } = await readReviews(dir, id, item.sha256);
        if (options.review_status && review.status !== options.review_status)
          continue;
        items.push({
          review_status: review.status,
          review_revision: review.revision,
          id,
          captured_at: item.captured_at,
          label: item.context?.label,
          case_id: item.context?.case_id,
          exchange_id: item.context?.exchange_id,
          source_item_id: item.context?.source_item_id,
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
      discovery_warnings: warnings,
      ambiguous_ids: [...ambiguous].sort(),
      discovery_complete:
        warnings.length === 0 && ambiguous.size === 0 && skipped.length === 0,
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
