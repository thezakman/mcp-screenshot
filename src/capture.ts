import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
  listWindows,
  probeDisplays,
  captureStatus,
  selectWindow,
  sameWindow,
  windowToken,
  type WindowInfo,
  type CaptureStatus,
  type DisplayInfo,
} from "./native.js";
import { CaptureQueue } from "./queue.js";
import {
  EvidenceStore,
  pngInfo,
  type EvidenceContext,
  type CaptureMetadata,
} from "./evidence.js";
import { ScreenshotError } from "./errors.js";
const exec = promisify(execFile);
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export interface CaptureOptions extends EvidenceContext {
  window_id?: number;
  app_name?: string;
  title?: string;
  burp?: boolean;
  display?: number;
  include_image?: boolean;
  save_path?: string;
  persist?: boolean;
  expected_window_token?: string;
}
export interface Backend {
  windows(): Promise<WindowInfo[]>;
  status(): Promise<CaptureStatus>;
  displays(): Promise<DisplayInfo[]>;
  capture(args: string[], signal?: AbortSignal): Promise<Buffer>;
}
export const systemBackend: Backend = {
  windows: listWindows,
  status: captureStatus,
  displays: probeDisplays,
  async capture(args, signal) {
    const directory = await mkdtemp(join(tmpdir(), "mcp-screenshot-"));
    const file = join(directory, "capture.png");
    try {
      await exec(
        "/usr/sbin/screencapture",
        ["-x", "-t", "png", ...args, file],
        {
          timeout: 10_000,
          signal,
          maxBuffer: 1024 * 1024,
          killSignal: "SIGKILL",
        },
      );
      const info = await stat(file);
      if (info.size > 64 * 1024 * 1024)
        throw new ScreenshotError("IMAGE_TOO_LARGE", "Capture exceeds 64 MiB.");
      return await readFile(file);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
};
export class CaptureService {
  readonly queue = new CaptureQueue();
  readonly blocked: string[];
  constructor(
    readonly store = new EvidenceStore(),
    private backend: Backend = systemBackend,
    blocked = process.env.BLOCKED_APPS ?? "",
  ) {
    this.blocked = blocked
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);
  }
  isBlocked(w: WindowInfo) {
    return this.blocked.some(
      (v) =>
        w.app.toLowerCase().includes(v) || w.bundleId.toLowerCase().includes(v),
    );
  }
  async windows(filter: { app_name?: string; title?: string } = {}) {
    return (await this.backend.windows()).filter(
      (w) =>
        !this.isBlocked(w) &&
        (!filter.app_name ||
          w.app.toLowerCase().includes(filter.app_name.toLowerCase()) ||
          w.bundleId.toLowerCase().includes(filter.app_name.toLowerCase())) &&
        (!filter.title ||
          w.title.toLowerCase().includes(filter.title.toLowerCase())),
    );
  }
  async status() {
    return {
      ...(await this.backend.status()),
      evidence_directory: this.store.root,
      pending_captures: this.queue.size,
      max_pending_captures: 8,
      default_include_image: false,
      default_persist: true,
      blocked_apps: this.blocked,
    };
  }
  async displays() {
    return this.backend.displays();
  }
  async capture(options: CaptureOptions, signal?: AbortSignal) {
    return this.queue.run(async () => {
      if (options.persist === false && !options.include_image)
        throw new ScreenshotError(
          "NO_OUTPUT",
          "Ephemeral captures require include_image=true.",
        );
      if (options.persist === false && options.save_path)
        throw new ScreenshotError(
          "INVALID_OPTIONS",
          "save_path requires persist=true.",
        );
      if (
        options.display !== undefined &&
        (options.window_id !== undefined ||
          options.app_name ||
          options.title ||
          options.burp)
      )
        throw new ScreenshotError(
          "INVALID_OPTIONS",
          "Choose a display or a window, not both.",
        );
      if (!(await this.backend.status()).screenRecording)
        throw new ScreenshotError(
          "SCREEN_RECORDING_REQUIRED",
          "Allow Screen & System Audio Recording for the app running this MCP in macOS System Settings, then restart that app.",
        );
      let window: WindowInfo | undefined;
      const warnings: string[] = [];
      if (options.display === undefined) {
        if (!options.window_id && !options.app_name && !options.burp)
          throw new ScreenshotError(
            "WINDOW_REQUIRED",
            "Use list_windows and select window_id or an exact app_name.",
          );
        window = selectWindow(await this.backend.windows(), options);
        if (
          options.expected_window_token &&
          windowToken(window) !== options.expected_window_token
        )
          throw new ScreenshotError(
            "STALE_WINDOW",
            "The selected window changed since list_windows. Refresh the list before capturing.",
            true,
          );
        if (this.isBlocked(window))
          throw new ScreenshotError(
            "APP_BLOCKED",
            "This application is excluded by BLOCKED_APPS.",
          );
        // Wait for a stable identity/bounds; this is not a guarantee that page content has loaded.
        const deadline = Date.now() + 3_000;
        let ready = false;
        while (Date.now() < deadline) {
          await sleep(150, undefined, { signal });
          const next = selectWindow(await this.backend.windows(), {
            window_id: window.id,
          });
          if (
            next.pid !== window.pid ||
            next.app !== window.app ||
            next.bundleId !== window.bundleId
          )
            throw new ScreenshotError(
              "WINDOW_CHANGED",
              "Window ownership changed before capture.",
            );
          if (sameWindow(window, next)) {
            ready = true;
            break;
          }
          window = next;
        }
        selectWindow([window], options);
        if (
          options.expected_window_token &&
          windowToken(window) !== options.expected_window_token
        )
          throw new ScreenshotError(
            "STALE_WINDOW",
            "The selected window changed while waiting. Refresh list_windows.",
            true,
          );
        if (!ready)
          throw new ScreenshotError(
            "WINDOW_UNSTABLE",
            "Window title or bounds kept changing. Retry when the window settles.",
            true,
          );
      } else {
        if (this.blocked.length)
          throw new ScreenshotError(
            "DISPLAY_CAPTURE_DISABLED",
            "Display capture is disabled when BLOCKED_APPS is set; select an allowed window instead.",
          );
        if (
          !(await this.backend.displays()).some(
            (d) => d.display === options.display,
          )
        )
          throw new ScreenshotError(
            "DISPLAY_NOT_FOUND",
            "Select a display returned by list_displays.",
          );
        warnings.push(
          "Whole-display capture includes every visible application on that display.",
        );
      }
      const capturedAt = new Date().toISOString();
      const data = await this.backend.capture(
        window
          ? ["-o", "-l", String(window.id)]
          : ["-D", String(options.display)],
        signal,
      );
      if (window) {
        const after = selectWindow(await this.backend.windows(), {
          window_id: window.id,
        });
        if (!sameWindow(window, after))
          throw new ScreenshotError(
            "WINDOW_CHANGED",
            "Window changed during capture. Image discarded; retry.",
            true,
          );
      }
      signal?.throwIfAborted();
      const meta: CaptureMetadata = {
        ...pngInfo(data),
        captured_at: capturedAt,
        mode: window ? "window" : "display",
        ...(window ? { window } : { display: options.display }),
        verification: window
          ? "window_identity_and_bounds"
          : "display_selected",
        warnings,
      };
      const context: EvidenceContext = Object.fromEntries(
        Object.entries({
          case_id: options.case_id,
          label: options.label,
          note: options.note,
          exchange_id: options.exchange_id,
          tags: options.tags,
        }).filter(([, v]) => v !== undefined),
      );
      if (options.persist === false && data.length > MAX_IMAGE_BYTES)
        throw new ScreenshotError(
          "IMAGE_TOO_LARGE",
          "Inline image exceeds 5 MiB. Retry with persist=true to save it losslessly.",
        );
      const result =
        options.persist === false
          ? { ...meta, persisted: false }
          : {
              ...(await this.store.save(data, meta, context)),
              persisted: true,
            };
      let exportedPath: string | undefined;
      if (options.save_path) {
        try {
          exportedPath = await this.store.exportCopy(data, options.save_path);
        } catch (error) {
          result.warnings.push(
            `Export failed; canonical evidence remains saved: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
      const inline = options.include_image && data.length <= MAX_IMAGE_BYTES;
      if (options.include_image && !inline)
        result.warnings.push(
          "Inline image omitted: exceeds 5 MiB. The full PNG is saved on disk.",
        );
      return {
        metadata: {
          ...result,
          ...(exportedPath ? { exported_path: exportedPath } : {}),
          image_included: !!inline,
        },
        ...(inline ? { image: data.toString("base64") } : {}),
      };
    }, signal);
  }
}
