// media-tap.ts — E-MEDIA-TAP (#74): the ONE room-subscribe surface. Egress (record/composite the room) and the
// GA #85 perception agents (watch/act on the room) both need the SAME thing — a subscription to a room's live
// media. Build it ONCE as a MediaTap and make both consumers, so no consumer opens its own parallel SFU/LiveKit
// subscription (transform-once fan-out-many; one authoritative subscribe path). A frame published into the tap
// fans out to every authorized consumer whose selector matches, each behind a BOUNDED queue: a slow consumer
// drops its OWN oldest frames (backpressure) and never stalls the source or its peers (consumer isolation).
//
// This file is the PURE engine + the server-side consumer contract. It holds no SFU, no Durable Object, no I/O —
// the RoomDO resolves each decoded frame's (participantId,kind) from its registry and calls publish(); real
// consumers (the egress router #75, #85 perception #76) implement MediaConsumer and drain via pumpConsumer. The
// engine is deterministic (arrival time is passed in, never read here) so the fan-out/backpressure/isolation
// invariants are provable hermetically.
import type { TrackKind } from "./room.js";
import type { RoomState } from "./room.js";

/** Default per-consumer queue depth. A consumer this far behind drops its oldest frame on the next push — the
 *  backpressure signal. Sized for ~1s of 50fps video / audio packetization; a real consumer keeps depth ~0. */
export const DEFAULT_HIGH_WATER = 50;

/** A decoded media frame flowing through the tap. Timing + track identity travel WITH the bytes so a consumer
 *  needs no side-channel: `seq` is a monotonic per-tap ordering signal, `ts` is the source arrival time (ms). */
export interface TapFrame {
  /** Publisher's CF Realtime SFU session id (opaque). */
  readonly sessionId: string;
  readonly trackName: string;
  readonly kind: TrackKind;
  /** Room participant that owns the track (resolved from the room registry by the source). */
  readonly participantId: string;
  /** Monotonic per-tap sequence — strictly increasing across every frame the tap emits (ordering + gap detect). */
  readonly seq: number;
  /** Source arrival time (ms). Passed in by the caller — the engine never reads the clock (determinism). */
  readonly ts: number;
  readonly bytes: Uint8Array;
}

/** The already-resolved frame input the source hands to publish() — the DO resolves participantId+kind from its
 *  room registry (the SSOT) BEFORE calling, keeping this engine free of any room/SFU dependency. */
export interface TapFrameInput {
  readonly sessionId: string;
  readonly trackName: string;
  readonly kind: TrackKind;
  readonly participantId: string;
  readonly ts: number;
  readonly bytes: Uint8Array;
}

/** What a consumer wants. Least-privilege: an omitted field is NOT "give me everything" by default at the authz
 *  layer — that decision is the caller's; here an omitted field simply doesn't constrain the match. A consumer
 *  should pass the narrowest selector it needs (a recorder wants all tracks; a captioner wants kind:["audio"]). */
export interface TapSelector {
  readonly kinds?: readonly TrackKind[];
  readonly trackNames?: readonly string[];
  readonly participantIds?: readonly string[];
}

/** Per-consumer counters — the receipt that a tap fanned out to a consumer and how backpressure behaved. */
export interface TapConsumerStats {
  readonly consumerId: string;
  /** Frames handed to the consumer (via next()). */
  readonly delivered: number;
  /** Frames dropped because the consumer's queue was full when a new frame arrived (backpressure). */
  readonly dropped: number;
  /** Current queue depth (frames buffered, awaiting next()). */
  readonly depth: number;
}

/** Whole-tap receipt: the sequence high-water mark + a per-consumer breakdown. */
export interface TapStats {
  readonly seq: number;
  readonly consumers: readonly TapConsumerStats[];
}

/** The handle a consumer drains. next() resolves with the next frame, or null once the consumer is closed. */
export interface TapConsumerHandle {
  readonly consumerId: string;
  next(): Promise<TapFrame | null>;
  close(): void;
  stats(): TapConsumerStats;
}

/**
 * A bounded single-consumer frame queue. push() is non-blocking and NEVER runs consumer code — that is what
 * isolates the source from a slow consumer: the source only ever appends (or drops the oldest), the consumer
 * drains at its own pace via next(). When the buffer is at high-water, the oldest frame is evicted so the newest
 * always survives (live media prefers fresh over complete). A pending next() is fed directly, bypassing the buffer.
 */
class BoundedFrameQueue {
  private buf: TapFrame[] = [];
  private waiter: ((f: TapFrame | null) => void) | null = null;
  private closed = false;
  private deliveredCount = 0;
  private droppedCount = 0;

  constructor(private readonly highWater: number) {}

  push(frame: TapFrame): void {
    if (this.closed) return;
    // A consumer parked in next() gets the frame directly — the buffer stays empty, no drop possible.
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      this.deliveredCount++;
      resolve(frame);
      return;
    }
    // Full → evict oldest (backpressure). The source never blocks and never touches another consumer.
    if (this.buf.length >= this.highWater) {
      this.buf.shift();
      this.droppedCount++;
    }
    this.buf.push(frame);
  }

  next(): Promise<TapFrame | null> {
    const buffered = this.buf.shift();
    if (buffered !== undefined) {
      this.deliveredCount++;
      return Promise.resolve(buffered);
    }
    if (this.closed) return Promise.resolve(null);
    // Only one drainer per consumer — a second concurrent next() replaces the first (documented single-drainer).
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.buf = [];
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(null);
    }
  }

  get delivered(): number {
    return this.deliveredCount;
  }
  get dropped(): number {
    return this.droppedCount;
  }
  get depth(): number {
    return this.buf.length;
  }
}

/** True iff the frame's (kind, trackName, participantId) satisfies every constraint the selector expresses. */
export function selectorMatches(sel: TapSelector, frame: { kind: TrackKind; trackName: string; participantId: string }): boolean {
  if (sel.kinds && !sel.kinds.includes(frame.kind)) return false;
  if (sel.trackNames && !sel.trackNames.includes(frame.trackName)) return false;
  if (sel.participantIds && !sel.participantIds.includes(frame.participantId)) return false;
  return true;
}

/**
 * MediaTap — one room's fan-out surface. subscribe() registers a consumer with a selector + bounded queue;
 * publish() stamps a frame with a monotonic seq and pushes it into every matching consumer's queue. publish()
 * runs NO consumer code (only queue.push), so one slow/absent consumer can never stall the source or its peers —
 * the isolation + backpressure guarantee the epic requires. Not thread-shared: a Durable Object serializes calls.
 */
export class MediaTap {
  private readonly consumers = new Map<string, { selector: TapSelector; queue: BoundedFrameQueue }>();
  private seq = 0;

  constructor(private readonly highWater: number = DEFAULT_HIGH_WATER) {}

  /** Register a consumer. Re-subscribing the same id closes the prior handle first (one queue per id). */
  subscribe(consumerId: string, selector: TapSelector = {}): TapConsumerHandle {
    this.consumers.get(consumerId)?.queue.close();
    const queue = new BoundedFrameQueue(this.highWater);
    this.consumers.set(consumerId, { selector, queue });
    const stats = (): TapConsumerStats => ({ consumerId, delivered: queue.delivered, dropped: queue.dropped, depth: queue.depth });
    return {
      consumerId,
      next: () => queue.next(),
      close: () => this.unsubscribe(consumerId),
      stats,
    };
  }

  /** Fan a resolved frame out to every matching consumer. Returns how many consumers it reached (0 = no match). */
  publish(input: TapFrameInput): number {
    const frame: TapFrame = {
      sessionId: input.sessionId,
      trackName: input.trackName,
      kind: input.kind,
      participantId: input.participantId,
      seq: ++this.seq,
      ts: input.ts,
      bytes: input.bytes,
    };
    let reached = 0;
    for (const consumer of this.consumers.values()) {
      if (selectorMatches(consumer.selector, frame)) {
        consumer.queue.push(frame);
        reached++;
      }
    }
    return reached;
  }

  unsubscribe(consumerId: string): void {
    const consumer = this.consumers.get(consumerId);
    if (!consumer) return;
    consumer.queue.close();
    this.consumers.delete(consumerId);
  }

  get consumerCount(): number {
    return this.consumers.size;
  }

  stats(): TapStats {
    const consumers: TapConsumerStats[] = [];
    for (const [consumerId, { queue }] of this.consumers) {
      consumers.push({ consumerId, delivered: queue.delivered, dropped: queue.dropped, depth: queue.depth });
    }
    return { seq: this.seq, consumers };
  }
}

// ── Consumer contract (P3): the thin adapter egress (#75) and #85 perception (#76) attach through ─────────────

/**
 * A server-side consumer of a room's media. The egress compositor and the perception agents each implement this
 * and attach via pumpConsumer — NOTHING else opens a room subscription. onFrame is where the consumer does its
 * work (write to a container, forward to the gateway, …); a throw there is isolated (see pumpConsumer).
 */
export interface MediaConsumer {
  readonly id: string;
  readonly selector: TapSelector;
  onFrame(frame: TapFrame): void | Promise<void>;
  /** Called once when the tap closes the handle (room ended / consumer evicted). */
  onClose?(): void;
}

/**
 * Drive a consumer off its handle until the handle closes. This is where consumer isolation is enforced at the
 * delivery boundary: an onFrame that throws is swallowed (logged by the consumer, not fatal here) so one buggy
 * consumer can neither crash the pump nor — because the tap already decoupled them via the bounded queue — affect
 * any other consumer or the source. Returns when next() yields null (closed).
 */
export async function pumpConsumer(handle: TapConsumerHandle, consumer: MediaConsumer): Promise<void> {
  for (;;) {
    const frame = await handle.next();
    if (frame === null) break;
    try {
      await consumer.onFrame(frame);
    } catch {
      /* isolate: a consumer defect never stalls the pump, the source, or a peer consumer */
    }
  }
  consumer.onClose?.();
}

// ── DO-side helpers: flag gate + registry resolution ──────────────────────────────────────────────────────────

/** Env flag. INERT by default → the RoomDO builds the tap but publishes nothing, so prod is byte-identical until
 *  MEDIA_TAP_ENABLED is armed (a Jake-floor crossing, like PRESENCE_ENABLED). */
export function mediaTapEnabled(env: { MEDIA_TAP_ENABLED?: string | boolean }): boolean {
  const v = env.MEDIA_TAP_ENABLED;
  return v === true || v === "1" || v === "true";
}

/** Resolve a decoded frame's (participantId, kind) from the room registry SSOT — the tap needs both to match a
 *  selector. Matches a registered track by trackName owned by the frame's SFU session. Returns null when the
 *  track/session is unknown (fail-closed: an unresolvable frame fans out to no one). */
export function resolveTapTrack(
  state: RoomState,
  sessionId: string,
  trackName: string,
): { participantId: string; kind: TrackKind } | null {
  const track = state.tracks[trackName];
  if (track && track.sessionId === sessionId) {
    return { participantId: track.participantId, kind: track.kind };
  }
  return null;
}

/**
 * DO frame-sink glue: publish one decoded frame into the tap IFF armed. Inert (returns immediately) when
 * MEDIA_TAP_ENABLED is falsy, so the RoomDO's recorder path is byte-identical until the tap is switched on. The
 * snapshot is read lazily (only when armed) to resolve the track's (participant,kind) from the registry SSOT.
 * Fail-open: a fan-out defect (e.g. a snapshot read that throws) is swallowed — the tap is best-effort and must
 * NEVER break the frame path (media-safety > fan-out), so any caller of feedRecorderFrame stays throw-free.
 */
export async function tapPublishFrame(
  tap: MediaTap,
  env: { MEDIA_TAP_ENABLED?: string | boolean },
  snapshot: () => Promise<RoomState>,
  sessionId: string,
  trackName: string,
  frame: Uint8Array,
  now: number,
): Promise<void> {
  if (!mediaTapEnabled(env)) return;
  try {
    const meta = resolveTapTrack(await snapshot(), sessionId, trackName);
    if (meta) tap.publish({ ...meta, sessionId, trackName, bytes: frame, ts: now });
  } catch {
    /* fail-open — media-tap fan-out never blocks or throws the frame path */
  }
}
