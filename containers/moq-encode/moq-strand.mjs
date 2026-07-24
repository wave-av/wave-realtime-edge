// moq-strand.ts
import { Buffer } from "node:buffer";

// moq-wire.ts
var MOQ_MSG = {
  SETUP: 12032,
  GOAWAY: 16,
  SUBSCRIBE: 3,
  SUBSCRIBE_OK: 4,
  REQUEST_ERROR: 5,
  PUBLISH_NAMESPACE: 6,
  REQUEST_OK: 7,
  REQUEST_UPDATE: 2,
  PUBLISH: 29,
  PUBLISH_DONE: 11,
  FETCH: 22,
  FETCH_OK: 24,
  TRACK_STATUS: 13,
  SUBSCRIBE_NAMESPACE: 80,
  NAMESPACE: 8,
  NAMESPACE_DONE: 14
};
var MOQ_OBJECT_STATUS = {
  NORMAL: 0,
  END_OF_GROUP: 3,
  END_OF_TRACK: 4
};
var MOQ_ROLE = { PUBLISHER: 0, SUBSCRIBER: 1, PUBSUB: 2 };

class Writer {
  buf = [];
  bytes() {
    return new Uint8Array(this.buf);
  }
  u8(v) {
    this.buf.push(v & 255);
    return this;
  }
  u16(v) {
    this.buf.push(v >> 8 & 255, v & 255);
    return this;
  }
  raw(b) {
    for (const x of b)
      this.buf.push(x);
    return this;
  }
  varint(value) {
    const v = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
    if (v < 0n)
      throw new RangeError("varint must be non-negative");
    let n = 9;
    for (let k = 1;k <= 8; k++) {
      if (v < 1n << BigInt(7 * k)) {
        n = k;
        break;
      }
    }
    if (n === 9 && v >= 1n << 64n)
      throw new RangeError("varint exceeds 2^64-1");
    const out = new Uint8Array(n);
    let tmp = v;
    for (let i = n - 1;i >= 0; i--) {
      out[i] = Number(tmp & 0xffn);
      tmp >>= 8n;
    }
    if (n <= 8)
      out[0] |= 255 << 9 - n & 255;
    else
      out[0] = 255;
    return this.raw(out);
  }
  bytesLP(b) {
    return this.varint(b.length).raw(b);
  }
  strLP(s) {
    return this.bytesLP(new TextEncoder().encode(s));
  }
  tuple(fields) {
    this.varint(fields.length);
    for (const f of fields)
      this.strLP(f);
    return this;
  }
}

class Reader {
  b;
  pos = 0;
  constructor(b) {
    this.b = b;
  }
  get offset() {
    return this.pos;
  }
  get remaining() {
    return this.b.length - this.pos;
  }
  u8() {
    if (this.pos >= this.b.length)
      throw new RangeError("read past end (u8)");
    return this.b[this.pos++];
  }
  u16() {
    const hi = this.u8();
    const lo = this.u8();
    return hi << 8 | lo;
  }
  raw(len) {
    if (this.pos + len > this.b.length)
      throw new RangeError("read past end (raw)");
    const out = this.b.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  varint() {
    const b0 = this.u8();
    let lead = 0;
    let probe = b0;
    while (lead < 8 && probe & 128) {
      lead++;
      probe = probe << 1 & 255;
    }
    if (lead === 8) {
      let v2 = 0n;
      for (let i = 0;i < 8; i++)
        v2 = v2 << 8n | BigInt(this.u8());
      return v2;
    }
    const n = lead + 1;
    let v = BigInt(b0 & 255 >> n);
    for (let i = 1;i < n; i++)
      v = v << 8n | BigInt(this.u8());
    return v;
  }
  varintNum() {
    const v = this.varint();
    if (v > BigInt(Number.MAX_SAFE_INTEGER))
      throw new RangeError("varint exceeds safe integer");
    return Number(v);
  }
  bytesLP() {
    const len = this.varintNum();
    return this.raw(len);
  }
  strLP() {
    return new TextDecoder().decode(this.bytesLP());
  }
  tuple() {
    const count = this.varintNum();
    const out = [];
    for (let i = 0;i < count; i++)
      out.push(this.strLP());
    return out;
  }
}
function frameControl(type, payload) {
  if (payload.length > 65535)
    throw new RangeError("control payload exceeds 16-bit length");
  return new Writer().varint(type).u16(payload.length).raw(payload).bytes();
}
function parseControl(bytes) {
  const r = new Reader(bytes);
  const type = r.varintNum();
  const len = r.u16();
  return { type, payload: r.raw(len) };
}
function encodeSetup(m) {
  const w = new Writer().varint(m.role).varint(m.maxSubscriptions);
  if (m.path !== undefined)
    w.varint(1).varint(1).strLP(m.path);
  else
    w.varint(0);
  return frameControl(MOQ_MSG.SETUP, w.bytes());
}
function encodeSubscribe(m) {
  const w = new Writer().varint(m.requestId).tuple(m.trackNamespace).strLP(m.trackName);
  return frameControl(MOQ_MSG.SUBSCRIBE, w.bytes());
}
function encodePublishNamespace(m) {
  const w = new Writer().varint(m.requestId).tuple(m.trackNamespace).varint(0);
  return frameControl(MOQ_MSG.PUBLISH_NAMESPACE, w.bytes());
}
var WS_KIND = { CONTROL: 0, OBJECT: 1 };
function tagFrame(kind, body) {
  const out = new Uint8Array(body.length + 1);
  out[0] = kind & 255;
  out.set(body, 1);
  return out;
}
function untagFrame(bytes) {
  if (bytes.length < 1)
    throw new RangeError("empty WS frame");
  return { kind: bytes[0], body: bytes.subarray(1) };
}
function encodeObject(o) {
  return new Writer().varint(o.trackAlias).varint(o.groupId).varint(o.objectId).varint(o.status).bytesLP(o.status === MOQ_OBJECT_STATUS.NORMAL ? o.payload : new Uint8Array(0)).bytes();
}
function decodeObject(bytes) {
  const r = new Reader(bytes);
  const trackAlias = r.varint();
  const groupId = r.varint();
  const objectId = r.varint();
  const status = r.varintNum();
  const payload = r.bytesLP();
  return { trackAlias, groupId, objectId, status, payload };
}

// moq-strand.ts
var RELAY = process.env.WAVE_MOQ_RELAY ?? "wss://moq.wave.online";
var PATH_BASE = process.env.WAVE_MOQ_PATH_PREFIX ?? "/v1";
var TOKEN = process.env.WAVE_MOQ_TOKEN ?? "";
var GATEWAY = process.env.WAVE_MOQ_GATEWAY ?? "https://api.wave.online";
function joinEnabled() {
  const v = (process.env.WAVE_MOQ_JOIN ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}
var DECLARED_PROTOCOL = (process.env.WAVE_MOQ_PROTOCOL ?? "").trim().toLowerCase();
var GROUP_SIZE = 30;
function log(...a) {
  process.stderr.write(`[moq-strand] ${a.join(" ")}
`);
}
function frameBody(body) {
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  Buffer.from(body.buffer, body.byteOffset, body.byteLength).copy(out, 4);
  return out;
}
function makeFramer(onFrame) {
  let acc = Buffer.alloc(0);
  return (chunk) => {
    acc = acc.length ? Buffer.concat([acc, chunk]) : chunk;
    for (;; ) {
      if (acc.length < 4)
        return;
      const len = acc.readUInt32BE(0);
      if (acc.length < 4 + len)
        return;
      onFrame(acc.subarray(4, 4 + len));
      acc = acc.subarray(4 + len);
    }
  };
}
async function resolveConnectUrl(role, ns, track) {
  const nsE = encodeURIComponent(ns), trackE = encodeURIComponent(track);
  if (joinEnabled()) {
    if (!TOKEN)
      throw new Error("WAVE_MOQ_JOIN set but WAVE_MOQ_TOKEN missing (cannot authorize the mint)");
    const method = role === "publish" ? "POST" : "GET";
    const headers = { authorization: `Bearer ${TOKEN}` };
    if (role === "publish" && DECLARED_PROTOCOL)
      headers["x-wave-declare-protocol"] = DECLARED_PROTOCOL;
    let res;
    try {
      res = await fetch(`${GATEWAY}/v1/moq/${role}/${nsE}/${trackE}`, { method, headers });
    } catch (e) {
      throw new Error(`join exchange network error: ${e?.message ?? e}`);
    }
    if (!res.ok)
      throw new Error(`join exchange rejected: HTTP ${res.status}`);
    const body = await res.json().catch(() => null);
    if (!body || typeof body.relayWsUrl !== "string" || typeof body.joinToken !== "string") {
      throw new Error("join exchange: missing relayWsUrl/joinToken");
    }
    const sep = body.relayWsUrl.includes("?") ? "&" : "?";
    return `${body.relayWsUrl}${sep}join=${encodeURIComponent(body.joinToken)}`;
  }
  const q = TOKEN ? `?access_token=${encodeURIComponent(TOKEN)}` : "";
  return `${RELAY}${PATH_BASE}/${role}/${nsE}/${trackE}${q}`;
}
function connectUrl(url) {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", (e) => reject(new Error(`ws error: ${e.message ?? "open failed"}`)), { once: true });
  });
}
function send(ws, kind, body) {
  ws.send(tagFrame(kind, body));
}
function waitControl(ws, type, timeoutMs = 1e4) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      ws.removeEventListener("message", onMsg);
      reject(new Error(`timeout waiting control 0x${type.toString(16)}`));
    }, timeoutMs);
    const onMsg = (ev) => {
      const bytes = new Uint8Array(ev.data);
      let f;
      try {
        f = untagFrame(bytes);
      } catch {
        return;
      }
      if (f.kind !== WS_KIND.CONTROL)
        return;
      let c;
      try {
        c = parseControl(f.body);
      } catch {
        return;
      }
      if (c.type !== type)
        return;
      clearTimeout(to);
      ws.removeEventListener("message", onMsg);
      resolve(c.payload);
    };
    ws.addEventListener("message", onMsg);
  });
}
function onPublisherWsClosed({ shuttingDown }) {
  return shuttingDown ? "ignore" : "exit";
}
function nextBackoffMs(attempt, jitter = Math.random) {
  const BASE_MS = 250, FACTOR = 2, CAP_MS = 5000;
  const raw = Math.min(BASE_MS * Math.pow(FACTOR, Math.max(0, attempt)), CAP_MS);
  return Math.min(raw + jitter() * raw * 0.25, CAP_MS);
}
function shouldReconnect({ shuttingDown, stdinEnded }) {
  return !shuttingDown && !stdinEnded;
}
async function runPublisher(ns, track) {
  let shuttingDown = false;
  let stdinEnded = false;
  let reconnects = 0;
  let count = 0;
  let ws = await connectViaResolve("publish", ns, track);
  const feed = makeFramer((body) => {
    const id = count;
    count++;
    if (!ws)
      return;
    send(ws, WS_KIND.OBJECT, encodeObject({
      trackAlias: 0n,
      groupId: BigInt(Math.floor(id / GROUP_SIZE)),
      objectId: BigInt(id),
      status: MOQ_OBJECT_STATUS.NORMAL,
      payload: new Uint8Array(body)
    }));
  });
  process.stdin.on("data", feed);
  process.stdin.on("end", () => {
    stdinEnded = true;
  });
  async function connectViaResolve(role, ns2, track2) {
    const url = await resolveConnectUrl(role, ns2, track2);
    const sock = await connectUrl(url);
    log(`connected pub ns=${ns2} track=${track2} mode=${joinEnabled() ? "join" : "legacy"}`);
    send(sock, WS_KIND.CONTROL, encodeSetup({ role: MOQ_ROLE.PUBLISHER, maxSubscriptions: 0n }));
    await waitControl(sock, MOQ_MSG.SETUP);
    send(sock, WS_KIND.CONTROL, encodePublishNamespace({ requestId: 1n, trackNamespace: [ns2] }));
    await waitControl(sock, MOQ_MSG.REQUEST_OK);
    log("publisher attached");
    return sock;
  }
  async function reconnectLoop() {
    let attempt = 0;
    while (shouldReconnect({ shuttingDown, stdinEnded })) {
      const delay = nextBackoffMs(attempt);
      attempt++;
      reconnects++;
      log(`MOQ_STRAND_RECONNECT attempt=${attempt}`);
      await new Promise((r) => setTimeout(r, delay));
      if (!shouldReconnect({ shuttingDown, stdinEnded }))
        return;
      try {
        ws = null;
        const sock = await connectViaResolve("publish", ns, track);
        ws = sock;
        process.stderr.write(`MOQ_STRAND_READY
`);
        attachSocketHandlers(sock);
        return;
      } catch (e) {
        log(`reconnect attempt=${attempt} failed: ${e?.message ?? e}`);
      }
    }
  }
  function attachSocketHandlers(sock) {
    sock.addEventListener("close", () => {
      if (sock !== ws)
        return;
      if (onPublisherWsClosed({ shuttingDown }) === "exit") {
        log("publisher ws closed unexpectedly — reconnecting");
        ws = null;
        reconnectLoop();
      }
    });
    sock.addEventListener("error", (e) => {
      if (sock !== ws)
        return;
      log(`publisher ws error: ${e?.message ?? e} — reconnecting`);
    });
  }
  process.stderr.write(`MOQ_STRAND_READY
`);
  attachSocketHandlers(ws);
  await new Promise((resolve) => process.stdin.on("end", resolve));
  log(`stdin closed after ${count} objects; draining (reconnects=${reconnects})`);
  await new Promise((r) => setTimeout(r, 250));
  shuttingDown = true;
  if (ws)
    ws.close();
}
async function runSubscriber(ns, track) {
  let shuttingDown = false;
  let reconnects = 0;
  let received = 0;
  async function connectAndSubscribe() {
    const url = await resolveConnectUrl("subscribe", ns, track);
    const sock = await connectUrl(url);
    log(`connected sub ns=${ns} track=${track} mode=${joinEnabled() ? "join" : "legacy"}`);
    sock.addEventListener("message", (ev) => {
      const bytes = new Uint8Array(ev.data);
      let f;
      try {
        f = untagFrame(bytes);
      } catch {
        return;
      }
      if (f.kind !== WS_KIND.OBJECT)
        return;
      let o;
      try {
        o = decodeObject(f.body);
      } catch {
        return;
      }
      if (o.status !== MOQ_OBJECT_STATUS.NORMAL || o.payload.length === 0)
        return;
      process.stdout.write(frameBody(o.payload));
      received++;
    });
    send(sock, WS_KIND.CONTROL, encodeSetup({ role: MOQ_ROLE.SUBSCRIBER, maxSubscriptions: 0n }));
    await waitControl(sock, MOQ_MSG.SETUP);
    send(sock, WS_KIND.CONTROL, encodeSubscribe({ requestId: 1n, trackNamespace: [ns], trackName: track }));
    await waitControl(sock, MOQ_MSG.SUBSCRIBE_OK);
    log("subscribed");
    return sock;
  }
  let ws = await connectAndSubscribe();
  process.stderr.write(`MOQ_STRAND_READY
`);
  await new Promise((resolveOuter) => {
    process.stdout.on("error", () => {
      shuttingDown = true;
      resolveOuter();
    });
    function attachCloseHandler(sock) {
      sock.addEventListener("close", () => {
        if (sock !== ws)
          return;
        log(`socket closed; received=${received}`);
        if (shuttingDown) {
          resolveOuter();
          return;
        }
        reconnectLoop();
      });
    }
    async function reconnectLoop() {
      let attempt = 0;
      while (shouldReconnect({ shuttingDown, stdinEnded: false })) {
        const delay = nextBackoffMs(attempt);
        attempt++;
        reconnects++;
        log(`MOQ_STRAND_RECONNECT attempt=${attempt}`);
        await new Promise((r) => setTimeout(r, delay));
        if (!shouldReconnect({ shuttingDown, stdinEnded: false }))
          break;
        try {
          const sock = await connectAndSubscribe();
          ws = sock;
          process.stderr.write(`MOQ_STRAND_READY
`);
          attachCloseHandler(sock);
          return;
        } catch (e) {
          log(`reconnect attempt=${attempt} failed: ${e?.message ?? e}`);
        }
      }
      resolveOuter();
    }
    attachCloseHandler(ws);
  });
  log(`subscriber done; received=${received} reconnects=${reconnects}`);
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const [mode, ns, track] = process.argv.slice(2);
  if (!mode || !ns || !track) {
    log("usage: moq-strand.ts <pub|sub> <namespace> <track>");
    process.exit(2);
  }
  const run = mode === "pub" ? runPublisher : mode === "sub" ? runSubscriber : null;
  if (!run) {
    log(`unknown mode: ${mode}`);
    process.exit(2);
  }
  run(ns, track).catch((e) => {
    log(`FATAL ${e?.stack ?? e}`);
    process.exit(1);
  });
}
export {
  shouldReconnect,
  onPublisherWsClosed,
  nextBackoffMs
};
