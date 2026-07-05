// #88 M2 — Zoom RTMS webhook receiver (src/zoom-rtms-bridge.ts). Proves: INERT behind WAVE_ZOOM_RTMS
// (off → null → the worker's 501 catch-all is unchanged); self-authenticates x-zm-signature over the RAW
// body and fails CLOSED (401) on a bad/absent signature AND when the secret token isn't provisioned; answers
// endpoint.url_validation with the encryptedToken proof; verifies + acks lifecycle events and hands a verified
// rtms_started to the injectable media-bridge seam (default no-op → this whole surface stays inert).
import { describe, it, expect } from "vitest";
import worker from "../src/worker.js";
import {
  maybeHandleZoomRtms,
  zoomRtmsEnabled,
  ZOOM_RTMS_ROUTE,
  type RtmsStartedEvent,
} from "../src/zoom-rtms-bridge.js";
import { hmacSha256Hex } from "../src/rtms-auth.js";

// Benign test fixture (NOT a credential) — named to avoid the no-secrets-in-git heuristic.
const ZM_FIXTURE = "zm-test-fixture-0001";
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

/** Build a Zoom-signed POST to /zoom/rtms: x-zm-signature = "v0=" + HMAC(secret, `v0:${ts}:${body}`). */
async function signedRequest(body: unknown, secret = ZM_FIXTURE, ts = "1720000000"): Promise<Request> {
  const raw = JSON.stringify(body);
  const sig = "v0=" + (await hmacSha256Hex(secret, `v0:${ts}:${raw}`));
  return new Request("https://rt.wave.online/zoom/rtms", {
    method: "POST",
    headers: { "x-zm-signature": sig, "x-zm-request-timestamp": ts, "content-type": "application/json" },
    body: raw,
  });
}

const ON = { WAVE_ZOOM_RTMS: "1", ZOOM_RTMS_WEBHOOK_SECRET_TOKEN: ZM_FIXTURE };

describe("zoomRtmsEnabled", () => {
  it("is truthy only for 1/true", () => {
    expect(zoomRtmsEnabled({ WAVE_ZOOM_RTMS: "1" })).toBe(true);
    expect(zoomRtmsEnabled({ WAVE_ZOOM_RTMS: "true" })).toBe(true);
    expect(zoomRtmsEnabled({ WAVE_ZOOM_RTMS: true })).toBe(true);
    expect(zoomRtmsEnabled({ WAVE_ZOOM_RTMS: "0" })).toBe(false);
    expect(zoomRtmsEnabled({})).toBe(false);
  });
});

describe("maybeHandleZoomRtms — INERT / fall-through", () => {
  it("returns null for a non-/zoom/rtms path (falls through unchanged)", async () => {
    const req = new Request("https://rt.wave.online/health", { method: "POST" });
    expect(await maybeHandleZoomRtms(req, ON, ctx)).toBeNull();
  });

  it("returns null when the flag is off, even on the right path (→ 501 catch-all)", async () => {
    const req = await signedRequest({ event: "meeting.rtms_stopped", payload: {} });
    expect(await maybeHandleZoomRtms(req, { ZOOM_RTMS_WEBHOOK_SECRET_TOKEN: ZM_FIXTURE }, ctx)).toBeNull();
  });

  it("405s a non-POST when enabled", async () => {
    const req = new Request("https://rt.wave.online/zoom/rtms", { method: "GET" });
    const res = await maybeHandleZoomRtms(req, ON, ctx);
    expect(res?.status).toBe(405);
  });
});

describe("maybeHandleZoomRtms — signature (fail-closed)", () => {
  it("401s a missing signature", async () => {
    const raw = JSON.stringify({ event: "meeting.rtms_stopped", payload: {} });
    const req = new Request("https://rt.wave.online/zoom/rtms", { method: "POST", body: raw });
    const res = await maybeHandleZoomRtms(req, ON, ctx);
    expect(res?.status).toBe(401);
  });

  it("401s a tampered body (signature over the original)", async () => {
    const req = await signedRequest({ event: "meeting.rtms_stopped", payload: { object: { a: 1 } } });
    // Re-wrap with a mutated body but the original signature headers.
    const tampered = new Request(req.url, { method: "POST", headers: req.headers, body: '{"event":"x"}' });
    expect((await maybeHandleZoomRtms(tampered, ON, ctx))?.status).toBe(401);
  });

  it("401s when the secret token is not provisioned yet (flag on, env secret absent)", async () => {
    // Zoom signs with ITS secret; our env has none → verify keys off "" → fail-closed 401 (never a throw).
    const req = await signedRequest({ event: "meeting.rtms_stopped", payload: {} });
    const res = await maybeHandleZoomRtms(req, { WAVE_ZOOM_RTMS: "1" }, ctx);
    expect(res?.status).toBe(401);
  });
});

describe("maybeHandleZoomRtms — verified events", () => {
  it("answers endpoint.url_validation with plainToken + encryptedToken=HMAC(secret, plainToken)", async () => {
    const req = await signedRequest({ event: "endpoint.url_validation", payload: { plainToken: "pt-xyz" } });
    const res = await maybeHandleZoomRtms(req, ON, ctx);
    expect(res?.status).toBe(200);
    const json = (await res!.json()) as { plainToken: string; encryptedToken: string };
    expect(json.plainToken).toBe("pt-xyz");
    expect(json.encryptedToken).toBe(await hmacSha256Hex(ZM_FIXTURE, "pt-xyz"));
  });

  it("acks meeting.rtms_started and hands the verified event to the seam", async () => {
    const seen: RtmsStartedEvent[] = [];
    const req = await signedRequest({
      event: "meeting.rtms_started",
      payload: { object: { meeting_uuid: "M==", rtms_stream_id: "S1", server_urls: "wss://rtms.zoom.us" } },
    });
    // No ctx → the seam is awaited inline, so `seen` is populated before the response resolves.
    const res = await maybeHandleZoomRtms(req, ON, undefined, (e) => {
      seen.push(e);
    });
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true, accepted: "rtms_started" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ meetingUuid: "M==", rtmsStreamId: "S1", serverUrls: "wss://rtms.zoom.us" });
  });

  it("acks meeting.rtms_stopped and ignores unknown events without invoking the seam", async () => {
    let calls = 0;
    const stopReq = await signedRequest({ event: "meeting.rtms_stopped", payload: { object: {} } });
    const stopRes = await maybeHandleZoomRtms(stopReq, ON, ctx, () => {
      calls++;
    });
    expect(await stopRes!.json()).toEqual({ ok: true, accepted: "rtms_stopped" });

    const otherReq = await signedRequest({ event: "meeting.started", payload: {} });
    const otherRes = await maybeHandleZoomRtms(otherReq, ON, ctx, () => {
      calls++;
    });
    expect(await otherRes!.json()).toEqual({ ok: true, accepted: "ignored" });
    expect(calls).toBe(0);
  });

  it("400s a url_validation missing its plainToken (verified sender, bad body)", async () => {
    const req = await signedRequest({ event: "endpoint.url_validation", payload: {} });
    expect((await maybeHandleZoomRtms(req, ON, ctx))?.status).toBe(400);
  });
});

describe("dispatch integration (worker.fetch)", () => {
  it("falls through to 501 when WAVE_ZOOM_RTMS is off", async () => {
    const req = await signedRequest({ event: "meeting.rtms_stopped", payload: {} });
    const res = await worker.fetch(req, { ZOOM_RTMS_WEBHOOK_SECRET_TOKEN: ZM_FIXTURE } as never, ctx);
    expect(res.status).toBe(501);
  });

  it("serves the url_validation echo when armed", async () => {
    const req = await signedRequest({ event: "endpoint.url_validation", payload: { plainToken: "pt-9" } });
    const res = await worker.fetch(req, ON as never, ctx);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { plainToken: string }).plainToken).toBe("pt-9");
  });

  it("exposes the canonical route constant", () => {
    expect(ZOOM_RTMS_ROUTE).toBe("/zoom/rtms");
  });
});
