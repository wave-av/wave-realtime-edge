// MLVC reserved-seam guard (ffmpeg9-lei E17-P2, receipt R71). The registry carries an `mlvc` codec
// entry whose encoder list is EMPTY until the E18 runtime shim lands — selection must therefore treat
// it as never-available, and the seam must stay inert. This test pins that contract: if someone adds
// encoders before E18 ships, this fails and names the gate.
import { describe, it, expect } from "vitest";
import { VIDEO_CODECS, getCodecEntry, isVideoCodec } from "../server/codecs.mjs";

describe("mlvc reserved seam (E17-P2)", () => {
  it("is registered as a video codec", () => {
    expect(isVideoCodec("mlvc")).toBe(true);
    expect(getCodecEntry("mlvc").media).toBe("video");
  });

  it("is INERT: zero encoders until the E18 runtime shim ships", () => {
    const entry = VIDEO_CODECS.mlvc;
    expect(entry.encoders).toHaveLength(0);
  });

  it("is never selected by the walker (empty encoders = nothing available)", () => {
    const entry = getCodecEntry("mlvc");
    const available = new Set(["libx264", "libvpx-vp9", "libsvtav1"]);
    const picked = entry.encoders.find((e) => available.has(e.encoder));
    expect(picked).toBeUndefined();
  });
});
