import { describe, it, expect } from "vitest";
import { createGate } from "./gate.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("createGate", () => {
  it("never runs more than maxConcurrent tasks at once (V5-3)", async () => {
    const gate = createGate({ maxConcurrent: 2, maxQueue: 100, queueTimeoutMs: 1000 });
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 20 }, () =>
      gate(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      }),
    );
    await Promise.all(gates);
    expect(peak).toBe(2);
  });

  it("rejects with ResourceExhausted past maxQueue", async () => {
    const gate = createGate({ maxConcurrent: 1, maxQueue: 2, queueTimeoutMs: 1000 });
    const block = deferred();
    // 1 running (holds the slot) + 2 queued = full; the 4th must reject.
    const running = gate(() => block.promise);
    const q1 = gate(() => Promise.resolve());
    const q2 = gate(() => Promise.resolve());
    await expect(gate(() => Promise.resolve())).rejects.toMatchObject({ code: 8 }); // ResourceExhausted
    block.resolve();
    await Promise.all([running, q1, q2]);
  });

  it("does not leak a permit when the task throws", async () => {
    const gate = createGate({ maxConcurrent: 1, maxQueue: 10, queueTimeoutMs: 1000 });
    await expect(gate(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    // If the permit leaked, this second task would hang; a short race proves it runs.
    const ran = await Promise.race([
      gate(() => Promise.resolve("ok")),
      new Promise((r) => setTimeout(() => r("timeout"), 200)),
    ]);
    expect(ran).toBe("ok");
    expect(gate.stats()).toEqual({ running: 0, queued: 0 });
  });

  it("times out a waiter and removes it from the queue", async () => {
    const gate = createGate({ maxConcurrent: 1, maxQueue: 10, queueTimeoutMs: 30 });
    const block = deferred();
    const running = gate(() => block.promise); // holds the only slot
    await expect(gate(() => Promise.resolve())).rejects.toMatchObject({ code: 8 });
    expect(gate.stats().queued).toBe(0); // timed-out waiter was spliced out
    block.resolve();
    await running;
  });

  it("processes queued tasks in FIFO order", async () => {
    const gate = createGate({ maxConcurrent: 1, maxQueue: 10, queueTimeoutMs: 1000 });
    const order: number[] = [];
    const block = deferred();
    const head = gate(() => block.promise); // occupies the slot
    const queued = [1, 2, 3].map((n) => gate(async () => void order.push(n)));
    block.resolve();
    await Promise.all([head, ...queued]);
    expect(order).toEqual([1, 2, 3]);
  });
});
