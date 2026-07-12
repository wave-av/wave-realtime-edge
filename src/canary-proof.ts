// #138 Canary C3 — CF-runtime recorder proof handler. Extracted from route-dispatch.ts (file-size gate) so the
// router stays a thin dispatcher. CANARY-ONLY and INERT on prod: the route only exists when RECORDER_TARGET==="cf"
// (which only the canary worker sets — prod leaves it unset → maybeHandleCanaryProof returns a 404 and the
// byte-identical 501/route behaviour is unchanged). See test/worker.canary-proof-route.test.ts.
import { fetchContainerEncode, defaultGetContainer } from "./encoders/recorder-target";

/** The env fields this proof reads — the canary selector + the (canary-only) container binding. RECORDER is kept
 *  loose here (the worker Env types it as a bare namespace); the fetch call re-narrows to the container shape. */
type ContainerNs = Parameters<typeof fetchContainerEncode>[0];
interface CanaryProofEnv {
  RECORDER_TARGET?: "cf" | "selfhost" | "none";
  RECORDER?: DurableObjectNamespace;
}

/**
 * Handle `POST /__canary/encode-proof`: forward a POSTed JPEG frame through the SAME getContainer().fetch(
 * '/encode') path the live recorder uses, with negotiation armed (consumer descriptor = av1 decode + moq
 * transport), and surface the RecorderContainer's negotiated response headers. Returns `null` for any other
 * path/method so the router falls through unchanged. This proves CF's runtime wiring end-to-end — getContainer
 * resolution + the forwarded AV1_DEFAULT/NEGOTIATION_ENABLED envVars reaching a live container and driving
 * negotiated output — which the 06-28 docker proof (container contract) did not cover.
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
  const res = await fetchContainerEncode(env.RECORDER as unknown as ContainerNs, defaultGetContainer, frame, {
    kind: "video",
    ts: 0,
    codec: "jpeg",
    negotiate: true,
    dst: { decode: [{ name: "av1", available: true }], transports: [{ protocol: "moq", activated: true }] },
  });
  const out = await res.arrayBuffer();
  return Response.json({
    ok: res.ok,
    status: res.status,
    framedBytesIn: frame.byteLength,
    bytesOut: out.byteLength,
    xOutputCodec: res.headers.get("x-output-codec"),
    xNegotiatedTransport: res.headers.get("x-negotiated-transport"),
    xEncoder: res.headers.get("x-encoder"),
    xOutputContainer: res.headers.get("x-output-container"),
    xAv1FallbackReason: res.headers.get("x-av1-fallback-reason"),
    xNegotiationReason: res.headers.get("x-negotiation-reason"),
  });
}
