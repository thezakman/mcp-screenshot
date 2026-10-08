import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  writeFile,
  rename,
  rm,
  realpath,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { EvidenceStore } from "./evidence.js";
import { assertDirectory, readBounded } from "./storage.js";
import { digest } from "./reviews.js";
import { ScreenshotError } from "./errors.js";
import { CaptureQueue } from "./queue.js";
const exportQueue = new CaptureQueue(2, 30_000);
export const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const markdown = (value: unknown) =>
  escapeHtml(value).replace(/([\\`*_[\]#|])/g, "\\$1");
type ExportRecord = Awaited<ReturnType<EvidenceStore["get"]>>;
interface Asset {
  path: string;
  sha256: string;
  bytes: number;
}

export async function exportEvidence(
  store: EvidenceStore,
  ids: string[],
  title = "Evidence review",
  signal?: AbortSignal,
) {
  return exportQueue.run(async () => {
    if (!ids.length || ids.length > 50 || new Set(ids).size !== ids.length)
      throw new ScreenshotError(
        "INVALID_EXPORT",
        "Choose between 1 and 50 distinct evidence IDs.",
      );
    if (!title.trim() || title.length > 200)
      throw new ScreenshotError(
        "INVALID_EXPORT",
        "Title must contain 1 to 200 characters.",
      );
    const root = await realpath(store.root);
    const exportsDir = join(root, "exports");
    await mkdir(exportsDir, { recursive: true, mode: 0o700 });
    await assertDirectory(exportsDir);
    const temp = await mkdtemp(join(exportsDir, ".pending-"));
    const name = `review-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
    const destination = join(exportsDir, name);
    const assets: Asset[] = [];
    const records: Omit<ExportRecord, "data" | "path" | "manifest_path">[] = [];
    let totalBytes = 0;
    const write = async (relative: string, data: Buffer | string) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
      totalBytes += buffer.length;
      if (totalBytes > 256 * 1024 * 1024)
        throw new ScreenshotError(
          "EXPORT_TOO_LARGE",
          "Export exceeds 256 MiB. Select fewer evidence items.",
        );
      const path = join(temp, relative);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, buffer, { flag: "wx", mode: 0o600 });
      assets.push({
        path: relative,
        sha256: digest(buffer),
        bytes: buffer.length,
      });
    };
    try {
      for (const id of ids) {
        signal?.throwIfAborted();
        const { data, path, manifest_path, ...item } = await store.get(
          id,
          true,
          64 * 1024 * 1024,
          true,
        );
        if (!data)
          throw new ScreenshotError(
            "EXPORT_FAILED",
            "Verified source PNG was not available.",
          );
        const manifest = await readBounded(manifest_path, 64 * 1024);
        if (digest(manifest) !== item.manifest_sha256)
          throw new ScreenshotError(
            "FILE_CHANGED",
            "Manifest changed while exporting.",
          );
        await write(`evidence/${id}/screenshot.png`, data);
        await write(`evidence/${id}/evidence.json`, manifest);
        for (const review of item.review_history ?? []) {
          const event = await readBounded(
            join(dirname(path), "reviews", review.file),
            32 * 1024,
          );
          if (digest(event) !== review.event_sha256)
            throw new ScreenshotError(
              "FILE_CHANGED",
              "Review changed while exporting.",
            );
          await write(`evidence/${id}/reviews/${review.file}`, event);
        }
        records.push(item);
      }
      const exportedAt = new Date().toISOString();
      await write("index.html", renderHtml(title, exportedAt, records));
      await write("report.md", renderMarkdown(title, exportedAt, records));
      await write(
        "manifest.json",
        JSON.stringify(
          {
            schema_version: 1,
            title,
            exported_at: exportedAt,
            review_semantics:
              "Caller-supplied screenshot review; not validation of a vulnerability.",
            evidence: records,
            files: [...assets],
          },
          null,
          2,
        ) + "\n",
      );
      const sums =
        assets.map((a) => `${a.sha256}  ${a.path}`).join("\n") + "\n";
      if (totalBytes + Buffer.byteLength(sums) > 256 * 1024 * 1024)
        throw new ScreenshotError(
          "EXPORT_TOO_LARGE",
          "Export exceeds 256 MiB. Select fewer evidence items.",
        );
      await writeFile(join(temp, "SHA256SUMS"), sums, {
        flag: "wx",
        mode: 0o600,
      });
      signal?.throwIfAborted();
      await rename(temp, destination);
      return {
        path: destination,
        html_path: join(destination, "index.html"),
        markdown_path: join(destination, "report.md"),
        manifest_path: join(destination, "manifest.json"),
        checksums_path: join(destination, "SHA256SUMS"),
        count: records.length,
        bytes: totalBytes + Buffer.byteLength(sums),
        integrity: "all_sources_verified",
        review_snapshot: "per_item_at_export",
        sha256sums_sha256: digest(sums),
      };
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      throw error;
    }
  }, signal);
}
function renderHtml(
  title: string,
  at: string,
  records: Omit<ExportRecord, "data" | "path" | "manifest_path">[],
) {
  const counts = Object.entries(
    records.reduce<Record<string, number>>((out, item) => {
      out[item.review.status] = (out[item.review.status] ?? 0) + 1;
      return out;
    }, {}),
  );
  const cards = records
    .map((item, index) => {
      const label = item.context.label || `Evidence ${index + 1}`;
      const prefix = `evidence/${item.id}`;
      const details = [
        ["Captured (UTC)", item.captured_at],
        ["Application", item.window?.app ?? `Display ${item.display}`],
        ["Window title", item.window?.title ?? ""],
        ["Case", item.context.case_id ?? "—"],
        ["Exchange (unverified)", item.context.exchange_id ?? "—"],
        ["Dimensions", `${item.width} × ${item.height}`],
        ["SHA-256", item.sha256],
      ];
      return `<article id="e-${index + 1}"><header><span class="number">${String(index + 1).padStart(2, "0")}</span><h2>${escapeHtml(label)}</h2><span class="badge ${item.review.status}">${escapeHtml(item.review.status.replaceAll("_", " "))}</span></header><a class="image" href="${prefix}/screenshot.png"><img loading="lazy" src="${prefix}/screenshot.png" alt="${escapeHtml(label)}" width="${item.width}" height="${item.height}"></a><div class="body"><dl>${details
        .filter(([, v]) => v)
        .map(
          ([k, v]) =>
            `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`,
        )
        .join(
          "",
        )}</dl>${item.context.note ? `<h3>Capture note</h3><p class="note">${escapeHtml(item.context.note)}</p>` : ""}${item.context.tags?.length ? `<p class="muted">Tags: ${item.context.tags.map(escapeHtml).join(" · ")}</p>` : ""}${item.review.latest ? `<section class="review"><h3>Review · revision ${item.review.revision}</h3><p class="note">${escapeHtml(item.review.latest.note)}</p><p class="muted">${escapeHtml(item.review.latest.reviewer)} (caller-supplied) · ${escapeHtml(item.review.latest.reviewed_at)}</p></section>` : '<p class="muted">Awaiting review.</p>'}${item.warnings.map((w) => `<p class="warning">${escapeHtml(w)}</p>`).join("")}<footer><a href="${prefix}/screenshot.png">Original PNG</a><a href="${prefix}/evidence.json">Capture metadata</a><span>${escapeHtml(item.id)}</span></footer></div></article>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)}</title><style>
 :root{font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#202a38;background:#f3f5f8}*{box-sizing:border-box}body{margin:0}main{max-width:1160px;margin:auto;padding:40px 24px}h1{font-size:32px;line-height:1.2;letter-spacing:-.6px;margin:6px 0 14px}h2{font-size:19px;margin:0;flex:1}h3{font-size:15px;margin:16px 0 8px}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:1.5px;color:#536375}.muted,dt{color:#526274}p{margin:8px 0}.summary{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0 30px}.badge{display:inline-block;border:1px solid #d4dde8;border-radius:999px;padding:4px 12px;background:#eef2f7;font-size:13px}.accepted{color:#14532d;background:#dcfce7;border-color:#bbdfc8}.needs_recapture{color:#78350f;background:#fef3c7;border-color:#ebd99d}.rejected{color:#881337;background:#ffe4e6;border-color:#e8b6c0}article{background:white;border:1px solid #dbe1e9;border-radius:14px;margin:24px 0;overflow:hidden;break-inside:avoid}article header{display:flex;align-items:center;gap:14px;padding:18px 22px}.number{color:#617286;font-size:14px;font-variant-numeric:tabular-nums}.image{display:block;background:#e9edf2;padding:12px;border-block:1px solid #e3e8ef}.image img{display:block;width:100%;height:auto;max-height:650px;object-fit:contain}.body{padding:20px 22px}dl{display:grid;grid-template-columns:1fr 1fr;gap:14px 24px;margin:0}dt{font-size:12px;text-transform:uppercase;letter-spacing:.4px}dd{margin:4px 0 0;overflow-wrap:anywhere;font-size:14px}.note{white-space:pre-wrap;overflow-wrap:anywhere}.review{border-left:3px solid #798dae;padding:1px 16px;margin-top:20px}.warning{color:#78350f;background:#fff7df;padding:10px;border-radius:6px}footer{display:flex;gap:18px;flex-wrap:wrap;border-top:1px solid #e2e8f0;margin-top:20px;padding-top:14px;font-size:13px}footer span{color:#617286;overflow-wrap:anywhere}a{color:#1d4ed8;text-underline-offset:3px}a:focus-visible{outline:3px solid #d97706;outline-offset:4px}.intro{max-width:800px}.meta{font-size:13px}@media(max-width:680px){main{padding:24px 14px}dl{grid-template-columns:1fr}article header{flex-wrap:wrap}h1{font-size:26px}}@media print{body{background:white}main{max-width:none;padding:0}.image img{max-height:500px}.summary{margin-bottom:16px}a{color:inherit}}
 </style></head><body><main><div class="eyebrow">MCP Screenshot · local evidence</div><h1>${escapeHtml(title)}</h1><p class="intro muted">Original captures with integrity checks and a snapshot of their review state. Review labels describe the screenshot; they do not establish whether a vulnerability is confirmed.</p><p class="meta muted">Exported ${escapeHtml(at)} · ${records.length} evidence items · <a href="manifest.json">Manifest</a> · <a href="SHA256SUMS">Checksums</a> · <a href="report.md">Markdown</a></p><div class="summary">${counts.map(([status, count]) => `<span class="badge ${status}">${count} ${escapeHtml(status.replaceAll("_", " "))}</span>`).join("")}</div>${cards}<p class="muted meta">This report is offline and contains no external assets or scripts. Hashes detect changes relative to the supplied manifests; they are not digital signatures.</p></main></body></html>`;
}
function renderMarkdown(
  title: string,
  at: string,
  records: Omit<ExportRecord, "data" | "path" | "manifest_path">[],
) {
  return (
    `# ${markdown(title)}\n\nExported: ${at}\n\nReview labels concern screenshot quality, not vulnerability confirmation.\n\n` +
    records
      .map(
        (item, i) =>
          `## ${i + 1}. ${markdown(item.context.label || item.id)}\n\n- Status: ${item.review.status}\n- Captured: ${item.captured_at}\n- Case: ${markdown(item.context.case_id || "—")}\n- Exchange (caller-supplied): ${markdown(item.context.exchange_id || "—")}\n- SHA-256: \`${item.sha256}\`\n\n![Evidence ${i + 1}](evidence/${item.id}/screenshot.png)\n\n${markdown(item.context.note || "")}\n\n${item.review.latest ? `Review by ${markdown(item.review.latest.reviewer)} (caller-supplied): ${markdown(item.review.latest.note)}\n\n` : ""}[Original metadata](evidence/${item.id}/evidence.json)\n\n`,
      )
      .join("")
  );
}
