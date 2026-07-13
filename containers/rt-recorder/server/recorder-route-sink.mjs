// rt-recorder (#151, hosted) — RecorderRouteSink: stream the recording to the Worker recorder-ingest route
// so the RoomDO stays the SINGLE WRITER of the canonical R2 object (hosted / multi-client correct).
//
// WHY route-via-DO (not S3-direct): for HOSTED usage the Durable Object owns the one canonical object per
// session (single-writer / SKIP invariant, epic Risks). The self-host recorder is a THIRD PARTY — it never
// holds WAVE_INTERNAL_SECRET; the orchestrator (RoomDO) mints a short-lived, per-(org,session,track) capability
// token (recorder-auth.ts) and hands this process a PRE-SIGNED `endpoint?t=…`. This sink streams the WebM to
// that endpoint over ONE PUT whose body is an async-iterable — bytes flow as they are written (no full-file
// buffer), and the DO appends them to `RealtimeRecorder` via `appendFrom(request.body)`.
//
// Implements the same RecordingSink contract as src/encoders/recording-sink.ts (`write(part)`/`finalize()`/
// `abort()`/`key`) so it is interchangeable with R2Sink/LocalFsSink and drops straight into record-to-sink.mjs.

/**
 * @param {object} o
 * @param {string} o.endpoint   PRE-SIGNED ingest URL incl. `?t=<recorder-token>` (orchestrator-minted).
 * @param {string} o.org
 * @param {string} o.sessionId
 * @param {typeof fetch} [o.fetchImpl]
 * @param {Record<string,string>} [o.headers]   extra headers (e.g. x-wave-internal for internal dial).
 */
export function makeRecorderRouteSink({ endpoint, org, sessionId, fetchImpl, headers = {} }) {
  if (!endpoint) throw new Error("makeRecorderRouteSink: endpoint (pre-signed) required");
  const doFetch = (fetchImpl ?? fetch).bind(globalThis);

  const queue = [];
  let notify = null; // resolves the body generator's wait when a new part (or end) arrives
  let ended = false;
  let started = false;
  let reqPromise = null;
  let wroteAny = false;

  // The streaming request body: yields queued parts as they arrive, returns when finalize()/abort() ends it.
  async function* body() {
    for (;;) {
      if (queue.length) {
        yield queue.shift();
        continue;
      }
      if (ended) return;
      await new Promise((r) => (notify = r));
    }
  }

  function wake() {
    if (notify) {
      const r = notify;
      notify = null;
      r();
    }
  }

  function start() {
    started = true;
    reqPromise = doFetch(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", ...headers },
      body: body(),
      duplex: "half", // Node fetch: required when streaming a request body
    });
  }

  return {
    kind: "route",
    // Canonical key prefix (the DO owns the exact object key; this mirrors the R2 layout for logs/correlation).
    key: `${org}/realtime-recordings/${sessionId}/`,

    async write(part) {
      if (!part || part.length === 0) return;
      if (!started) start(); // lazy-begin on the first byte (never an empty PUT)
      wroteAny = true;
      queue.push(Buffer.from(part)); // copy — caller may reuse the buffer
      wake();
    },

    async finalize() {
      if (!started || !wroteAny) return null; // nothing streamed → no object
      ended = true;
      wake();
      const res = await reqPromise;
      const txt = await res.text();
      if (!res.ok) throw new Error(`recorder-ingest ${res.status}: ${txt.slice(0, 300)}`);
      try {
        return JSON.parse(txt); // { key, bytes, container } from the DO's finalize
      } catch {
        return { key: this.key, raw: txt.slice(0, 200) };
      }
    },

    async abort() {
      ended = true;
      wake();
      try {
        await reqPromise;
      } catch {
        /* best-effort — teardown must not throw */
      }
    },
  };
}
