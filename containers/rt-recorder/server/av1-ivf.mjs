// av1-ivf.mjs — #153 Stage 2: assemble AV1 OBU temporal-unit frames into an IVF container ffmpeg can demux.
//
// WHY THIS EXISTS: werift's MediaRecorder HANGS on AV1, and ffmpeg's RTP layer has NO AV1 payload handler — so
// neither muxer in our stack can turn an AV1 WebRTC track into a file directly. But werift DOES ship a low-level
// AV1 RTP depacketizer (`AV1RtpPayload.deSerialize` / `getFrame`) that reassembles OBU frames without hanging.
// This module is the missing bridge: it wraps those reassembled OBU frames into IVF — the simplest container
// ffmpeg reads for AV1 (FourCC "AV01") — which `native-transcode.mjs` then rewraps/transcodes into the canonical
// WebM. Flow: werift subscribe → AV1RtpPayload.getFrame() per temporal unit → Av1IvfWriter → .ivf → ffmpeg → WebM.
//
// IVF layout: a 32-byte file header (DKIF magic, FourCC, WxH, timebase, frame count) then, per frame, a 12-byte
// header (frame size u32le + presentation timestamp u64le) followed by the raw AV1 temporal-unit bytes.

/** Build the 32-byte IVF file header. `numFrames` is patched in on finalize when the total is known. */
export function ivfFileHeader({ width, height, fourcc = "AV01", timebaseDen = 90000, timebaseNum = 1, numFrames = 0 }) {
	if (!(width > 0) || !(height > 0)) throw new Error(`av1-ivf: width/height required (got ${width}x${height})`);
	const b = Buffer.alloc(32);
	b.write("DKIF", 0, "ascii"); // signature
	b.writeUInt16LE(0, 4); // version
	b.writeUInt16LE(32, 6); // header length
	b.write(fourcc, 8, "ascii"); // codec FourCC — "AV01" for AV1
	b.writeUInt16LE(width, 12);
	b.writeUInt16LE(height, 14);
	b.writeUInt32LE(timebaseDen, 16); // e.g. 90000 (RTP clock) or fps
	b.writeUInt32LE(timebaseNum, 20); // e.g. 1
	b.writeUInt32LE(numFrames, 24);
	b.writeUInt32LE(0, 28); // unused
	return b;
}

/** Build a 12-byte IVF frame header (size + presentation timestamp) for a frame of `len` bytes. */
export function ivfFrameHeader(len, timestamp) {
	const h = Buffer.alloc(12);
	h.writeUInt32LE(len, 0);
	h.writeBigUInt64LE(BigInt(timestamp), 4);
	return h;
}

/**
 * Streaming IVF writer for AV1 OBU frames. `write(frame, timestamp)` appends a temporal unit; `finalize()`
 * returns the complete IVF buffer with the real frame count patched into the header. Timestamps are in the
 * header's timebase units (default 90000 → pass RTP timestamp deltas for accurate PTS; or frame index with a
 * per-fps timebase). Zero frames → finalize returns null (never a 0-frame IVF — config-no-silent-noop upstream).
 */
export class Av1IvfWriter {
	constructor({ width, height, timebaseDen = 90000, timebaseNum = 1 }) {
		this.opts = { width, height, timebaseDen, timebaseNum };
		this.frames = []; // { header:Buffer, data:Buffer }
	}

	/** Append one AV1 temporal-unit (OBU frame) at `timestamp` (timebase units). Ignores empty frames. */
	write(frame, timestamp) {
		if (!frame || frame.length === 0) return;
		this.frames.push({ header: ivfFrameHeader(frame.length, timestamp), data: frame });
	}

	get frameCount() {
		return this.frames.length;
	}

	/** Assemble the complete IVF buffer (header frame-count patched in). Null when nothing was written. */
	finalize() {
		if (this.frames.length === 0) return null;
		const head = ivfFileHeader({ ...this.opts, numFrames: this.frames.length });
		const parts = [head];
		for (const f of this.frames) {
			parts.push(f.header, f.data);
		}
		return Buffer.concat(parts);
	}
}
