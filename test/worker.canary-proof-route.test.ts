// #138 Canary C3 — /__canary/encode-proof route. CANARY-ONLY CF-runtime recorder proof; INERT on prod.
// Proves: (a) prod-inert — with RECORDER_TARGET unset (the prod/default worker) the route 404s and touches no
// container; (b) canary — with RECORDER_TARGET="cf" + a bound RECORDER namespace, the route forwards the POSTed
// JPEG frame through the SAME getContainer().fetch('/encode') call the live recorder makes, with negotiation
// armed (x-dst-capabilities = av1 decode + moq transport), and surfaces the container's negotiated response
// headers verbatim; (c) an empty body is rejected 400 before any container hop.
import { describe, it, expect } from "vitest";
import worker from "../src/worker.js";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

// A stub RECORDER container namespace: records the /encode request it receives and returns a canned negotiated
// response (mirrors the container's success headers). idFromName/get mirror the live DO-stub shape.
function stubRecorder() {
  const seen: { id?: string; req?: Request } = {};
  const ns = {
    idFromName(id: string) {
      seen.id = id;
      return { __id: id };
    },
    get(_id: unknown) {
      return {
        fetch: async (req: Request) => {
          seen.req = req;
          return new Response(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), {
            status: 200,
            headers: {
              "x-output-codec": "av1",
              "x-negotiated-transport": "moq",
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
    expect(seen.req, "container must not be called on an empty frame").toBeUndefined();
  });

  it("canary: forwards the frame to /encode with av1+moq negotiation and surfaces the negotiated headers", async () => {
    const { ns, seen } = stubRecorder();
    const res = await worker.fetch(
      proofReq(),
      { ROOM: {}, RECORDER_TARGET: "cf", RECORDER: ns } as never,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.xOutputCodec).toBe("av1");
    expect(body.xNegotiatedTransport).toBe("moq");
    expect(body.xEncoder).toBe("libaom-av1");
    expect(body.status).toBe(200);
    expect(body.framedBytesIn).toBe(4);
    expect(body.bytesOut).toBe(4);

    // The container was reached at the stable "rt-encoder" id, on POST /encode, as a jpeg video frame …
    expect(seen.id).toBe("rt-encoder");
    const req = seen.req!;
    expect(new URL(req.url).pathname).toBe("/encode");
    expect(req.headers.get("x-codec")).toBe("jpeg");
    expect(req.headers.get("x-kind")).toBe("video");
    // … carrying the negotiation descriptor (av1 decode + moq transport) the live recorder path would send.
    const dst = JSON.parse(atob(req.headers.get("x-dst-capabilities")!)) as {
      decode: Array<{ name: string }>;
      transports: Array<{ protocol: string }>;
    };
    expect(dst.decode.map((d) => d.name)).toContain("av1");
    expect(dst.transports.map((t) => t.protocol)).toContain("moq");
  });
});
