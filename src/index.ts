import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { CaptureService } from "./capture.js";
import { failure } from "./errors.js";
declare const __VERSION__: string;
const version = typeof __VERSION__ === "string" ? __VERSION__ : "dev";
try {
  if (process.argv.includes("--version")) console.log(version);
  else if (process.argv.includes("--doctor")) console.log(JSON.stringify(await new CaptureService().status(), null, 2));
  else await createServer(undefined, version).connect(new StdioServerTransport());
} catch (error) {
  console.error(JSON.stringify({ error: failure(error) }));
  process.exitCode = 1;
}
