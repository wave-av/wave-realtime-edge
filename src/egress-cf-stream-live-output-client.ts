/**
 * W1 SLICE-2B O1 (wre#287) — the CONCRETE `CfStreamEgressClient` adapter: the "ARM slice"
 * `egress-cf-stream-passthrough.ts` deferred (see that module's docstring: "the concrete adapter ... is the ARM
 * slice"). This is the ONLY new CF-Stream-Live-Output I/O this slice adds — a real Cloudflare Stream
 * `POST /accounts/{accountId}/stream/live_inputs/{liveInputId}/outputs` call that turns an already-ingested Zoom
 * CF Live Input (created by `cf-stream-live-client.ts`, room `cfstream:{uid}` per `bridgeRoomFor`) into a live
 * simulcast to a customer's EXTERNAL RTMP destination (YouTube/Twitch/custom).
 *
 * SEAM: implements ONLY `CfStreamEgressClient` (egress-cf-stream-passthrough.ts) — the passthrough backend's
 * injected interface. Holds no router/job logic itself; a non-2xx CF reply or a malformed input is a typed
 * `{ok:false}`, NEVER a throw into the media path (fail-closed on auth/API errors, never crash the caller).
 *
 * LIVE-INPUT-ID DERIVATION. `CfStreamEgressRequest` carries `sessionId`, not a CF live-input uid — this codebase's
 * bridged-Zoom convention is the deterministic room `cfstream:{uid}` (`bridgeRoomFor`, stream-bridge.ts), so a
 * restream target's `sessionId` for an already-bridged Zoom input IS that room string. `deriveLiveInputId` parses
 * the uid back out; a `sessionId` that doesn't match the `cfstream:{32-hex}` shape is refused (400) rather than
 * guessed at.
 *
 * URL/KEY SPLIT. `CfStreamEgressTarget.rtmpDestination` (the passthrough backend's existing, already-tested field)
 * carries ONE combined rtmp(s) URL — `rtmp://host/app/streamKey`, exactly the shape
 * `egress-cf-stream-passthrough.test.ts` already exercises (`"rtmp://live.example/app/key"`). CF's real Live
 * Output API wants `url` (the server, without the key) and `streamKey` as two separate body fields, so
 * `splitRtmpUrl` peels the last path segment off as the key — reconstructing exactly what the O1 arm wiring
 * (`egress-arm.ts`) joined together from the destination's separately-stored `{url, streamKey}`
 * (`resolveDestinationForArm`, egress-destinations.ts) before calling `provisionOutput`. Neither
 * `CfStreamEgressRequest` nor `CfStreamEgressTarget` is modified — this adapter is the ONLY place that knows CF's
 * two-field wire shape.
 *
 * INJECTED FETCH. `fetchFn` is injectable (defaults to global `fetch`), so this adapter is fully unit-testable
 * with a fake — no real network in test, mirroring `cf-stream-live-client.ts`'s auth pattern exactly (account id
 * + bearer API token in the header, same `CF_API_BASE`).
 */
import type {
  CfStreamEgressClient,
  CfStreamEgressRequest,
  CfStreamEgressResult,
} from "./egress-cf-stream-passthrough.js";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

/** A CF Stream live-input uid is 32 lowercase hex (same shape `cf-stream-live-client.ts`'s `LIVE_INPUT_UID`
 *  validates) — re-declared here (not imported) so this adapter has zero dependency on the ingest-side module. */
const LIVE_INPUT_UID_IN_ROOM = /^cfstream:([0-9a-f]{32})$/;

/** Injected config for the live-output adapter. `accountId`/`apiToken` target the CF Stream account (same
 *  binding shape `CfStreamLiveClientConfig` uses); `fetchFn` is injectable for tests. */
export interface CfStreamEgressLiveOutputConfig {
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetchFn?: typeof fetch;
}

/** Recover the CF Stream live-input uid from a bridged-Zoom `sessionId` (the deterministic `cfstream:{uid}` room
 *  — `bridgeRoomFor`, stream-bridge.ts). Returns null (never guesses) for any sessionId that isn't that exact
 *  bridged-room shape. */
export function deriveLiveInputId(sessionId: string): string | null {
  const m = LIVE_INPUT_UID_IN_ROOM.exec(sessionId);
  return m ? m[1] : null;
}

/** Split a combined `rtmp(s)://host/app/streamKey` destination into CF Live Output's two-field wire shape
 *  `{url, streamKey}` — the base push URL (everything but the last path segment) and the key (the last segment).
 *  Returns null for an unparseable URL or one with no path segment to use as a key (never fabricates a key). */
export function splitRtmpUrl(dest: string): { url: string; streamKey: string } | null {
  let u: URL;
  try {
    u = new URL(dest);
  } catch {
    return null;
  }
  const segments = u.pathname.split("/").filter(Boolean);
  const streamKey = segments.pop();
  if (!streamKey) return null;
  u.pathname = segments.length ? `/${segments.join("/")}` : "";
  const url = u.toString().replace(/\/$/, "");
  return { url, streamKey };
}

/** Shape of the CF create-live-output reply this adapter consumes. */
interface CfCreateOutputResult {
  uid?: string;
}
interface CfEnvelope {
  success?: boolean;
  errors?: unknown;
  result?: CfCreateOutputResult;
}

/** Compact a CF `errors` array into a short reason string (mirrors `cf-stream-live-client.ts`'s `summarize`). */
function summarizeErrors(errors: unknown): string {
  if (Array.isArray(errors) && errors.length) {
    const first = errors[0] as { code?: unknown; message?: unknown };
    return `[${first?.code ?? "?"}] ${String(first?.message ?? "").slice(0, 120)}`;
  }
  return "unknown error";
}

/**
 * The concrete CF Stream Live Output origin. Implements ONLY `CfStreamEgressClient` — the passthrough backend's
 * injected seam — so it is a drop-in for `CfStreamPassthroughEgressBackend` / the O1 arm wiring alike.
 */
export class CfStreamEgressLiveOutputClient implements CfStreamEgressClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly cfg: CfStreamEgressLiveOutputConfig) {
    // BIND to globalThis — see cf-stream-live-client.ts for why (Workers/undici `fetch` throws "Illegal
    // invocation" if invoked as `this.fetchFn(...)` unbound).
    this.fetchFn = cfg.fetchFn ?? fetch.bind(globalThis);
  }

  async provisionOutput(req: CfStreamEgressRequest): Promise<CfStreamEgressResult> {
    // This adapter serves ONLY the simulcast (external-RTMP) case — a `record` output needs no CF Live Output
    // (CF Stream stores the recording on the input itself) and is never routed here by the O1 arm wiring.
    if (req.output !== "simulcast" || !req.rtmpDestination) {
      return { ok: false, status: 400, reason: "cf live-output requires a simulcast job with an rtmp destination" };
    }

    const liveInputId = deriveLiveInputId(req.sessionId);
    if (!liveInputId) {
      return { ok: false, status: 400, reason: `sessionId is not a bridged cfstream room (${req.sessionId})` };
    }

    const split = splitRtmpUrl(req.rtmpDestination);
    if (!split) {
      return { ok: false, status: 400, reason: `rtmpDestination has no stream-key path segment (${req.rtmpDestination})` };
    }

    try {
      const res = await this.fetchFn(
        `${CF_API_BASE}/accounts/${this.cfg.accountId}/stream/live_inputs/${liveInputId}/outputs`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${this.cfg.apiToken}`, "content-type": "application/json" },
          body: JSON.stringify({ url: split.url, streamKey: split.streamKey }),
        },
      );
      const env = (await res.json().catch(() => ({}))) as CfEnvelope;
      if (!res.ok || env.success !== true || !env.result) {
        return { ok: false, status: res.status || 502, reason: `cf create-output failed: ${summarizeErrors(env.errors)}` };
      }
      const outputId = env.result.uid ?? "";
      if (!outputId) {
        return { ok: false, status: 502, reason: "cf create-output returned no output uid" };
      }
      return { ok: true, outputId };
    } catch (e) {
      return { ok: false, status: 502, reason: `cf create-output error: ${(e as Error)?.message ?? String(e)}` };
    }
  }
}
