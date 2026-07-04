// Twilio Media-Streams WS protocol (#60 residual / #76) — pure parse/build.
import { describe, it, expect } from "vitest";
import {
  parseTwilioFrame,
  twilioMediaFrame,
  twilioMarkFrame,
  twilioClearFrame,
  base64ToBytes,
  bytesToBase64,
  TwilioProtocolError,
} from "../src/twilio-mediastream.js";

describe("base64 <-> bytes", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 200, 13, 10]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });
});

describe("parseTwilioFrame — inbound events", () => {
  it("parses connected", () => {
    const e = parseTwilioFrame(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    expect(e).toEqual({ event: "connected", protocol: "Call", version: "1.0.0" });
  });

  it("parses start with media format + custom params", () => {
    const frame = JSON.stringify({
      event: "start",
      sequenceNumber: "1",
      streamSid: "MZ123",
      start: {
        streamSid: "MZ123",
        accountSid: "AC1",
        callSid: "CA1",
        tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { room: "inbound-1" },
      },
    });
    const e = parseTwilioFrame(frame);
    if (e.event !== "start") throw new Error("wrong event");
    expect(e.callSid).toBe("CA1");
    expect(e.streamSid).toBe("MZ123");
    expect(e.mediaFormat.sampleRate).toBe(8000);
    expect(e.customParameters.room).toBe("inbound-1");
  });

  it("parses media and decodes the base64 μ-law payload to bytes", () => {
    const muLaw = new Uint8Array([0xff, 0x7f, 0x00, 0x80]);
    const frame = JSON.stringify({
      event: "media",
      streamSid: "MZ123",
      media: { track: "inbound", chunk: "1", timestamp: "20", payload: bytesToBase64(muLaw) },
    });
    const e = parseTwilioFrame(frame);
    if (e.event !== "media") throw new Error("wrong event");
    expect(Array.from(e.payload)).toEqual(Array.from(muLaw));
    expect(e.track).toBe("inbound");
  });

  it("parses stop and dtmf and mark", () => {
    expect(parseTwilioFrame(JSON.stringify({ event: "stop", streamSid: "MZ1", stop: { callSid: "CA1" } })).event).toBe("stop");
    const dtmf = parseTwilioFrame(JSON.stringify({ event: "dtmf", streamSid: "MZ1", dtmf: { track: "inbound_track", digit: "5" } }));
    if (dtmf.event !== "dtmf") throw new Error("wrong");
    expect(dtmf.digit).toBe("5");
    const mark = parseTwilioFrame(JSON.stringify({ event: "mark", streamSid: "MZ1", mark: { name: "greeting-done" } }));
    if (mark.event !== "mark") throw new Error("wrong");
    expect(mark.name).toBe("greeting-done");
  });

  it("throws TwilioProtocolError on bad JSON, unknown event, and missing required field", () => {
    expect(() => parseTwilioFrame("not json")).toThrow(TwilioProtocolError);
    expect(() => parseTwilioFrame(JSON.stringify({ event: "wat" }))).toThrow(TwilioProtocolError);
    expect(() => parseTwilioFrame(JSON.stringify({ event: "media", streamSid: "MZ1", media: {} }))).toThrow(TwilioProtocolError);
  });
});

describe("outbound frame builders", () => {
  it("media frame carries base64 payload + streamSid, no track", () => {
    const muLaw = new Uint8Array([0xff, 0xff, 0xff]);
    const parsed = JSON.parse(twilioMediaFrame("MZ9", muLaw));
    expect(parsed.event).toBe("media");
    expect(parsed.streamSid).toBe("MZ9");
    expect(Array.from(base64ToBytes(parsed.media.payload))).toEqual([255, 255, 255]);
  });

  it("mark + clear frames are well-formed", () => {
    expect(JSON.parse(twilioMarkFrame("MZ9", "done"))).toEqual({ event: "mark", streamSid: "MZ9", mark: { name: "done" } });
    expect(JSON.parse(twilioClearFrame("MZ9"))).toEqual({ event: "clear", streamSid: "MZ9" });
  });

  it("an outbound media frame round-trips back through the parser", () => {
    const muLaw = new Uint8Array(160).fill(0xff);
    const back = parseTwilioFrame(twilioMediaFrame("MZ9", muLaw));
    if (back.event !== "media") throw new Error("wrong");
    expect(back.payload.length).toBe(160);
  });
});
