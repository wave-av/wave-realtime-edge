/// <reference types="@cloudflare/workers-types" />
/**
 * RT-R10 (#72) — RecorderTarget dispatch seam: WHERE the JPEG→VP8 (and future PCM→Opus) encode happens.
 *
 * The portable recorder is ONE container image runnable two ways; this seam picks the runtime by env:
 *   • CfContainerTarget  — getContainer(env.RECORDER, id).fetch('/encode')   (Path A, CF Containers)
 *   • SelfHostTarget     — fetch(`${env.RECORDER_SELFHOST_URL}/encode`)       (Path B, on-prem docker run)
 *   • NoneTarget         — returns null → video frame is DROPPED (live default; prod untouched, audio-only)
 * `selectRecorderTarget(env)` chooses by `RECORDER_TARGET` (default `'none'`). The chosen target is wired into
 * the #59 `VideoEncoder` seam (container-adapter.ts RawSfuTap.videoEncoder) so a JPEG frame routes to the
 * encoder and the returned VP8 bytes become a video SimpleBlock.
 *
 * INERT BY DEFAULT (epic INERT INVARIANT): `RECORDER_TARGET` is `'none'` until a Jake-named ◆ flips it, so by
 * default video is dropped and no container/self-host is ever reached. The `[[containers]] RECORDER` binding
 * stays COMMENTED in wrangler.toml (Path A attach is a ◆), so `env.RECORDER` is absent → CfContainerTarget is
 * unreachable even if mis-selected (it degrades to a dropped frame, fail-open).
 *
 * FAIL-OPEN (epic Risks): every `encode()` returns `null` on ANY error (binding absent, fetch failure, non-2xx,
 * empty body). A null → the muxer drops that one video frame; recording is best-effort and NEVER blocks
 * publish/leave (the caller's RawSfuTap already drops a null/empty VP8). The container is PURE transcode — this
 * module never writes R2, never hashes, never imports `@wave-av/content-hash` (SKIP invariant; bundle-guarded).
 */
import type { Container } from "@cloudflare/containers";
import type { VideoEncoder } from "./container-adapter.js";

/**
 * A consuming end's capability surface (#86/#135) — the EXACT shape the rt-encoder server's negotiate.mjs /
 * leg-select.mjs already parse out of `x-dst-capabilities` (base64 JSON). Mirror it verbatim — do NOT invent
 * a new schema. Only the fields the selector reads are modeled: `decode[]` (which codecs the consumer can
 * decode), `transports[]` (which pipes it speaks + whether activated), and `region` (continent placement for
 * live legs). All optional/absence-tolerant so an unknown consumer degrades safely.
 */
export interface DstCapabilityDescriptor {
  /** Continent-prefixable region (e.g. "us-east"). Used only for live-leg same-continent placement. */
  region?: string;
  /** Codecs the consumer can DECODE — registry codec name + availability (selector reads available:true). */
  decode?: Array<{ name: string; available: boolean }>;
  /** Transports the consumer speaks — protocol + whether it is activated on this end. */
  transports?: Array<{ protocol: string; activated: boolean }>;
}

/** What an encode needs to know about the frame (mirrors the container's `/encode` headers). */
export interface FrameMeta {
  /** Media kind — the recorder routes video frames through here; audio is PCM-passthrough in-isolate. */
  kind: "video" | "audio";
  /** Source timestamp in ms (relative to session start). */
  ts: number;
  /** SOURCE codec the bytes are in: "jpeg" (video) | "pcm" (audio). The container transcodes jpeg→vp8 / pcm→opus. */
  codec: "jpeg" | "pcm";
  /**
   * #135 negotiation wiring (default-OFF). The CONSUMER's capability descriptor for THIS leg. Attached as the
   * `x-dst-capabilities` header ONLY when `negotiate` is true (NEGOTIATION_ENABLED on the caller side). When
   * `negotiate` is false/absent the header is NEVER sent → the `/encode` request is byte-identical to today,
   * even if a descriptor is present. Honest-fail: a present descriptor with the flag ON drives a real
   * server-side leg selection (→ x-negotiated-transport, or 422 + x-negotiation-reason on an unsatisfiable leg).
   */
  dst?: DstCapabilityDescriptor;
  /** #135: opt-in gate. True only when the operator has armed NEGOTIATION_ENABLED. Default-off → header omitted. */
  negotiate?: boolean;
  /** #135: live-leg hint → server enforces same-continent region placement. Only emitted when `negotiate`. */
  live?: boolean;
}

/**
 * Base64-encode the dst descriptor exactly as the server's parseDstDescriptor expects (base64 of the JSON).
 * `btoa` is present in the Workers runtime AND in the self-host Node runtime (Node ≥16 globalThis.btoa).
 */
function encodeDstHeader(dst: DstCapabilityDescriptor): string {
  return btoa(JSON.stringify(dst));
}

/**
 * A runtime that encodes ONE decoded frame → encoded bytes, or `null` when it can't (fail-open). Async because
 * both live runtimes (CF Container fetch, self-host fetch) are network round-trips.
 */
export interface RecorderTarget {
  /** Which runtime this is (log/correlation). */
  readonly kind: "cf" | "selfhost" | "none";
  encode(frame: Uint8Array, meta: FrameMeta): Promise<Uint8Array | null>;
}

/** Env keys this seam reads. Optional everywhere — absence degrades to a dropped frame (fail-open). */
export interface RecorderTargetEnv {
  /** Selector: which runtime encodes video frames. Default 'none' (drop video; prod untouched). */
  RECORDER_TARGET?: "cf" | "selfhost" | "none";
  /** Path A — the CF Container binding (getContainer). COMMENTED in wrangler.toml until the ◆ attach → absent here. */
  RECORDER?: DurableObjectNamespace<Container>;
  /** Path B — base URL of the self-hosted rt-encoder service (e.g. https://studio:8080). */
  RECORDER_SELFHOST_URL?: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Build the `/encode` request init (headers + raw body) shared by the cf + selfhost targets. */
function encodeInit(frame: Uint8Array, meta: FrameMeta): RequestInit {
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "x-kind": meta.kind,
    "x-ts": String(Math.max(0, Math.floor(meta.ts))),
    "x-codec": meta.codec,
  };
  // #135 NEGOTIATION WIRING (default-OFF). Attach the consumer descriptor ONLY when the operator armed
  // negotiation AND a real descriptor was sourced. Flag OFF (or no descriptor) → emit NOTHING new → this
  // request is byte-identical to the proven path. The server stamps x-negotiated-transport on success, or
  // 422 + x-negotiation-reason on an unsatisfiable leg (read by the fail-open caller as a dropped frame).
  if (meta.negotiate && meta.dst) {
    headers["x-dst-capabilities"] = encodeDstHeader(meta.dst);
    if (meta.live) headers["x-live"] = "1";
  }
  return {
    method: "POST",
    headers,
    body: frame as unknown as BodyInit,
  };
}

/** Read the encoded bytes from a `/encode` response, or null on a non-2xx / empty body (fail-open). */
async function readEncoded(res: Response): Promise<Uint8Array | null> {
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0) return null;
  return new Uint8Array(buf);
}

/** The live default getContainer impl (a plain DO-stub-by-name). Exported so a proof/diagnostic caller uses the
 *  EXACT resolution the recorder path uses, not a divergent hand-rolled one. */
export const defaultGetContainer = (ns: DurableObjectNamespace<Container>, id: string): Container =>
  ns.get(ns.idFromName(id)) as unknown as Container;

/**
 * The raw `/encode` container round-trip — resolve the container by id and POST the frame with the negotiation
 * headers `encodeInit` builds. Returns the RAW `Response` (headers intact) so a canary proof route can read the
 * negotiated response headers (`x-output-codec` / `x-negotiated-transport`) that `encode()` discards on its way
 * to the muxer. This is the SAME call the live recorder makes — the proof exercises the real wiring, not a copy.
 */
export async function fetchContainerEncode(
  binding: DurableObjectNamespace<Container>,
  getContainerImpl: (ns: DurableObjectNamespace<Container>, id: string) => Container,
  frame: Uint8Array,
  meta: FrameMeta,
  containerId = "rt-encoder",
): Promise<Response> {
  const container = getContainerImpl(binding, containerId);
  return container.fetch(new Request("http://rt-encoder/encode", encodeInit(frame, meta)));
}

/** Path A — encode via a CF Container fronted by the Worker. `getContainer` is injected for unit testing. */
export class CfContainerTarget implements RecorderTarget {
  readonly kind = "cf" as const;
  constructor(
    private readonly binding: DurableObjectNamespace<Container>,
    private readonly getContainerImpl: (ns: DurableObjectNamespace<Container>, id: string) => Container,
    /** Stable container id per session keeps frames on one warm instance (override for tests/sharding). */
    private readonly containerId = "rt-encoder",
  ) {}

  async encode(frame: Uint8Array, meta: FrameMeta): Promise<Uint8Array | null> {
    try {
      const res = await fetchContainerEncode(this.binding, this.getContainerImpl, frame, meta, this.containerId);
      return await readEncoded(res);
    } catch {
      return null; // fail-open — drop this one frame, never throw the media path
    }
  }
}

/** Path B — encode via a self-hosted rt-encoder service over HTTP. `fetchImpl` injectable for tests. */
export class SelfHostTarget implements RecorderTarget {
  readonly kind = "selfhost" as const;
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  constructor(baseUrl: string, fetchImpl?: FetchLike) {
    this.base = baseUrl.replace(/\/+$/, "");
    // Bind to globalThis: native `fetch` throws "Illegal invocation" when called as `this.fetchImpl(...)`.
    this.fetchImpl = (fetchImpl ?? fetch).bind(globalThis);
  }

  async encode(frame: Uint8Array, meta: FrameMeta): Promise<Uint8Array | null> {
    try {
      const res = await this.fetchImpl(`${this.base}/encode`, encodeInit(frame, meta));
      return await readEncoded(res);
    } catch {
      return null; // fail-open
    }
  }
}

/** The inert default — no encoder runtime; every video frame is dropped (audio-only path unchanged). */
export class NoneTarget implements RecorderTarget {
  readonly kind = "none" as const;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async encode(_frame: Uint8Array, _meta: FrameMeta): Promise<Uint8Array | null> {
    return null;
  }
}

/** Injectable getContainer (so the cf path unit-tests without `@cloudflare/containers` runtime). */
export interface SelectTargetDeps {
  getContainer?: (ns: DurableObjectNamespace<Container>, id: string) => Container;
  fetchImpl?: FetchLike;
}

/**
 * Select the recorder target for this env. DEFAULT `'none'` (drop video; prod untouched). `'cf'` requires the
 * RECORDER binding (commented out until the ◆ attach) — absent → NoneTarget (fail-open, never a broken
 * selection). `'selfhost'` requires RECORDER_SELFHOST_URL — absent → NoneTarget. Loud-warns on a misconfigured
 * non-none selection (config-no-silent-noop) but NEVER throws.
 */
export function selectRecorderTarget(env: RecorderTargetEnv, deps: SelectTargetDeps = {}): RecorderTarget {
  const sel = env.RECORDER_TARGET ?? "none";
  if (sel === "cf") {
    if (!env.RECORDER || typeof env.RECORDER.idFromName !== "function") {
      console.warn(JSON.stringify({ msg: "rt-recorder-target-cf-unbound", note: "[[containers]] RECORDER absent" }));
      return new NoneTarget();
    }
    const getC = deps.getContainer ?? defaultGetContainer;
    return new CfContainerTarget(env.RECORDER, getC);
  }
  if (sel === "selfhost") {
    if (!env.RECORDER_SELFHOST_URL || !/^https?:\/\//.test(env.RECORDER_SELFHOST_URL)) {
      console.warn(JSON.stringify({ msg: "rt-recorder-target-selfhost-unconfigured" }));
      return new NoneTarget();
    }
    return new SelfHostTarget(env.RECORDER_SELFHOST_URL, deps.fetchImpl);
  }
  return new NoneTarget();
}

/**
 * Adapt a RecorderTarget to the #59 `VideoEncoder` seam (container-adapter.ts RawSfuTap.videoEncoder). The
 * VideoEncoder seam is synchronous (`encode(jpeg): Uint8Array`), but a RecorderTarget is a network round-trip —
 * so this bridge is used by the orchestrator that has an async pre-encode step, OR a target that is already a
 * local sync transcode. For the async container/self-host path the orchestrator pre-encodes a frame and feeds
 * the resulting VP8 to the muxer directly; this synchronous adapter exists for the NoneTarget/local case and is
 * exported so the seam is testable without coupling the muxer to the network. Returns empty bytes on null
 * (the muxer drops empty VP8 → video dropped).
 */
export function videoEncoderFromSyncBytes(get: () => Uint8Array | null): VideoEncoder {
  return {
    codec: "vp8",
    encode: () => get() ?? new Uint8Array(0),
  };
}
