// Zoom RTMS native-WebSocket protocol (#88) — pure parse/build.
import { describe, it, expect } from "vitest";
import {
  RTMS_MSG_TYPE,
  RTMS_MEDIA_TYPE,
  parseRtmsWebhook,
  signalingHandshakeReq,
  dataHandshakeReq,
  keepAliveResp,
  parseRtmsMessage,
  RtmsProtocolError,
} from "../src/rtms-protocol.js";
import { bytesToBase64 } from "../src/twilio-mediastream.js";

describe("parseRtmsWebhook", () => {
  it("classifies endpoint.url_validation and extracts plainToken", () => {
    const e = parseRtmsWebhook({ event: "endpoint.url_validation", payload: { plainToken: "pt-1" } });
    expect(e).toEqual({ kind: "url_validation", plainToken: "pt-1" });
  });

  it("classifies meeting.rtms_started with fields under payload.object", () => {
    const e = parseRtmsWebhook({
      event: "meeting.rtms_started",
      payload: { object: { meeting_uuid: "M==", rtms_stream_id: "S1", server_urls: "wss://rtms.zoom.us" } },
    });
    if (e.kind !== "rtms_started") throw new Error("wrong kind");
    expect(e.meetingUuid).toBe("M==");
    expect(e.rtmsStreamId).toBe("S1");
    expect(e.serverUrls).toBe("wss://rtms.zoom.us");
  });

  it("classifies meeting.rtms_stopped with stop_reason and unknown events as 'other'", () => {
    const stop = parseRtmsWebhook({ event: "meeting.rtms_stopped", payload: { object: { meeting_uuid: "M", rtms_stream_id: "S", stop_reason: 6 } } });
    if (stop.kind !== "rtms_stopped") throw new Error("wrong");
    expect(stop.stopReason).toBe(6);
    expect(parseRtmsWebhook({ event: "meeting.started" })).toEqual({ kind: "other", event: "meeting.started" });
  });

  it("throws when url_validation is missing plainToken", () => {
    expect(() => parseRtmsWebhook({ event: "endpoint.url_validation", payload: {} })).toThrow(RtmsProtocolError);
  });
});

describe("outbound message builders", () => {
  it("signalingHandshakeReq is msg_type 1 with the signature + ids", () => {
    const m = JSON.parse(signalingHandshakeReq("uuid1", "s1", "sighex"));
    expect(m.msg_type).toBe(RTMS_MSG_TYPE.SIGNALING_HAND_SHAKE_REQ);
    expect(m.msg_type).toBe(1);
    expect(m).toMatchObject({ meeting_uuid: "uuid1", rtms_stream_id: "s1", signature: "sighex", protocol_version: 1 });
  });

  it("dataHandshakeReq is msg_type 3 and defaults to the AUDIO media bitmask", () => {
    const m = JSON.parse(dataHandshakeReq("uuid1", "s1", "sighex"));
    expect(m.msg_type).toBe(3);
    expect(m.media_type).toBe(RTMS_MEDIA_TYPE.AUDIO);
    expect(m.media_type).toBe(1);
    const both = JSON.parse(dataHandshakeReq("u", "s", "x", RTMS_MEDIA_TYPE.AUDIO | RTMS_MEDIA_TYPE.TRANSCRIPT));
    expect(both.media_type).toBe(9);
  });

  it("keepAliveResp is msg_type 13 echoing the timestamp", () => {
    expect(JSON.parse(keepAliveResp(1720000000))).toEqual({ msg_type: 13, timestamp: 1720000000 });
  });
});

describe("parseRtmsMessage — inbound frames", () => {
  it("parses SIGNALING_HAND_SHAKE_RESP(2) and extracts media server URLs", () => {
    const frame = JSON.stringify({
      msg_type: 2, status_code: 0,
      media_server: { server_urls: { audio: "wss://a", transcript: "wss://t", all: "wss://all" } },
    });
    const m = parseRtmsMessage(frame);
    if (m.kind !== "signaling_ack") throw new Error("wrong");
    expect(m.statusCode).toBe(0);
    expect(m.mediaServerUrls.audio).toBe("wss://a");
    expect(m.mediaServerUrls.all).toBe("wss://all");
  });

  it("parses DATA_HAND_SHAKE_RESP(4) and KEEP_ALIVE_REQ(12)", () => {
    expect(parseRtmsMessage(JSON.stringify({ msg_type: 4, status_code: 0 })).kind).toBe("data_ack");
    const ka = parseRtmsMessage(JSON.stringify({ msg_type: 12, timestamp: 42 }));
    if (ka.kind !== "keepalive_req") throw new Error("wrong");
    expect(ka.timestamp).toBe(42);
  });

  it("parses MEDIA_DATA_AUDIO(14) and base64-decodes the PCM payload", () => {
    const pcm = new Uint8Array([0, 1, 255, 128, 10, 20]);
    const frame = JSON.stringify({ msg_type: 14, content: { user_id: 16778240, data: bytesToBase64(pcm) } });
    const m = parseRtmsMessage(frame);
    if (m.kind !== "audio") throw new Error("wrong");
    expect(Array.from(m.payload)).toEqual(Array.from(pcm));
    expect(m.userId).toBe(16778240);
  });

  it("parses MEDIA_DATA_TRANSCRIPT(17), returns 'other' for unknown, throws on bad JSON / missing audio data", () => {
    const tr = parseRtmsMessage(JSON.stringify({ msg_type: 17, content: { user_name: "Jake", data: "hello" } }));
    if (tr.kind !== "transcript") throw new Error("wrong");
    expect(tr.text).toBe("hello");
    expect(parseRtmsMessage(JSON.stringify({ msg_type: 7 })).kind).toBe("other");
    expect(() => parseRtmsMessage("not json")).toThrow(RtmsProtocolError);
    expect(() => parseRtmsMessage(JSON.stringify({ msg_type: 14, content: {} }))).toThrow(RtmsProtocolError);
  });
});
