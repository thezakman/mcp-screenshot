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
