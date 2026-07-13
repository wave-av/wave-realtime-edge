// rt-recorder (#151) — PURE file→sink streaming (no werift import, so it is unit-testable with a fake fs).
//
// Streams a finalized container FILE to a RecordingSink in ordered chunks. The sink (src/encoders/
// recording-sink.ts contract) lazy-begins on the first non-empty part, so the leading bytes carry the
// container magic → the canonical object gets the right extension. Split out from record-to-sink.mjs so the
// pure test does not transitively load the Node-only werift module.

const DEFAULT_CHUNK = 1 << 20; // 1 MiB — R2 multipart-friendly part sizing on the sink side.

/** Stream a file to the sink in ordered chunks. Each `write` gets a STABLE slice (the read buffer is reused). */
export async function streamFileToSink(fs, path, sink, chunkBytes = DEFAULT_CHUNK) {
  const fd = fs.openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(chunkBytes);
    let read;
    while ((read = fs.readSync(fd, buf, 0, chunkBytes, null)) > 0) {
      // Copy the exact slice — Buffer is reused across reads, so the sink must receive its own bytes.
      await sink.write(Uint8Array.prototype.slice.call(buf, 0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
}

export { DEFAULT_CHUNK };
