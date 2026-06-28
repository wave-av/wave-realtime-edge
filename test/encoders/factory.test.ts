// RT-P1.5 — factory selection + the disarmed (inert) default. No live runtime; pure env-driven dispatch.
import { describe, it, expect } from "vitest";
import { selectEncoder, DisarmedEncoder } from "../../src/encoders/factory.js";
import { ManagedEncoder } from "../../src/encoders/managed.js";
import { ContainerEncoder } from "../../src/encoders/container.js";
import { WasmEncoder } from "../../src/encoders/wasm.js";
import type { EncoderEnv } from "../../src/encoders/encoder.js";

const SESSION = { org: "11111111-1111-1111-1111-111111111111", room: "r1", sessionId: "sess-1" };

describe("selectEncoder — disarmed by default", () => {
  it("returns the inert DisarmedEncoder when RT_RECORD is unset", () => {
    expect(selectEncoder({})).toBeInstanceOf(DisarmedEncoder);
  });
  it("returns the inert DisarmedEncoder when RT_RECORD !== '1' (e.g. '0')", () => {
    expect(selectEncoder({ RT_RECORD: "0", RT_ENCODER: "managed" })).toBeInstanceOf(DisarmedEncoder);
  });
  it("DisarmedEncoder.begin is a no-op → null (records nothing)", async () => {
    const enc = selectEncoder({ RT_RECORD: "0" });
    expect(await enc.begin(SESSION)).toBeNull();
  });
});

describe("selectEncoder — armed adapter selection (RT_RECORD='1')", () => {
  const armed = (RT_ENCODER?: EncoderEnv["RT_ENCODER"]): EncoderEnv => ({ RT_RECORD: "1", RT_ENCODER });
  it("defaults to ManagedEncoder (C) when RT_ENCODER is unset", () => {
    expect(selectEncoder(armed())).toBeInstanceOf(ManagedEncoder);
  });
  it("'managed' → ManagedEncoder (C)", () => {
    expect(selectEncoder(armed("managed"))).toBeInstanceOf(ManagedEncoder);
  });
  it("'container' → ContainerEncoder (A — scaffold)", () => {
    expect(selectEncoder(armed("container"))).toBeInstanceOf(ContainerEncoder);
  });
  it("'wasm' → WasmEncoder (B — scaffold)", () => {
    expect(selectEncoder(armed("wasm"))).toBeInstanceOf(WasmEncoder);
  });
});

describe("ContainerEncoder (A) is now a real audio-first impl — begin NEVER throws (fail-open, inert)", () => {
  it("armed but UNCONFIGURED (no bucket/app) → null, never throws (loud-warn)", async () => {
    const enc = selectEncoder({ RT_RECORD: "1", RT_ENCODER: "container" });
    await expect(enc.begin(SESSION)).resolves.toBeNull();
  });
  it("armed + fully configured → a non-null ContainerHandle (no throw)", async () => {
    const bucket = {} as unknown as R2Bucket;
    const enc = selectEncoder({
      RT_RECORD: "1",
      RT_ENCODER: "container",
      RT_RECORDINGS: bucket,
      CF_CALLS_APP_ID: "a".repeat(32),
      CF_CALLS_APP_SECRET: "sfu-secret",
    });
    const handle = await enc.begin(SESSION);
    expect(handle).not.toBeNull();
  });
});

describe("WasmEncoder (B) is STILL a BLOCKED-ON-RT-P0.1-spike scaffold (fail loud)", () => {
  it("WasmEncoder.begin throws NOT_SPIKED", async () => {
    const enc = selectEncoder({ RT_RECORD: "1", RT_ENCODER: "wasm" });
    await expect(enc.begin(SESSION)).rejects.toThrow(/BLOCKED-ON-RT-P0.1-spike/);
  });
});
