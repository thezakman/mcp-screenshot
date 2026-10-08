import type { WindowInfo } from "../src/native.js";
// Lossless 1x1 PNG fixture, never sourced from the user's screen.
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a21sAAAAASUVORK5CYII=",
  "base64",
);
export const WINDOW: WindowInfo = {
  id: 42,
  pid: 50,
  app: "Burp Suite Professional",
  bundleId: "com.portswigger.burp",
  title: "Burp Suite - local fixture",
  bounds: { x: 0, y: 0, width: 800, height: 600 },
};
