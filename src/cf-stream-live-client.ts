/**
 * #35-B / #78 — the concrete `CfStreamLiveClient` (the ARM-slice create-input adapter deferred by
 * `ingress-cf-stream-live.ts`). It is the one place that touches the CF Stream API + KV:
 *
 *   1. CREATE a CF Stream `live_input` with `recording.mode:"automatic"`. This mode is REQUIRED for ANY live
 *      playback — including the LL-HLS the stream-bridge container now pulls (#211): with `mode:"off"` an input
 *      yields `videos=0`, HLS 204, and WHEP 409, so the bridge has nothing to pull. `automatic` → a live-video
 *      output + HLS/LL-HLS 200 once the feed goes live.
 *   2. PERSIST the `stream-input-org:${uid}` binding (in `RT_MEETING_ORG`) the receiver resolves SERVER-SIDE
 *      (never trusting the webhook wire — §3/§9.6). The receiver fail-closes without it.
 *
 * Ordered create-then-bind (best-effort atomicity): a CF failure writes nothing; a KV failure after create leaves
 * a HARMLESS orphan input (no org binding → the receiver never dispatches it; the reconcile cron reaps it) and is
 * surfaced as a non-ok result — never a fake success (mirrors the egress backend's discriminated result).
 *
 * INERT until the ◆ arm: nothing instantiates this until `INGRESS_ROUTER_ENABLED` is armed and provisioning is wired
 * into the ingest entrypoint. Pure over injected deps (account/token/kv/fetch) — unit-tested with a fake fetch + KV.
 */
import type {
  CfStreamLiveClient,
  CfStreamLiveIngestRequest,
  CfStreamLiveResult,
  CfStreamLiveEndpoint,
} from "./ingress-cf-stream-live.js";
import { STREAM_INPUT_ORG_PREFIX } from "./stream-bridge.js";

const CF_API = "https://api.cloudflare.com/client/v4";

/** The minimal KV surface this client writes to — the `RT_MEETING_ORG` namespace under the `stream-input-org:` prefix. */
export interface StreamInputOrgKv {
  put(key: string, value: string): Promise<void>;
}

/** The injected dependencies. Bound at the ◆ arm slice from `wrangler.toml` env + the KV binding. */
export interface CfStreamLiveClientDeps {
  /** CF account id that owns the Stream product (the gmail fleet account `d674452f…`). */
  readonly accountId: string;
  /** CF API token with Stream:Edit scope — the `CF_STREAM_API_TOKEN` wrangler secret. */
  readonly apiToken: string;
  /** The uid→org binding store (`RT_MEETING_ORG`). */
  readonly kv: StreamInputOrgKv;
  /** Injectable fetch (default `globalThis.fetch`) — test seam. */
  readonly fetchImpl?: typeof fetch;
}

/** The subset of the CF `live_inputs` create result we read (full object documented at CF Stream Live API). */
interface CfLiveInputResult {
  readonly uid?: string;
  readonly rtmps?: { readonly url?: string; readonly streamKey?: string };
  readonly srt?: { readonly url?: string; readonly streamId?: string };
}

/** Map the CF result to our typed push ingest endpoints (rtmps + srt — the endpoints a push feed is fed on). SRT's
 *  `streamId` maps onto the shared `streamKey` field (the type carries one opaque per-endpoint credential). */
function parseEndpoints(r: CfLiveInputResult): CfStreamLiveEndpoint[] {
  const eps: CfStreamLiveEndpoint[] = [];
  if (r.rtmps?.url) eps.push({ protocol: "rtmp", url: r.rtmps.url, streamKey: r.rtmps.streamKey });
  if (r.srt?.url) eps.push({ protocol: "srt", url: r.srt.url, streamKey: r.srt.streamId });
  return eps;
}

/**
 * Build the concrete `CfStreamLiveClient`. `createLiveInput` creates the input (recording=automatic) and writes the
 * uid→org binding. `req.feed` is carried for the caller; it does not alter the CREATE — a CF live_input accepts all
 * push protocols, and the feed mode only selects which returned endpoint the caller pushes to.
 */
export function makeCfStreamLiveClient(deps: CfStreamLiveClientDeps): CfStreamLiveClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    async createLiveInput(req: CfStreamLiveIngestRequest): Promise<CfStreamLiveResult> {
      let res: Response;
      try {
        res = await fetchImpl(`${CF_API}/accounts/${deps.accountId}/stream/live_inputs`, {
          method: "POST",
          headers: { authorization: `Bearer ${deps.apiToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            meta: { name: req.room },
            recording: { mode: "automatic" }, // #211: REQUIRED for live LL-HLS/HLS playback the bridge pulls
          }),
        });
      } catch (e) {
        return { ok: false, status: 0, reason: `cf stream api unreachable: ${String(e).slice(0, 160)}` };
      }

      if (!res.ok) {
        return { ok: false, status: res.status, reason: `cf stream live_inputs create failed: ${res.status}` };
      }

      let uid: string | undefined;
      let endpoints: CfStreamLiveEndpoint[];
      try {
        const body = (await res.json()) as { result?: CfLiveInputResult };
        uid = body.result?.uid;
        endpoints = parseEndpoints(body.result ?? {});
      } catch (e) {
        return { ok: false, status: res.status, reason: `cf stream response parse error: ${String(e).slice(0, 160)}` };
      }
      if (!uid) return { ok: false, status: res.status, reason: "cf stream response missing live_input uid" };

      // Persist the uid→org binding BEFORE returning ok. A KV failure leaves a harmless orphan CF input (no binding →
      // never dispatched) and is surfaced as a non-ok result, not a fake success.
      try {
        await deps.kv.put(`${STREAM_INPUT_ORG_PREFIX}${uid}`, req.org);
      } catch (e) {
        return { ok: false, status: 0, reason: `uid→org KV bind failed for ${uid}: ${String(e).slice(0, 160)}` };
      }

      return { ok: true, input: { uid, endpoints } };
    },
  };
}
