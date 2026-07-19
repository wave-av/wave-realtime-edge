/**
 * B1 (#91-a) — CF Stream live webhook PAYLOAD-PARSE block, split out of stream-bridge.ts (task #11,
 * pure move — no behavior change) to keep the control-plane module under the file-size warn line.
 *
 * Tolerant, value-keyed parse of a CF Stream `live_input.*` webhook body: the lifecycle name and the
 * input uid can arrive under different keys / nesting depths across CF's live webhook surfaces (the
 * 2026-07-18 #8 dispatch outage was exactly this — see `LIFECYCLE_NAME_RE` below), so this walks the
 * whole (bounded) payload rather than assuming one root shape.
 */

/** Lifecycle states we act on. `connected` → start a republisher; `disconnected` → stop it. */
export type StreamLifecycle = "connected" | "disconnected" | "other";

/** The fields we read off a CF Stream `live_input.*` webhook payload (tolerant of field-name variants). */
export interface StreamBridgeEvent {
  uid: string; // the live_input uid (the dispatch lookup key — NEVER an org claim)
  lifecycle: StreamLifecycle;
  live?: boolean; // input is currently receiving a contribution feed (used by the cron lifecycle-poll)
  keys: string[]; // top-level payload key NAMES (never values) — diagnostics for an unmatched lifecycle
}

/**
 * The lifecycle event NAME as CF Stream writes it, e.g. `live_input.connected`. We match on this VALUE
 * rather than on a guessed key name: the 2026-07-18 dispatch outage (#8) was a live push landing in the
 * `other` branch because the payload carried its name under a key this parser did not list, so the whole
 * container-bridge control plane silently no-opped while every unit test stayed green (the tests asserted
 * our own invented shape back at us). A value-keyed match cannot regress that way — CF may rename the
 * FIELD, but `live_input.connected` is the documented event identifier.
 */
const LIFECYCLE_NAME_RE = /^live[._]?input\.(connected|disconnected)$/;

/**
 * Depth/size bounds for the payload walk. The body is UNVETTED third-party input, so the walk is
 * bounded on both axes: a hostile or pathological payload must not turn parsing into a CPU sink.
 * Depth 6 comfortably covers CF's observed 2-level shape with headroom for future nesting.
 */
const MAX_DEPTH = 6;
const MAX_NODES = 500;

interface Field {
  path: string; // dotted path, e.g. "data.event_type"
  key: string; // leaf key name
  value: unknown;
  depth: number;
}

/**
 * Walk EVERY field at EVERY depth (objects and arrays), breadth-first so shallower matches win.
 *
 * Deliberately generic rather than a list of known envelope keys: CF's documented body nests the
 * real fields under `data` ({ name, text, ts, data: { input_id, event_type, ... } }), which is what
 * defeated the original root-only parser — but hardcoding `data` just relocates the same guess one
 * level down. We do not control this schema and cannot know what a future shape nests under, so we
 * search by field identity at any depth instead of by assumed position. Cycle-safe via `seen`.
 */
function walkFields(root: Record<string, unknown>): Field[] {
  const out: Field[] = [];
  const seen = new WeakSet<object>();
  let queue: { obj: unknown; path: string; depth: number }[] = [{ obj: root, path: "", depth: 0 }];

  while (queue.length && out.length < MAX_NODES) {
    const next: typeof queue = [];
    for (const { obj, path, depth } of queue) {
      if (!obj || typeof obj !== "object" || depth > MAX_DEPTH) continue;
      if (seen.has(obj)) continue; // guards self-referential payloads
      seen.add(obj);
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        if (out.length >= MAX_NODES) break;
        const p = path ? `${path}.${key}` : key;
        out.push({ path: p, key, value, depth });
        if (value && typeof value === "object") next.push({ obj: value, path: p, depth: depth + 1 });
      }
    }
    queue = next;
  }
  return out;
}

/** String values that look like a lifecycle event name, whatever key OR nesting depth they arrived under. */
function nameCandidates(j: Record<string, unknown>): string[] {
  return walkFields(j)
    .filter((f): f is Field & { value: string } => typeof f.value === "string")
    .map((f) => f.value.toLowerCase())
    .filter((v) => LIFECYCLE_NAME_RE.test(v));
}

function lifecycleOf(j: Record<string, unknown>): StreamLifecycle {
  // Value-keyed match first — key-name-independent, so a CF field rename cannot silently stop dispatch.
  for (const v of nameCandidates(j)) {
    return v.endsWith(".disconnected") ? "disconnected" : "connected";
  }
  // Legacy key-keyed fallback: tolerates shapes that carry a bare name (`connected`) with no `live_input.` prefix.
  const name = String(
    firstOf(j, ["notificationName", "eventType", "event_type", "event", "notification_name"]) ?? "",
  ).toLowerCase();
  if (!name.includes("connected")) return "other";
  return name.includes("disconnect") ? "disconnected" : "connected";
}

/**
 * First non-empty string whose KEY is one of `keys`, at any depth. `walkFields` is breadth-first, so a
 * root-level field wins over a deeper one of the same name; `keys` order breaks ties within a level.
 */
function firstOf(j: Record<string, unknown>, keys: string[]): string | undefined {
  const fields = walkFields(j).filter((f) => typeof f.value === "string" && f.value !== "");
  for (const f of fields) {
    if (keys.includes(f.key)) return f.value as string;
  }
  return undefined;
}

/**
 * Parse a CF Stream live webhook body. Tolerant of the lifecycle name arriving under ANY key (matched by
 * value, see `lifecycleOf`) and of `input_id`/`uid`/`live_input.uid` for the input id — CF's payload shape
 * varies across the live webhook surfaces. Returns null if there is no usable uid.
 */
export function parseStreamEvent(rawText: string): StreamBridgeEvent | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    return null;
  }
  // CF's real body nests the uid at `data.input_id`; earlier shapes carry it at the root or under
  // `live_input`. Search every scope rather than assuming one — reading only the root is what made a
  // real push parse to nothing.
  const uid = firstOf(j, ["input_id", "uid", "inputId"]) ?? "";
  if (!uid) return null;
  const lifecycle = lifecycleOf(j);
  const fields = walkFields(j);
  const live = fields.find((f) => f.key === "live" && typeof f.value === "boolean")?.value as
    | boolean
    | undefined;
  // Dotted key PATHS at every depth (names only, never values) so an unmatched lifecycle names the
  // shape that failed — that log line is how the next schema change gets diagnosed in one read.
  const keys = fields.map((f) => f.path);
  return { uid, lifecycle, live, keys };
}
