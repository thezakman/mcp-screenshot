import { describe, it, expect } from "vitest";
import { CaptureQueue } from "../src/queue.js";

describe("capture queue", () => {
  it("serializes callers and keeps the slot after a failed task", async () => {
    const queue = new CaptureQueue();
    const events: string[] = [];
    let release!: () => void;
    const a = queue.run(async () => {
      events.push("a");
      await new Promise<void>((r) => (release = r));
      throw new Error("failed");
    });
    const handled = a.catch(() => events.push("failed"));
    const b = queue.run(async () => {
      events.push("b");
      return 2;
    });
    await Promise.resolve();
    expect(events).toEqual(["a"]);
    release();
    await handled;
    expect(await b).toBe(2);
    expect(events.indexOf("b")).toBeGreaterThan(events.indexOf("a"));
    expect(queue.size).toBe(0);
  });
  it("rejects a full queue without executing the extra job", async () => {
    const q = new CaptureQueue(1);
    let release!: () => void;
    const a = q.run(() => new Promise<void>((r) => (release = r)));
    await Promise.resolve();
    await expect(
      q.run(async () => {
        throw new Error("should not run");
      }),
    ).rejects.toThrow("QUEUE_FULL");
    release();
    await a;
  });
  it("does not run a cancelled waiting capture", async () => {
    const q = new CaptureQueue();
    let release!: () => void;
    const a = q.run(() => new Promise<void>((r) => (release = r)));
    const abort = new AbortController();
    const b = q.run(async () => {
      throw new Error("should not run");
    }, abort.signal);
    const check = expect(b).rejects.toThrow("CANCELLED");
    await Promise.resolve();
    abort.abort();
    release();
    await a;
    await check;
  });
  it("expires a waiting job while the active operation still holds the slot", async () => {
    const q = new CaptureQueue(8, 10);
    let release!: () => void;
    const a = q.run(() => new Promise<void>((r) => (release = r)));
    await expect(q.run(async () => 1)).rejects.toThrow("QUEUE_TIMEOUT");
    expect(q.size).toBe(1);
    release();
    await a;
    expect(q.size).toBe(0);
  });
});
