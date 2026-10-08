// Real stdio MCP smoke test. Capture is opt-in; output never prints screenshot contents.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
const client = new Client({ name: "screenshot-smoke", version: "1.0.0" });
const env = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => typeof v === "string"),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
  env,
  stderr: "inherit",
});
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const payload = JSON.parse(
    result.content.find((c) => c.type === "text").text,
  );
  if (result.isError) throw new Error(JSON.stringify(payload));
  return payload;
};
try {
  await client.connect(transport);
  const catalog = await client.listTools();
  const status = await call("get_capture_status");
  console.log(
    JSON.stringify(
      { tools: catalog.tools.map((t) => t.name), status },
      null,
      2,
    ),
  );
  if (process.argv.includes("--capture-burp")) {
    const { windows } = await call("list_windows");
    const burp = windows.filter(
      (w) =>
        /^burp suite\b/i.test(w.app) ||
        (w.app.toLowerCase() === "java" && /^Burp Suite\b/i.test(w.title)),
    );
    const selected = process.argv
      .find((a) => a.startsWith("--window-id="))
      ?.split("=")[1];
    if (burp.length !== 1 && !selected)
      throw new Error(
        `Found ${burp.length} Burp windows; rerun with --window-id=<id>. Candidates: ${burp.map((w) => w.id).join(", ")}`,
      );
    const capture = await call("capture_burp_screenshot", {
      window_id: selected ? Number(selected) : burp[0].id,
      case_id: "local-smoke",
      label: "Manual validation of screenshot MCP",
      include_image: false,
    });
    const restored = await call("get_evidence", { id: capture.id });
    console.log(
      JSON.stringify(
        {
          id: capture.id,
          path: capture.path,
          width: capture.width,
          height: capture.height,
          sha256: capture.sha256,
          integrity: restored.integrity,
          image_included: capture.image_included,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await client.close();
}
