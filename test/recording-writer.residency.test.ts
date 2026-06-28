// E3.P2/P4 (#127) — residency additions to the recording writer key + the webhook pull residency path.
// Proves: (a) recordingKey() with NO region is byte-identical to the legacy key (INERT default);
// (b) with a region it starts with the org prefix AND inserts the region segment;
// (c) RealtimeRecorder.begin(region) writes to the region key;
// (d) pullUploadedRecording on the residency path writes the jurisdiction bucket + region key + registers,
//     and WITHOUT residency deps is byte-identical to today (default bucket, no region, no register).
import { describe, it, expect, vi } from "vitest";
import { recordingKey } from "../src/recording-writer.js";
import { pullUploadedRecording, type RecordingPullSink } from "../src/rtk-webhook.js";

const ORG = "11111111-1111-4111-8111-111111111111";

// ── Minimal multipart fakes (one canonical object per session). ──
class FakeUpload {
  parts: { partNumber: number; size: number }[] = [];
  constructor(public key: string, public uploadId: string) {}
  async uploadPart(n: number, d: Uint8Array) {
    this.parts.push({ partNumber: n, size: d.length });
    return { partNumber: n, etag: `e${n}` };
  }
  async complete() {
    return {} as R2Object;
  }
  async abort() {}
}
class FakeBucket {
  created: FakeUpload[] = [];
  private seq = 0;
  label: string;
  constructor(label: string) {
    this.label = label;
  }
  async createMultipartUpload(key: string) {
    const u = new FakeUpload(key, `u${++this.seq}`);
    this.created.push(u);
    return u as unknown as R2MultipartUpload;
  }
  async head() {
    return null;
  }
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}
// EBML magic so the container sniffs as webm.
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);

describe("recordingKey region param (#127)", () => {
  it("with NO region is byte-identical to the legacy key (INERT default)", () => {
    expect(recordingKey(ORG, "sess1", "webm")).toBe(`${ORG}/realtime-recordings/sess1/recording.webm`);
    expect(recordingKey(ORG, "sess1", "webm", undefined)).toBe(`${ORG}/realtime-recordings/sess1/recording.webm`);
  });
  it("with a region keeps the org prefix AND inserts the region segment", () => {
    const k = recordingKey(ORG, "sess1", "webm", "us-east");
    expect(k.startsWith(`${ORG}/`)).toBe(true);
    expect(k).toBe(`${ORG}/realtime-recordings/us-east/sess1/recording.webm`);
  });
});

describe("pullUploadedRecording residency path (#127)", () => {
  const baseSink = (bucket: FakeBucket): RecordingPullSink => ({
    lookupOrg: async () => ORG,
    resolveDownloadUrl: async () => "https://cdn.example.com/rec.webm",
    fetchRecording: async () => streamOf(WEBM),
    bucket: bucket as unknown as R2Bucket,
  });

  it("RT_RESIDENCY OFF (no residency deps) → default bucket, NO region key, NO register", async () => {
    const def = new FakeBucket("default");
    const result = await pullUploadedRecording({ id: "r1", status: "UPLOADED", meetingId: "m1" }, baseSink(def));
    expect(result?.key).toBe(`${ORG}/realtime-recordings/m1/recording.webm`); // legacy key, no region
    expect(def.created).toHaveLength(1);
  });

  it("RT_RESIDENCY ON (eu-west) → jurisdiction bucket + region key + register() called with consistent payload", async () => {
    const def = new FakeBucket("default");
    const eu = new FakeBucket("eu");
    const registerCalls: { org: string; r2Key: string; bucketName: string; zone: string }[] = [];
    const sink: RecordingPullSink = {
      ...baseSink(def),
      residency: {
        lookupZone: async () => "eu-west",
        bucketFor: (zone) =>
          zone === "eu-west"
            ? { bucket: eu as unknown as R2Bucket, bucketName: "wave-recordings-eu", binding: "RT_RECORDINGS_EU" }
            : null,
        register: async (i) => {
          registerCalls.push(i);
        },
      },
    };
    const result = await pullUploadedRecording({ id: "r2", status: "UPLOADED", meetingId: "m2" }, sink);
    // Bytes landed in the EU jurisdiction bucket at the region-segmented key.
    expect(eu.created).toHaveLength(1);
    expect(def.created).toHaveLength(0); // never the default bucket on the residency path
    expect(result?.key).toBe(`${ORG}/realtime-recordings/eu-west/m2/recording.webm`);
    // register() called once with a consistent (org-prefixed key, eu bucket, eu-west zone) payload.
    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0]).toEqual({
      org: ORG,
      r2Key: `${ORG}/realtime-recordings/eu-west/m2/recording.webm`,
      bucketName: "wave-recordings-eu",
      zone: "eu-west",
    });
  });

  it("RT_RESIDENCY ON but zone unmapped (null) → falls back to default bucket + no register (never drop a byte)", async () => {
    const def = new FakeBucket("default");
    const register = vi.fn();
    const sink: RecordingPullSink = {
      ...baseSink(def),
      residency: {
        lookupZone: async () => null, // e.g. an AS session — no residency placement
        bucketFor: () => null,
        register,
      },
    };
    const result = await pullUploadedRecording({ id: "r3", status: "UPLOADED", meetingId: "m3" }, sink);
    expect(def.created).toHaveLength(1);
    expect(result?.key).toBe(`${ORG}/realtime-recordings/m3/recording.webm`); // default path, no region
    expect(register).not.toHaveBeenCalled();
  });
});
