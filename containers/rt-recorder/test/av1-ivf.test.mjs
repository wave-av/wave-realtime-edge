// #153 Stage 2 — Av1IvfWriter: wrap werift-depacketized AV1 OBU frames into an IVF ffmpeg can demux. Pure
// structural tests (no ffmpeg/werift). The live ffmpeg round-trip (OUR IVF → av1 decode-clean → WebM) is proven
// in the recorder harness with a real AV1 source; here we lock the container byte layout + finalize semantics.
import { describe, it, expect } from "vitest";
import { Av1IvfWriter, ivfFileHeader, ivfFrameHeader } from "../server/av1-ivf.mjs";

describe("ivfFileHeader — 32-byte DKIF/AV01 header", () => {
	it("writes the signature, FourCC, geometry, timebase, and patched frame count", () => {
		const h = ivfFileHeader({ width: 1280, height: 720, timebaseDen: 90000, numFrames: 42 });
		expect(h.length).toBe(32);
		expect(h.toString("ascii", 0, 4)).toBe("DKIF");
		expect(h.readUInt16LE(6)).toBe(32); // header length
		expect(h.toString("ascii", 8, 12)).toBe("AV01"); // AV1 FourCC
		expect(h.readUInt16LE(12)).toBe(1280);
		expect(h.readUInt16LE(14)).toBe(720);
		expect(h.readUInt32LE(16)).toBe(90000); // timebase den
		expect(h.readUInt32LE(24)).toBe(42); // frame count
	});
	it("rejects a missing geometry (no silent 0x0 IVF)", () => {
		expect(() => ivfFileHeader({ width: 0, height: 720 })).toThrow(/width\/height/);
	});
});

describe("ivfFrameHeader — 12-byte size + PTS", () => {
	it("encodes frame size (u32le) and timestamp (u64le)", () => {
		const h = ivfFrameHeader(1234, 90000);
		expect(h.length).toBe(12);
		expect(h.readUInt32LE(0)).toBe(1234);
		expect(Number(h.readBigUInt64LE(4))).toBe(90000);
	});
});

describe("Av1IvfWriter — assemble OBU frames into a parseable IVF", () => {
	it("returns null when nothing was written (never a 0-frame IVF)", () => {
		expect(new Av1IvfWriter({ width: 320, height: 240 }).finalize()).toBeNull();
	});

	it("ignores empty frames", () => {
		const w = new Av1IvfWriter({ width: 320, height: 240 });
		w.write(Buffer.alloc(0), 0);
		w.write(undefined, 0);
		expect(w.frameCount).toBe(0);
		expect(w.finalize()).toBeNull();
	});

	it("finalizes a header+frames buffer that round-trips back to the same frames", () => {
		const f0 = Buffer.from([1, 2, 3, 4]);
		const f1 = Buffer.from([9, 8, 7]);
		const w = new Av1IvfWriter({ width: 640, height: 480, timebaseDen: 90000 });
		w.write(f0, 0);
		w.write(f1, 3000);
		expect(w.frameCount).toBe(2);
		const ivf = w.finalize();

		// header frame-count patched in
		expect(ivf.readUInt32LE(24)).toBe(2);
		expect(ivf.toString("ascii", 8, 12)).toBe("AV01");

		// re-parse the two frames (12-byte header each) back out
		let off = 32;
		const s0 = ivf.readUInt32LE(off);
		expect(s0).toBe(4);
		expect(Number(ivf.readBigUInt64LE(off + 4))).toBe(0);
		expect(ivf.subarray(off + 12, off + 12 + s0)).toEqual(f0);
		off += 12 + s0;
		const s1 = ivf.readUInt32LE(off);
		expect(s1).toBe(3);
		expect(Number(ivf.readBigUInt64LE(off + 4))).toBe(3000);
		expect(ivf.subarray(off + 12, off + 12 + s1)).toEqual(f1);
	});
});
