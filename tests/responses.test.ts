import { it, expect } from "vitest";
import { presentEvidence } from "../src/responses.js";
import { PNG, WINDOW } from "./helpers.js";
import { pngInfo } from "../src/evidence.js";
it("returns small summaries without discarding full metadata", () => {
  const item = {
    ...pngInfo(PNG),
    captured_at: new Date().toISOString(),
    mode: "window" as const,
    verification: "window_identity_and_bounds" as const,
    warnings: [],
    id: "local-fixture",
    window: WINDOW,
    context: { case_id: "case", label: "baseline", note: "a".repeat(4000) },
    path: "/local/screenshot.png",
  };
  const compact = JSON.stringify(presentEvidence(item));
  const full = JSON.stringify(presentEvidence(item, "full"));
  expect(compact.length).toBeLessThan(full.length / 3);
  expect(full).toContain("a".repeat(4000));
  expect(item.context.note.length).toBe(4000);
});

it("explains framing in summaries without modifying the manifest", () => {
  const base = {
    ...pngInfo(PNG),
    mode: "window" as const,
    captured_at: new Date().toISOString(),
    verification: "window_identity_and_bounds" as const,
    warnings: [],
  };
  const crop = {
    region: { x: 0, y: 0, width: 1, height: 1 },
    source_width: base.width,
    source_height: base.height,
  };
  const selection = {
    method: "user_confirmed_frozen_preview" as const,
    source_sha256: base.sha256,
    confirmed_at: base.captured_at,
  };
  for (const [item, framing] of [
    [base, "full_window"],
    [
      {
        ...base,
        mode: "display" as const,
        verification: "display_selected" as const,
      },
      "full_display",
    ],
    [{ ...base, crop }, "explicit_region"],
    [{ ...base, crop: { ...crop, profile: "saved" } }, "fixed_profile"],
    [{ ...base, crop, selection }, "confirmed_selection"],
  ] as const) {
    expect(presentEvidence(item)).toHaveProperty("framing", framing);
    expect(presentEvidence(item, "full")).not.toHaveProperty("framing");
  }
});
