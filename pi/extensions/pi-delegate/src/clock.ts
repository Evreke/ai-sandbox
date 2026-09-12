/**
 * pi-delegate — clock: the injectable clock/delay port (audit step 7) —
 * extracted verbatim from spawn.ts (Wave 3, step 4).
 * <p>
 * MODULE_CONTRACT (port): the pipeline's ONLY access to wall-clock time and
 * sleeping. Injecting it makes time-dependent pipeline sections (the grace
 * recheck loop first) testable on virtual clocks — no real waiting in
 * tests, deterministic sequences.
 * delay() MUST resolve early when the signal fires (the
 * abort-detaches-never-kills discipline — the wait is cancellable, never
 * the worker); now() is a monotonic-enough millisecond read.
 * Dependencies: tool-result.ts (the abort-aware sleep the system clock's
 * delay delegates to). A leaf module otherwise.
 */

import { sleep } from "./tool-result.ts";

/**
 * Clock/delay port (audit step 7): the pipeline's ONLY access to wall-clock
 * time and sleeping. Injecting it makes time-dependent pipeline sections
 * (the grace recheck loop first) testable on virtual clocks — no real
 * waiting in tests, deterministic sequences.
 * <p>
 * MODULE_CONTRACT (port): delay() MUST resolve early when the signal fires
 * (the abort-detaches-never-kills discipline — the wait is cancellable,
 * never the worker); now() is a monotonic-enough millisecond read.
 */
export interface ClockPort {
	now(): number;
	delay(ms: number, signal?: AbortSignal): Promise<void>;
}

/** The production clock: real timers. */
export const systemClock: ClockPort = {
	now: () => Date.now(),
	delay: (ms, signal) => sleep(ms, signal),
};

export interface VirtualClock extends ClockPort {
	/** Resolve every pending delay whose due time falls within the next `ms`
	 *  of virtual time, advancing now() past them. Awaits until the resolvers
	 *  have run (microtask flush). */
	advance(ms: number): Promise<void>;
}

/**
 * Virtual clock for tests: delays never use real time — they resolve when
 * advance() moves virtual time past their due point.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: startNow — the initial virtual time (ms)
 * Output: a VirtualClock (ClockPort + advance)
 * Guarantees:
 *   - delay() never resolves before an advance() covers its due time
 *   - delay() honors the abort signal (the port contract): an aborted wait
 *     resolves early — the abort-detaches-never-kills discipline holds on
 *     virtual time too
 *   - advance() resolves ALL due waiters in scheduling order and flushes a
 *     microtask tick so chained delays observe the new time
 * Raises: never
 */
export function createVirtualClock(startNow = 0): VirtualClock {
	let now = startNow;
	const waiters: Array<{ due: number; resolve: () => void }> = [];
	return {
		now: () => now,
		delay(ms, signal) {
			return new Promise<void>((res) => {
				const waiter = { due: now + ms, resolve: res };
				waiters.push(waiter);
				if (signal) {
					if (signal.aborted) {
						const i = waiters.indexOf(waiter);
						if (i >= 0) waiters.splice(i, 1);
						res();
						return;
					}
					signal.addEventListener(
						"abort",
						() => {
							const i = waiters.indexOf(waiter);
							if (i >= 0) waiters.splice(i, 1);
							res();
						},
						{ once: true },
					);
				}
			});
		},
		async advance(ms) {
			now += ms;
			const due = waiters.filter((w) => w.due <= now);
			for (const w of waiters) {
				if (w.due > now) continue;
				w.resolve();
			}
			for (let i = waiters.length - 1; i >= 0; i--) {
				if (due.includes(waiters[i])) waiters.splice(i, 1);
			}
			await new Promise<void>((r) => setTimeout(r, 0));
		},
	};
}

