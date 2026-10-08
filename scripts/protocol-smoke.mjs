// Platform-independent stdio handshake; no native helper or screenshot permission needed.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
const client = new Client({ name: "protocol-smoke", version: "1.0.0" });
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
      stderr: "inherit",
    }),
  );
  const { tools } = await client.listTools();
  assert.equal(tools.length, 11);
  assert.ok(tools.some((t) => t.name === "capture_burp_screenshot"));
  assert.ok(
    tools
      .filter(
        (t) =>
          t.name.startsWith("capture_") ||
          t.name === "screenshot_app" ||
          t.name === "take_screenshot",
      )
      .every((t) => t.annotations.readOnlyHint === false),
  );
  console.log("stdio handshake and 11 tool schemas verified");
} finally {
  await client.close();
}
