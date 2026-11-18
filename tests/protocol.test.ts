import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { CaptureService } from "../src/capture.js";
import { EvidenceStore } from "../src/evidence.js";
import { PNG, WINDOW } from "./helpers.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("MCP protocol", () => {
  it("advertises callable tools, returns compact metadata, and retrieves saved evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-protocol-"));
    const backend = {
      windows: vi.fn(async () => [WINDOW]),
      status: vi.fn(async () => ({
        platform: "darwin",
        screenRecording: true,
        accessibility: false,
      })),
      displays: vi.fn(async () => []),
      capture: vi.fn(async () => PNG),
    };
    const server = createServer(
      new CaptureService(new EvidenceStore(root), backend, "", root),
      "0.1.0",
    );
    const client = new Client({ name: "local-test", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await client.connect(b);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(
        [
          "capture_burp_screenshot",
          "capture_frontmost_window",
          "select_capture_region",
          "list_capture_profiles",
          "delete_capture_profile",
          "save_capture_profile",
          "capture_window",
          "review_evidence",
          "export_evidence",
          "get_capture_status",
          "get_capture_guide",
          "get_evidence",
          "list_displays",
          "list_evidence",
          "list_windows",
          "screenshot_app",
          "take_screenshot",
        ].sort(),
      );
      const selectorSchema = tools.find(
        (tool) => tool.name === "select_capture_region",
      )!;
      for (const field of [
        "label",
        "note",
        "tags",
        "exchange_id",
        "description",
      ])
        expect(selectorSchema.inputSchema.properties).toHaveProperty(field);
      expect(client.getInstructions()).toContain(
        "Never claim a batch complete",
      );
      const guideResult = await client.callTool({
        name: "get_capture_guide",
        arguments: {},
      });
      const guide = JSON.parse(
        (guideResult.content as { text: string }[])[0].text,
      );
      expect(guide.workflow.join(" ")).toContain("SAME MCP server connection");
      expect(guide.fixed_profiles).toContain("fixed coordinates only");
      expect(backend.capture).not.toHaveBeenCalled();
      const selector = tools.find((t) => t.name === "select_capture_region")!;
      expect(selector.inputSchema.properties).toHaveProperty("suggestion");
      expect(selector.inputSchema.properties).toHaveProperty("request");
      expect(
        tools.find((t) => t.name === "capture_window")!.inputSchema.properties,
      ).toHaveProperty("reject_same_as");
      const result = await client.callTool({
        name: "capture_burp_screenshot",
        arguments: { case_id: "local-fixture" },
      });
      expect(result.isError).not.toBe(true);
      const content = result.content as { type: string; text: string }[];
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe("text");
      const record = JSON.parse(content[0].text);
      expect(record.id).toBeTruthy();
      const retrieved = await client.callTool({
        name: "get_evidence",
        arguments: { id: record.id, include_image: true },
      });
      expect(retrieved.isError).not.toBe(true);
      expect(
        (retrieved.content as { type: string }[]).map((c) => c.type),
      ).toEqual(["text", "image"]);
      expect(backend.capture).toHaveBeenCalledTimes(1);
      const reviewed = await client.callTool({
        name: "review_evidence",
        arguments: {
          id: record.id,
          expected_revision: 0,
          status: "accepted",
          reviewer: "local test",
          note: "Fixture review",
        },
      });
      expect(reviewed.isError).not.toBe(true);
      const reviewSummary = JSON.parse(
        (reviewed.content as { text: string }[])[0].text,
      );
      expect(reviewSummary.review.revision).toBe(1);
      expect(reviewSummary.review.latest).toBeUndefined();
      expect(JSON.stringify(reviewSummary)).not.toContain("Fixture review");
      const status = await client.callTool({
        name: "get_capture_status",
        arguments: {},
      });
      expect(
        JSON.parse((status.content as { text: string }[])[0].text).version,
      ).toBe("0.1.0");
      const history = await client.callTool({
        name: "get_evidence",
        arguments: { id: record.id, include_review_history: true },
      });
      expect(
        JSON.parse((history.content as { text: string }[])[0].text)
          .review_history,
      ).toHaveLength(1);
      const exported = await client.callTool({
        name: "export_evidence",
        arguments: { ids: [record.id], title: "Protocol fixture" },
      });
      expect(exported.isError).not.toBe(true);
      expect(backend.capture).toHaveBeenCalledTimes(1);
      const invalid = await client.callTool({
        name: "capture_window",
        arguments: { window_id: 999 },
      });
      expect(invalid.isError).toBe(true);
      expect(
        JSON.parse((invalid.content as { text: string }[])[0].text).error.code,
      ).toBe("WINDOW_NOT_FOUND");
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
