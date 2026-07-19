// #235 — graceful drain on rollout. Extracted as a WERIFT-FREE leaf (mirroring hls-source.mjs / relay.mjs)
// so it unit-tests with no werift install: index.mjs owns the werift import and cannot itself be imported
// by the test suite.
//
// WHY THIS EXISTS. A container image rollout used to hard-kill in-flight bridges — five
// `Runtime signalled the container to exit due to a new version rollout: 137` events landed while a bridge
// was mid-session on 2026-07-19. Exit 137 is SIGKILL, and every `wrangler deploy` of this Worker triggers a
// rollout, so shipping a Worker change dropped live customer broadcasts.
//
// The platform was never the problem: CF sends SIGTERM first and allows 15 minutes before forcing the kill
// (`rollout_active_grace_period` in wrangler.toml controls how long an ACTIVE instance is left alone before
// becoming eligible at all). We simply had no handler, so the process died where it stood.
//
// What draining buys, stated honestly: the instance IS going away and we cannot keep a broadcast alive
// across its replacement. What we CAN do is make the ending clean —
//
//   * `relay.stop()` sends the WHIP DELETE, so the session books its REAL duration through the normal
//     teardown meter. A SIGKILL skipped that, leaving the session to the whip-sweep orphan cron, which
//     booked a single ceil'd minute for an entire broadcast (#233's other half). Draining converts silent
//     revenue loss into a correct bill.
//   * The exit becomes loud and attributable instead of an anonymous 137.

/** Teardown is two HTTP DELETEs; 10s is generous. CF's hard cap after SIGTERM is 15 minutes, so this is
 *  comfortably inside it — we exit on our OWN deadline rather than being killed on the platform's. */
export const DRAIN_DEADLINE_MS = 10_000;

/**
 * Build the drain handler.
 *
 * @param {object} o
 * @param {() => object|null} o.getActive - reads the live relay handle (null when idle).
 * @param {(v: null) => void} o.setActive - clears it, so a racing request cannot see a torn-down relay.
 * @param {() => void} o.closeServer - stop accepting new connections.
 * @param {(msg: string, fields?: object) => void} o.log
 * @param {(code: number) => void} o.exit - process exit (injected for tests).
 * @param {number} [o.deadlineMs]
 * @param {(ms: number) => Promise<never>} [o.timer] - injectable timeout (tests avoid real waits).
 * @returns {(signal: string) => Promise<void>} idempotent — a second signal mid-drain is ignored.
 */
export function makeDrain(o) {
	const { getActive, setActive, closeServer, log, exit } = o;
	const deadlineMs = o.deadlineMs ?? DRAIN_DEADLINE_MS;
	let draining = false;

	return async function drain(signal) {
		// A repeated SIGTERM must not start a SECOND teardown mid-flight: relay.stop() is idempotent, but a
		// concurrent drain could exit the process while the first teardown's DELETE is still in flight —
		// losing exactly the billing this handler exists to preserve.
		if (draining) return;
		draining = true;

		const relay = getActive();
		log("bridge-draining", { signal, hadRelay: Boolean(relay) });

		// Stop accepting new work FIRST, so a /start racing the rollout cannot leave behind an orphaned relay
		// that nothing will ever tear down.
		try { closeServer(); } catch { /* already closing */ }
		setActive(null);

		if (relay) {
			try {
				const timeout = o.timer
					? o.timer(deadlineMs)
					: new Promise((_, rej) => setTimeout(() => rej(new Error("drain timeout")), deadlineMs));
				await Promise.race([relay.stop(), timeout]);
				log("bridge-drained", { signal, clean: true });
			} catch (e) {
				// Say so OUT LOUD. A teardown we could not complete means this session's duration falls to the
				// orphan sweeper — precisely the kind of thing that must never be inferred from silence.
				log("bridge-drain-failed", { signal, message: String(e?.message || e).slice(0, 200) });
			}
		}

		exit(0);
	};
}
