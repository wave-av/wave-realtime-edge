// RT-R10 (#72) — RecorderTarget dispatch seam tests. Proves: default 'none' → drop (null); 'selfhost' →
// fetch the configured URL with the right headers/body; 'cf' → getContainer + fetch '/encode'; fail-open on
// any error (binding absent, non-2xx, network throw) → null (the muxer drops that one video frame). No live net.
import { describe, it, expect } from "vitest";
import {
  selectRecorderTarget,
  CfContainerTarget,
  SelfHostTarget,
  NoneTarget,
  type FrameMeta,
} from "../../src/encoders/recorder-target.js";

const meta: FrameMeta = { kind: "video", ts: 33, codec: "jpeg" };
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const vp8 = Uint8Array.from([0x9d, 0x01, 0x2a, 4, 5]);

function okResponse(bytes: Uint8Array): Response {
  return new Response(bytes as unknown as BodyInit, { status: 200 });
}

describe("selectRecorderTarget — default + selection", () => {
  it("defaults to NoneTarget when RECORDER_TARGET is unset (drop video; prod untouched)", async () => {
    const t = selectRecorderTarget({});
    expect(t.kind).toBe("none");
    expect(await t.encode(jpeg, meta)).toBeNull();
  });

  it("RECORDER_TARGET='none' → NoneTarget → null", async () => {
    const t = selectRecorderTarget({ RECORDER_TARGET: "none" });
    expect(await t.encode(jpeg, meta)).toBeNull();
  });

  it("RECORDER_TARGET='cf' but RECORDER binding ABSENT → fail-open NoneTarget (commented [[containers]])", async () => {
    const t = selectRecorderTarget({ RECORDER_TARGET: "cf" }); // no RECORDER binding
    expect(t.kind).toBe("none");
    expect(await t.encode(jpeg, meta)).toBeNull();
  });

  it("RECORDER_TARGET='selfhost' but no URL → fail-open NoneTarget", async () => {
    const t = selectRecorderTarget({ RECORDER_TARGET: "selfhost" });
    expect(t.kind).toBe("none");
  });
});

describe("SelfHostTarget — fetch the configured URL", () => {
  it("POSTs to `${url}/encode` with x-codec/x-kind/x-ts headers + raw body, returns the encoded bytes", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return okResponse(vp8);
    };
    const t = selectRecorderTarget(
      { RECORDER_TARGET: "selfhost", RECORDER_SELFHOST_URL: "https://studio:8080/" },
      { fetchImpl },
    );
    expect(t).toBeInstanceOf(SelfHostTarget);
    const out = await t.encode(jpeg, meta);
    expect(out).toEqual(vp8);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://studio:8080/encode"); // trailing slash stripped
    const h = calls[0].init!.headers as Record<string, string>;
    expect(h["x-codec"]).toBe("jpeg");
    expect(h["x-kind"]).toBe("video");
    expect(h["x-ts"]).toBe("33");
  });

  it("fail-open on non-2xx → null", async () => {
    const t = new SelfHostTarget("https://studio:8080", async () => new Response("nope", { status: 502 }));
    expect(await t.encode(jpeg, meta)).toBeNull();
  });

  it("fail-open on a network throw → null (never throws the media path)", async () => {
    const t = new SelfHostTarget("https://studio:8080", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await t.encode(jpeg, meta)).toBeNull();
  });

  it("fail-open on an empty 200 body → null", async () => {
    const t = new SelfHostTarget("https://studio:8080", async () => okResponse(new Uint8Array(0)));
    expect(await t.encode(jpeg, meta)).toBeNull();
  });
});

describe("CfContainerTarget — getContainer + fetch '/encode'", () => {
  it("calls getContainer(binding,id).fetch and returns the encoded bytes", async () => {
    let gotId = "";
    const fakeContainer = {
      fetch: async (_req: Request) => okResponse(vp8),
    };
    const binding = { idFromName: () => ({}) } as never;
    const getContainer = (_ns: unknown, id: string) => {
      gotId = id;
      return fakeContainer as never;
    };
    const t = selectRecorderTarget(
      { RECORDER_TARGET: "cf", RECORDER: binding },
      { getContainer: getContainer as never },
    );
    expect(t).toBeInstanceOf(CfContainerTarget);
    const out = await t.encode(jpeg, meta);
    expect(out).toEqual(vp8);
    expect(gotId).toBe("rt-encoder");
  });

  it("fail-open when the container fetch throws → null", async () => {
    const binding = { idFromName: () => ({}) } as never;
    const getContainer = () =>
      ({
        fetch: async () => {
          throw new Error("container down");
        },
      }) as never;
    const t = selectRecorderTarget(
      { RECORDER_TARGET: "cf", RECORDER: binding },
      { getContainer: getContainer as never },
    );
    expect(await t.encode(jpeg, meta)).toBeNull();
  });
});

describe("NoneTarget", () => {
  it("always returns null", async () => {
    expect(await new NoneTarget().encode(jpeg, meta)).toBeNull();
  });
});
