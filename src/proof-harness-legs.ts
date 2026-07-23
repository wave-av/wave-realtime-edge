/**
 * #293 — concrete per-leg probes for the proof harness (`proof-harness.ts`). Each export is a `LegProbe`
 * factory: pass it the SAME injected seams (fetch/KV/config) the real code path already takes, and it does
 * ONE synthetic round-trip through that real path — never a hand-rolled parallel check. Two legs
 * (`ext-rtmp-out`, `ext-srt-out`) have no upstream module yet (no external RTMP/SRT simulcast egress is
 * built — `egress-router.ts`'s backends are `cfStream`/`waveRender`/`runpodNvenc`, none of which push to an
 * external RTMP/SRT target); `rtms-in` has an auth/crypto layer (`rtms-auth.ts`) but no live-session bridge
 * probe surface yet. Those three stay on the engine's default stub until their leg PR lands a real probe
 * here — the harness SHAPE (receipt, gate, cron hook) is already real for all five.
 */
import type { LegProbe } from "./proof-harness.js";
import { CfStreamLiveClientImpl, type CfStreamLiveClientConfig, type StreamInputKv } from "./cf-stream-live-client.js";
import { registerRecording, type RegisterConfig, type RegisterRecordingInput } from "./recordings-register.js";
import { rtmsHandshakeSignature } from "./rtms-auth.js";

/**
 * `rtmp-in` — synthetic CF Stream Live-input provision. Runs the SAME `CfStreamLiveClientImpl.createLiveInput`
 * the ingest backend calls (`cf-stream-live-client.ts`), against a synthetic org/room, and proves CF actually
 * handed back a usable RTMPS push endpoint (`rtmp://…` + non-empty stream key) — the thing an encoder needs
 * to push `rtmp-in`. Pass a real `CfStreamLiveClientConfig` (real `accountId`/`apiToken`/`kv`) for the live
 * cron monitor, or a fake `fetchFn`/`kv` in CI so no live CF account is touched by the merge gate.
 */
export function rtmpInProbe(cfg: CfStreamLiveClientConfig, org = "proof-harness", room = "synthetic"): LegProbe {
  return async () => {
    const client = new CfStreamLiveClientImpl(cfg);
    const result = await client.createLiveInput({ org, room, feed: { mode: "push", protocol: "rtmp" } });
    if (!result.ok) {
      return { verdict: "fail", markers: { status: result.status, reason: result.reason } };
    }
    const rtmp = result.input.endpoints.find((e) => e.protocol === "rtmp");
    if (!rtmp || !rtmp.url || !("streamKey" in rtmp && rtmp.streamKey)) {
      return { verdict: "fail", markers: { uid: result.input.uid, endpoints: result.input.endpoints }, note: "no usable rtmp endpoint in reply" };
    }
    return { verdict: "pass", markers: { uid: result.input.uid, rtmpUrl: rtmp.url, endpointCount: result.input.endpoints.length } };
  };
}

/**
 * `vod-register` — synthetic `POST /v1/internal/recordings/register` round-trip via the REAL `registerRecording`
 * client (`recordings-register.ts`), with a synthetic-but-schema-valid input (a fixed proof-harness UUID org,
 * an org-prefixed key). Proves the gateway registration leg is reachable + accepting — the thing VOD finalize
 * depends on. `fetchImpl` is injected so CI hits a fake 2xx and the live cron hits the real gateway.
 */
const PROOF_ORG = "00000000-0000-4000-8000-000000000293"; // synthetic UUID reserved for harness-only registers
export function vodRegisterProbe(
  cfg: RegisterConfig,
  fetchImpl: typeof fetch,
  input: Partial<RegisterRecordingInput> = {},
): LegProbe {
  return async (now) => {
    const body: RegisterRecordingInput = {
      org: PROOF_ORG,
      r2Key: `${PROOF_ORG}/proof-harness/${now()}.mp4`,
      bucket: input.bucket ?? "proof-harness-synthetic",
      zone: input.zone ?? "us-east",
      sourceProtocol: input.sourceProtocol ?? "whip",
    };
    const result = await registerRecording(body, cfg, undefined, fetchImpl);
    if (!result.ok) {
      return { verdict: "fail", markers: { reason: result.reason, status: result.status } };
    }
    return { verdict: "pass", markers: { recordingId: result.recordingId, deduped: result.deduped } };
  };
}

/**
 * `rtms-in` — synthetic Zoom RTMS handshake-signature computation via the REAL `rtmsHandshakeSignature`
 * (`rtms-auth.ts`), proving the WebCrypto HMAC path this leg's auth handshake depends on actually produces a
 * well-formed hex signature in THIS runtime (Workers WebCrypto availability is the historical failure mode
 * this catches — not a live Zoom session, which needs a real meeting and is out of this harness's reach).
 */
export function rtmsInProbe(clientId = "proof-harness", clientSecret = "proof-harness-secret"): LegProbe {
  return async () => {
    const meetingUuid = "proof-harness-meeting";
    const rtmsStreamId = "proof-harness-stream";
    const sig = await rtmsHandshakeSignature(clientId, meetingUuid, rtmsStreamId, clientSecret);
    if (typeof sig !== "string" || !/^[0-9a-f]{64}$/i.test(sig)) {
      return { verdict: "fail", markers: { sigLen: sig?.length }, note: "handshake signature not a 64-hex HMAC-SHA256" };
    }
    return { verdict: "pass", markers: { sigLen: sig.length } };
  };
}

/** No egress module pushes to an external RTMP target yet (`egress-router.ts` backends: cfStream/waveRender/
 *  runpodNvenc — none is "external simulcast"). Explicit named export (not just the engine default) so this
 *  leg's future PR has an obvious place to replace the stub with a real probe. */
export const extRtmpOutProbe: undefined = undefined;
/** Same gap for `ext-srt-out` — no external SRT egress target is built yet. */
export const extSrtOutProbe: undefined = undefined;

export type { StreamInputKv };
