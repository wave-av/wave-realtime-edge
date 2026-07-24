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
 *
 * SSRF-AT-CONNECT CHOKEPOINT (wre#320 sec-review MEDIUM fix). `provisionOutput` is the ONE seam both
 * `CfStreamPassthroughEgressBackend.provision` (egress-cf-stream-passthrough.ts) and `armExternalRtmpRestream`
 * (egress-arm.ts) funnel into for a real CF output create — so the DNS-rebind-safe re-check
 * (`validateDestinationUrl`, ssrf-guard.ts) lives HERE, not only on the arm's call path. Before any outbound CF
 * API call, `req.rtmpDestination`'s resolved IP is re-validated; a reject (or any thrown error from the guard
 * itself) is a typed `{ok:false, status:403}` refusal, never a throw and never a provision. This makes SSRF-at-
 * connect unbypassable by construction: no consumer of this concrete client — passthrough backend or O1 arm —
 * can reach CF without passing this gate, even if a future third caller forgets its own re-check.
 */
import type {
  CfStreamEgressClient,
  CfStreamEgressRequest,
  CfStreamEgressResult,
} from "./egress-cf-stream-passthrough.js";
import { validateDestinationUrl, type SsrfGuardOptions } from "./ssrf-guard.js";

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
  /** SSRF-at-connect resolver override (tests only; production defaults to ssrf-guard.ts's DoH resolver).
   *  Threaded through so this chokepoint's re-validation uses the same injectable resolver the arm path does. */
  readonly resolveHost?: SsrfGuardOptions["resolveHost"];
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

/** Result of a `deleteOutput` teardown call — `notFound` is a SUCCESS shape (idempotent: an already-gone output
 *  is the desired end state, not an error), so a caller never has to special-case a retry. */
export type DeleteOutputResult = { readonly ok: true; readonly notFound: boolean } | { readonly ok: false; readonly status: number; readonly reason: string };

/**
 * DELETE one CF Stream Live Output (W1 O1 teardown half, wre#287/wave-zoom#46). Mirrors
 * `CfStreamLiveClientImpl.bestEffortDeleteInput`'s call shape (same `CF_API_BASE`, same bearer auth) but is NOT
 * best-effort/void — the caller (`/v1/egress/teardown`) needs to know whether the delete actually happened before
 * emitting the O1 rtmp-out metering event, so this returns a typed result rather than swallowing everything.
 * IDEMPOTENT: CF replying 404 (output already gone — a prior teardown, or CF's own live-input-delete cascade
 * already removed it) is treated as `{ok:true, notFound:true}`, never a failure — a redelivered teardown call
 * must never error just because it's the second attempt. Any other non-2xx CF reply is a typed `{ok:false}`
 * refusal, never a throw.
 */
export async function deleteOutput(
  fetchFn: typeof fetch,
  accountId: string,
  apiToken: string,
  inputId: string,
  outputId: string,
): Promise<DeleteOutputResult> {
  try {
    const res = await fetchFn(
      `${CF_API_BASE}/accounts/${accountId}/stream/live_inputs/${inputId}/outputs/${outputId}`,
      { method: "DELETE", headers: { authorization: `Bearer ${apiToken}` } },
    );
    if (res.status === 404) return { ok: true, notFound: true };
    if (!res.ok) {
      const env = (await res.json().catch(() => ({}))) as CfEnvelope;
      return { ok: false, status: res.status, reason: `cf delete-output failed: ${summarizeErrors(env.errors)}` };
    }
    return { ok: true, notFound: false };
  } catch (e) {
    return { ok: false, status: 502, reason: `cf delete-output error: ${(e as Error)?.message ?? String(e)}` };
  }
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

    // SSRF-AT-CONNECT CHOKEPOINT — see module docstring. Re-validates the RESOLVED destination immediately
    // before any outbound CF provision, regardless of which caller (passthrough backend or O1 arm) reached this
    // adapter. Fail CLOSED on a reject AND on any thrown error from the guard itself (deny-by-default, never a
    // silent provision).
    let ssrf: Awaited<ReturnType<typeof validateDestinationUrl>>;
    try {
      ssrf = await validateDestinationUrl("rtmp", req.rtmpDestination, {
        resolveHost: this.cfg.resolveHost,
        fetchFn: this.fetchFn,
      });
    } catch (e) {
      return {
        ok: false,
        status: 403,
        reason: `ssrf-at-connect check threw, denying by default: ${(e as Error)?.message ?? String(e)}`,
      };
    }
    if (!ssrf.ok) {
      return { ok: false, status: 403, reason: `destination failed SSRF-at-connect check: ${ssrf.reason}` };
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
