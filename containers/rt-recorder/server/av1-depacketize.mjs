// av1-depacketize.mjs — #154: reassemble AV1 RTP packets into temporal-unit (OBU) frames, PURE + injectable.
//
// This is the accumulator half of the AV1 bridge (av1-ivf.mjs is the container half). werift's MediaRecorder
// HANGS on AV1, but its low-level RTP depacketizer (`AV1RtpPayload.deSerialize` per packet, `.getFrame(payloads)`
// to reassemble a temporal unit, `.isDetectedFinalPacketInSequence(header)` = marker bit for the TU boundary)
// does NOT hang. This module drives that depacketizer: feed it each arriving RTP packet's payload + marker bit,
// and it emits one AV1 temporal-unit Buffer per completed TU — exactly what `Av1IvfWriter.write()` consumes.
//
// PURE + INJECTABLE: the werift functions (`deSerialize`, `getFrame`) are injected, so the assembly LOGIC —
// buffer-until-marker, reset, malformed-packet safety — is unit-testable without loading werift (node-only).
// `sfu-track-recorder.mjs` injects the real `AV1RtpPayload.deSerialize` / `.getFrame` at the werift seam.

/**
 * Assemble AV1 RTP packets into temporal-unit OBU frames.
 *
 * @param {object} o
 * @param {(payload:Buffer)=>object} o.deSerialize  AV1RtpPayload.deSerialize (one RTP payload → parsed payload)
 * @param {(payloads:object[])=>Buffer} o.getFrame   AV1RtpPayload.getFrame (payloads of one TU → OBU-frame Buffer)
 */
export class Av1FrameAssembler {
  constructor({ deSerialize, getFrame }) {
    if (typeof deSerialize !== "function" || typeof getFrame !== "function") {
      throw new Error("av1-depacketize: deSerialize and getFrame are required");
    }
    this.deSerialize = deSerialize;
    this.getFrame = getFrame;
    this.pending = []; // parsed AV1RtpPayloads accumulated for the in-progress temporal unit
    this.dropped = 0; // malformed packets safely skipped (never wedge the recorder)
    this.frames = 0; // completed temporal units emitted
    this.keyframes = 0; // TUs whose first packet started a new coded video sequence (N bit)
  }

  /**
   * Feed one arriving RTP packet. Returns a completed AV1 temporal-unit Buffer when `marker` closes a TU,
   * otherwise null. A malformed packet is dropped (counted) — it never throws and never wedges the stream.
   *
   * @param {Buffer} payload  the RTP packet payload (rtp.payload)
   * @param {boolean} marker  the RTP header marker bit (rtp.header.marker) — true ends the temporal unit
   * @returns {Buffer|null}
   */
  push(payload, marker) {
    let parsed;
    try {
      parsed = this.deSerialize(payload);
    } catch {
      this.dropped++;
      return null; // malformed RTP payload — skip, do not abort the TU in flight
    }
    if (parsed?.isKeyframe && this.pending.length === 0) this.keyframes++;
    this.pending.push(parsed);
    if (!marker) return null;

    const payloads = this.pending;
    this.pending = [];
    if (payloads.length === 0) return null;
    let frame;
    try {
      frame = this.getFrame(payloads);
    } catch {
      this.dropped++;
      return null; // reassembly failed (e.g. a lost fragment) — drop this TU, keep recording
    }
    if (!frame || frame.length === 0) return null;
    this.frames++;
    return frame;
  }

  /** True while a temporal unit is mid-assembly (packets seen but no marker yet). */
  get hasPending() {
    return this.pending.length > 0;
  }
}
