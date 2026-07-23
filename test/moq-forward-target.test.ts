// #314 Slice 1 — MoqForwardTarget (src/encoders/moq-forward-target.ts): the multiplexed per-meeting
// container WS. Proves the frame encoding, lazy-connect + reuse, fail-open drop-on-backpressure/closed/error,
// and the namespace-allowlist inert gate — with zero real container/WS (a mock getContainer + mock WebSocket).
import { describe, it, expect } from "vitest";
import { encodeMoqFrame, MoqForwardTarget, createMoqForwardTarget } from "../src/encoders/moq-forward-target.js";

class FakeWs {
  sent: Uint8Array[] = [];
  readyState = 1; // OPEN
  bufferedAmount = 0;
  private listeners: Record<string, Array<() => void>> = {};
  accept(): void {}
  addEventListener(type: string, cb: () => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  send(d: Uint8Array): void {
    this.sent.push(d);
  }
  close(): void {
    this.readyState = 3; // CLOSED
    for (const cb of this.listeners["close"] ?? []) cb();
  }
  fireError(): void {
    for (const cb of this.listeners["error"] ?? []) cb();
  }
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("encodeMoqFrame", () => {
  it("frames [kind][uidLen][uid][ts u32BE][payloadLen u32BE][payload]", () => {
    const out = encodeMoqFrame("u42", "video", 1000, Uint8Array.from([9, 8, 7]));
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(out[0]).toBe(1); // video
    expect(out[1]).toBe(3); // "u42".length
    expect(new TextDecoder().decode(out.slice(2, 5))).toBe("u42");
    expect(view.getUint32(5, false)).toBe(1000);
    expect(view.getUint32(9, false)).toBe(3);
    expect(Array.from(out.slice(13))).toEqual([9, 8, 7]);
  });

  it("audio kind byte is 0", () => {
    const out = encodeMoqFrame("a", "audio", 0, Uint8Array.from([]));
    expect(out[0]).toBe(0);
  });
});

describe("MoqForwardTarget — lazy-connect + reuse", () => {
  it("first frame drops (not yet connected); once connected the socket is reused across frames/uids", async () => {
    const ws = new FakeWs();
    let containerId = "";
    const getContainer = (): { fetch: (r: Request) => Promise<Response> } => ({
      fetch: async () => ({ webSocket: ws }) as unknown as Response,
    });
    const binding = { get: () => ({}), idFromName: (id: string) => ((containerId = id), id) } as never;
    const target = new MoqForwardTarget(binding, "acme", "mtg-1", () => {}, undefined, () =>
      getContainer() as never,
    );
    target.writeFrame("u1", "audio", 0, Uint8Array.from([1]));
    expect(ws.sent).toHaveLength(0); // dropped — connect hadn't resolved yet
    await flush();
    target.writeFrame("u1", "audio", 0, Uint8Array.from([2]));
    target.writeFrame("u2", "video", 0, Uint8Array.from([3]));
    expect(ws.sent).toHaveLength(2); // reused the SAME socket for a second uid, no re-connect
    void containerId;
  });

  it("container id is `${org}:${meetingUuid}`", async () => {
    const ws = new FakeWs();
    let seenId = "";
    const binding = {
      get: (): unknown => ({}),
      idFromName: (id: string) => {
        seenId = id;
        return id;
      },
    } as never;
    const getContainerImpl = (ns: unknown, id: string): { fetch: (r: Request) => Promise<Response> } => {
      (ns as { idFromName: (id: string) => string }).idFromName(id);
      return { fetch: async () => ({ webSocket: ws }) as unknown as Response };
    };
    const target = new MoqForwardTarget(binding, "acme", "mtg-7", () => {}, undefined, getContainerImpl as never);
    target.writeFrame("u1", "audio", 0, Uint8Array.from([1]));
    await flush();
    expect(seenId).toBe("acme:mtg-7");
  });
});

describe("MoqForwardTarget — fail-open", () => {
  it("backpressured socket (bufferedAmount over ceiling): drops, never throws", async () => {
    const ws = new FakeWs();
    ws.bufferedAmount = 2_000_000;
    const getContainerImpl = () => ({ fetch: async () => ({ webSocket: ws }) as unknown as Response });
    const target = new MoqForwardTarget({} as never, "acme", "mtg-1", () => {}, undefined, getContainerImpl as never);
    target.writeFrame("u1", "audio", 0, Uint8Array.from([1]));
    await flush();
    expect(() => target.writeFrame("u1", "audio", 0, Uint8Array.from([2]))).not.toThrow();
    expect(ws.sent).toHaveLength(0);
  });

  it("closed socket: drops, never throws", async () => {
    const ws = new FakeWs();
    const getContainerImpl = () => ({ fetch: async () => ({ webSocket: ws }) as unknown as Response });
    const target = new MoqForwardTarget({} as never, "acme", "mtg-1", () => {}, undefined, getContainerImpl as never);
    target.writeFrame("u1", "audio", 0, Uint8Array.from([1]));
    await flush();
    ws.close();
    expect(() => target.writeFrame("u1", "audio", 0, Uint8Array.from([2]))).not.toThrow();
    expect(ws.sent).toHaveLength(0);
  });

  it("connect throws: drops, never throws, logs", async () => {
    const logs: string[] = [];
    const getContainerImpl = () => ({
      fetch: async () => {
        throw new Error("container unreachable");
      },
    });
    const target = new MoqForwardTarget({} as never, "acme", "mtg-1", (msg) => logs.push(msg), undefined, getContainerImpl as never);
    expect(() => target.writeFrame("u1", "audio", 0, Uint8Array.from([1]))).not.toThrow();
    await flush();
    expect(logs).toContain("moq-forward-connect-error");
  });

  it("fetch resolves with no webSocket: drops, never throws, logs", async () => {
    const logs: string[] = [];
    const getContainerImpl = () => ({ fetch: async () => ({}) as unknown as Response });
    const target = new MoqForwardTarget({} as never, "acme", "mtg-1", (msg) => logs.push(msg), undefined, getContainerImpl as never);
    target.writeFrame("u1", "audio", 0, Uint8Array.from([1]));
    await flush();
    expect(logs).toContain("moq-forward-connect-no-socket");
  });

  it("close() before connect resolves: the late-arriving socket is closed immediately, never left open", async () => {
    const ws = new FakeWs();
    const getContainerImpl = () => ({ fetch: async () => ({ webSocket: ws }) as unknown as Response });
    const target = new MoqForwardTarget({} as never, "acme", "mtg-1", () => {}, undefined, getContainerImpl as never);
    target.writeFrame("u1", "audio", 0, Uint8Array.from([1]));
    target.close();
    await flush();
    expect(ws.readyState).toBe(3); // CLOSED
    target.writeFrame("u1", "audio", 0, Uint8Array.from([2]));
    expect(ws.sent).toHaveLength(0);
  });
});

describe("createMoqForwardTarget — inert gate", () => {
  it("no MOQ_PUBLISH binding: returns null", () => {
    expect(createMoqForwardTarget({}, "acme", "mtg-1", () => {})).toBeNull();
  });

  it("invalid org (colon injection): returns null, never constructs", () => {
    const logs: string[] = [];
    const r = createMoqForwardTarget({ MOQ_PUBLISH: {} as never }, "acme:evil", "mtg-1", (msg) => logs.push(msg));
    expect(r).toBeNull();
    expect(logs).toContain("moq-forward-invalid-namespace");
  });

  it("invalid meetingUuid: returns null", () => {
    expect(createMoqForwardTarget({ MOQ_PUBLISH: {} as never }, "acme", "bad uuid!", () => {})).toBeNull();
  });

  it("binding present + valid namespace: returns a live writer", () => {
    const r = createMoqForwardTarget({ MOQ_PUBLISH: {} as never }, "acme", "mtg-1", () => {});
    expect(r).not.toBeNull();
    expect(typeof r?.writeFrame).toBe("function");
  });
});
