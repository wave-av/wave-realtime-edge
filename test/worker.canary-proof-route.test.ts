// #138 Canary C3 — /__canary/encode-proof route. CANARY-ONLY CF-runtime recorder proof; INERT on prod.
// Proves: (a) prod-inert — with RECORDER_TARGET unset (the prod/default worker) the route 404s and touches no
// container; (b) canary — with RECORDER_TARGET="cf" + a bound RECORDER namespace, the route makes TWO
// getContainer().fetch('/encode') calls: a negotiate=ON probe (carries the av1 x-dst-capabilities descriptor)
// and a negotiate=OFF probe (no descriptor → AV1_DEFAULT path), surfacing each response's negotiated headers;
// (c) an empty body is rejected 400 before any container hop.
import { describe, it, expect } from "vitest";
import worker from "../src/worker.js";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

// A stub RECORDER container namespace: records EVERY /encode request it receives and returns a canned negotiated
// response (mirrors the container's success headers). idFromName/get mirror the live DO-stub shape.
function stubRecorder() {
  const seen: { id?: string; reqs: Request[] } = { reqs: [] };
  const ns = {
    idFromName(id: string) {
      seen.id = id;
      return { __id: id };
    },
    get(_id: unknown) {
      return {
        fetch: async (req: Request) => {
          seen.reqs.push(req);
          return new Response(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), {
            status: 200,
            headers: {
              "x-output-codec": "av1",
              "x-encoder": "libaom-av1",
              "x-output-container": "mp4",
            },
          });
        },
      };
    },
  };
  return { ns, seen };
}

function proofReq(body: BodyInit | null = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])) {
  return new Request("https://rt.example/__canary/encode-proof", { method: "POST", body });
}

describe("#138 /__canary/encode-proof — canary-only CF-runtime recorder proof", () => {
  it("is INERT on the prod/default worker (RECORDER_TARGET unset → 404, no container touched)", async () => {
    const res = await worker.fetch(proofReq(), { ROOM: {} } as never, ctx);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("CANARY_PROOF_UNAVAILABLE");
  });

  it("404s when RECORDER_TARGET=cf but RECORDER is unbound (canary before container attach)", async () => {
    const res = await worker.fetch(proofReq(), { ROOM: {}, RECORDER_TARGET: "cf" } as never, ctx);
    expect(res.status).toBe(404);
  });

  it("rejects an empty frame with 400 before any container hop", async () => {
    const { ns, seen } = stubRecorder();
    const res = await worker.fetch(
      proofReq(new Uint8Array(0)),
      { ROOM: {}, RECORDER_TARGET: "cf", RECORDER: ns } as never,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(seen.reqs.length, "container must not be called on an empty frame").toBe(0);
  });

  it("canary: makes a negotiate-ON + a negotiate-OFF probe and surfaces both results", async () => {
    const { ns, seen } = stubRecorder();
    const res = await worker.fetch(
      proofReq(),
      { ROOM: {}, RECORDER_TARGET: "cf", RECORDER: ns } as never,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      framedBytesIn: number;
      negotiation: Record<string, unknown>;
      av1Default: Record<string, unknown>;
    };
    expect(body.framedBytesIn).toBe(4);
    expect(body.negotiation.xOutputCodec).toBe("av1");
    expect(body.av1Default.xOutputCodec).toBe("av1");

    // TWO container hops, both at the stable "rt-encoder" id, both POST /encode jpeg video frames.
    expect(seen.id).toBe("rt-encoder");
    expect(seen.reqs.length).toBe(2);
    for (const req of seen.reqs) {
      expect(new URL(req.url).pathname).toBe("/encode");
      expect(req.headers.get("x-codec")).toBe("jpeg");
      expect(req.headers.get("x-kind")).toBe("video");
    }
    // Probe 1 (negotiate ON) carries the av1 descriptor; probe 2 (negotiate OFF) sends none (AV1_DEFAULT path).
    const dst = JSON.parse(atob(seen.reqs[0].headers.get("x-dst-capabilities")!)) as {
      decode: Array<{ name: string }>;
    };
    expect(dst.decode.map((d) => d.name)).toContain("av1");
    expect(seen.reqs[1].headers.get("x-dst-capabilities"), "negotiate-OFF probe must omit the descriptor").toBeNull();
  });
});
