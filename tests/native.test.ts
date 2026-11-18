import { describe, it, expect } from "vitest";
import { selectWindow, sameWindow, windowToken } from "../src/native.js";
import { WINDOW } from "./helpers.js";
describe("window identity", () => {
  it("rejects ambiguous apps and requires a unique window", () => {
    expect(() =>
      selectWindow([WINDOW, { ...WINDOW, id: 43 }], { burp: true }),
    ).toThrow("AMBIGUOUS_WINDOW");
    expect(selectWindow([WINDOW], { burp: true })).toEqual(WINDOW);
  });
  it("never falls back to another window after the selected one closes", () => {
    expect(() =>
      selectWindow([{ ...WINDOW, id: 43 }], { window_id: 42 }),
    ).toThrow("WINDOW_NOT_FOUND");
  });
  it("checks PID, title, and bounds as well as ID", () => {
    expect(sameWindow(WINDOW, { ...WINDOW, pid: 51 })).toBe(false);
    expect(sameWindow(WINDOW, { ...WINDOW, title: "different" })).toBe(false);
    expect(
      sameWindow(WINDOW, {
        ...WINDOW,
        bounds: { ...WINDOW.bounds, width: 600 },
      }),
    ).toBe(false);
  });
  it("matches exact app names instead of capturing a similarly named app", () => {
    expect(() => selectWindow([WINDOW], { app_name: "Burp" })).toThrow(
      "WINDOW_NOT_FOUND",
    );
  });
});
it("does not confuse Burp Browser with Burp Suite", () => {
  expect(() =>
    selectWindow(
      [
        {
          ...WINDOW,
          app: "Burp Browser",
          bundleId: "com.portswigger.browser",
          title: "Example",
        },
      ],
      { burp: true },
    ),
  ).toThrow("WINDOW_NOT_FOUND");
});
it("does not identify a browser by a page title mentioning Burp Suite", () => {
  expect(() =>
    selectWindow(
      [
        {
          ...WINDOW,
          app: "Safari",
          bundleId: "com.apple.Safari",
          title: "Burp Suite documentation",
        },
      ],
      { burp: true },
    ),
  ).toThrow("WINDOW_NOT_FOUND");
});

it("ignores only the leading iTerm progress spinner while preserving window identity", () => {
  const first = {
    ...WINDOW,
    app: "iTerm2",
    bundleId: "com.googlecode.iterm2",
    title: "⠋ Capture task | project",
  };
  const next = { ...first, title: "⠦ Capture task | project" };
  expect(sameWindow(first, next)).toBe(true);
  expect(windowToken(first)).toBe(windowToken(next));
  expect(
    sameWindow(first, { ...next, title: "⠦ Different task | project" }),
  ).toBe(false);
  expect(sameWindow(first, { ...next, pid: first.pid + 1 })).toBe(false);
  expect(windowToken({ ...first, bundleId: "other" })).not.toBe(
    windowToken({ ...next, bundleId: "other" }),
  );
});
