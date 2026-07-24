// rtp.mjs — node:dgram UDP listener for ffmpeg's `-f rtp rtp://127.0.0.1:<port>` Opus output (#314).
//
// ffmpeg's RTP muxer emits ONE datagram per RTP packet (no UDP-level fragmentation for Opus-sized
// payloads), so each `dgram` `message` event is exactly one RTP packet. We strip the fixed 12-byte RTP
// header (no CSRC list, no header extension — ffmpeg's own RTP muxer does not emit either for a plain
// Opus stream) to recover the raw Opus payload.
import dgram from 'node:dgram';

const RTP_HEADER_LEN = 12;

/**
 * Strip the fixed 12-byte RTP header from `buf` and return the Opus payload, or `null` if `buf` is too
 * short to contain a full RTP header. Pure — no I/O — exported for unit testing.
 */
export function stripRtpHeader(buf) {
  if (!buf || buf.length < RTP_HEADER_LEN) return null;
  return buf.subarray(RTP_HEADER_LEN);
}

/**
 * Bind a UDP socket on `port` (127.0.0.1 by default) and call `onPacket(opusPayload)` for each RTP
 * datagram received, after stripping the RTP header. Short/malformed datagrams are dropped silently
 * (never throws into the caller). Returns the bound socket; call `.close()` to tear down.
 */
export function listenRtp(port, onPacket, host = '127.0.0.1') {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg) => {
    const payload = stripRtpHeader(msg);
    if (payload && payload.length > 0) onPacket(payload);
  });
  sock.bind(port, host);
  return sock;
}
