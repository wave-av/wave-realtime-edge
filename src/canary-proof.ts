// #138 Canary C3 — CF-runtime recorder proof handler. Extracted from route-dispatch.ts (file-size gate) so the
// router stays a thin dispatcher. CANARY-ONLY and INERT on prod: the route only fires when RECORDER_TARGET==="cf"
// (which only the canary worker sets — prod leaves it unset → maybeHandleCanaryProof returns a 404 and the
// byte-identical 501/route behaviour is unchanged). See test/worker.canary-proof-route.test.ts.
import { fetchContainerEncode, defaultGetContainer, type FrameMeta } from "./encoders/recorder-target";

/** The env fields this proof reads — the canary selector + the (canary-only) container binding. RECORDER is kept
 *  loose here (the worker Env types it as a bare namespace); the fetch call re-narrows to the container shape. */
type ContainerNs = Parameters<typeof fetchContainerEncode>[0];
interface CanaryProofEnv {
  RECORDER_TARGET?: "cf" | "selfhost" | "none";
  RECORDER?: DurableObjectNamespace;
}

/** One `/encode` container round-trip → a JSON-able digest of the response status + negotiated headers. */
async function probe(ns: ContainerNs, frame: Uint8Array, meta: FrameMeta): Promise<Record<string, unknown>> {
  const res = await fetchContainerEncode(ns, defaultGetContainer, frame, meta);
  const out = await res.arrayBuffer();
  return {
    status: res.status,
    ok: res.ok,
    bytesOut: out.byteLength,
    xOutputCodec: res.headers.get("x-output-codec"),
    xNegotiatedTransport: res.headers.get("x-negotiated-transport"),
    xEncoder: res.headers.get("x-encoder"),
    xOutputContainer: res.headers.get("x-output-container"),
    xAv1FallbackReason: res.headers.get("x-av1-fallback-reason"),
    xNegotiationReason: res.headers.get("x-negotiation-reason"),
  };
}

/**
 * Handle `POST /__canary/encode-proof`: forward a POSTed JPEG frame through the SAME getContainer().fetch(
 * '/encode') path the live recorder uses, and capture TWO CF-runtime evidences that together prove the #136
 * envVar-forwarding wiring end-to-end (which the 06-28 docker proof — container contract — did not cover):
 *
 *   • `negotiation`   — negotiate=ON with a consumer descriptor (av1 decode). Proves NEGOTIATION_ENABLED was
 *                       forwarded and the selector RAN in CF's runtime. On a pure CF encode node the CODEC ladder
 *                       negotiates av1 then the TRANSPORT ladder honestly excludes (422 TRANSPORT_NOT_ACTIVATED —
 *                       moq/srt/rist live in other services, not this node): an honest-negative, not a bug.
 *   • `av1Default`    — negotiate=OFF (no descriptor). Proves AV1_DEFAULT was forwarded: the container defaults
 *                       the master encode to av1 and actually transcodes → 200 x-output-codec:av1 (or a VISIBLE
 *                       x-av1-fallback-reason if this host lacked an av1 encoder — never a silent substitution).
 *
 * Returns `null` for any other path/method so the router falls through unchanged.
 */
export async function maybeHandleCanaryProof(
  request: Request,
  url: URL,
  env: CanaryProofEnv,
): Promise<Response | null> {
  if (request.method !== "POST" || url.pathname !== "/__canary/encode-proof") return null;
  if (env.RECORDER_TARGET !== "cf" || !env.RECORDER) {
    return Response.json(
      { error: "CANARY_PROOF_UNAVAILABLE", note: "RECORDER_TARGET!==cf or RECORDER unbound (prod-inert)" },
      { status: 404 },
    );
  }
  const frame = new Uint8Array(await request.arrayBuffer());
  if (frame.byteLength === 0) return Response.json({ error: "EMPTY_FRAME", note: "POST a JPEG body" }, { status: 400 });
  const ns = env.RECORDER as unknown as ContainerNs;
  const base = { kind: "video", ts: 0, codec: "jpeg" } as const;

  // Evidence 1 — negotiation ran (NEGOTIATION_ENABLED forwarded): offer av1 decode + the ladder transports.
  const negotiation = await probe(ns, frame, {
    ...base,
    negotiate: true,
    dst: {
      decode: [{ name: "av1", available: true }],
      transports: [{ protocol: "moq", activated: true }],
    },
  });
  // Evidence 2 — av1 encode ran (AV1_DEFAULT forwarded): no descriptor → the container's AV1-default profile.
  const av1Default = await probe(ns, frame, { ...base, negotiate: false });

  return Response.json({ framedBytesIn: frame.byteLength, negotiation, av1Default });
}
