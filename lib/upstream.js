// Global per-upstream rate limiter with two priority classes.
//
// Why this exists: the upstream plugin fanned requests out to several Eastmoney
// hosts and retried on failure, but had **no minimum interval, no serial queue
// and no jitter**. The skill this fork integrates carries a first-hand record of
// an IP-level ban (45k requests/hour → push2 blocked for 20+ hours).
//
// Why priority: the search-index warmup fires ~50 clist pages at startup. With a
// single FIFO queue at 1s spacing, the first interactive rank request waits
// behind that whole batch (observed as a permanently "loading" rank table).
// High-priority tasks (user interactions) jump ahead of queued low-priority
// tasks (background warmup) while still sharing the same pacing clock.
//
// Tests run with LEEKBOX_TEST=1: pass through entirely, so stubbed suites never
// couple to each other's timing.

const FAMILIES = [
	{ key: "eastmoney", match: /(^|\.)eastmoney\.com$/i, minMs: 1000, jitterMs: 250 },
	{ key: "gtimg", match: /(^|\.)(gtimg\.cn|qq\.com)$/i, minMs: 350, jitterMs: 50 },
	{ key: "sina", match: /(^|\.)(sina\.com\.cn|sinajs\.cn)$/i, minMs: 300, jitterMs: 50 },
	{ key: "exchange", match: /(^|\.)(sse\.com\.cn|szse\.cn|bse\.cn|chinabond\.com\.cn|chinamoney\.com\.cn|pbc\.gov\.cn|stats\.gov\.cn)$/i, minMs: 500, jitterMs: 80 },
	{ key: "default", match: /.*/, minMs: 50, jitterMs: 10 },
];

const isTest = () => process.env.LEEKBOX_TEST === "1";

function familyFor(hostname) {
	for (const family of FAMILIES) {
		if (family.match.test(hostname)) return family;
	}
	return FAMILIES[FAMILIES.length - 1];
}

/**
 * @type {Map<string, {high: Array<{task: Function, resolve: Function, reject: Function}>, low: Array<{task: Function, resolve: Function, reject: Function}>, running: boolean, nextAt: number, calls: number, waits: number, lastAt: number}>}
 */
const queues = new Map();

function stateFor(key) {
	let state = queues.get(key);
	if (state === undefined) {
		state = { high: [], low: [], running: false, nextAt: 0, calls: 0, waits: 0, lastAt: 0 };
		queues.set(key, state);
	}
	return state;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pump(family, state) {
	if (state.running) return;
	const entry = state.high.shift() ?? state.low.shift();
	if (entry === undefined) return;
	state.running = true;
	(async () => {
		try {
			const wait = Math.max(0, state.nextAt - Date.now());
			if (wait > 0) {
				state.waits += 1;
				await sleep(wait);
			}
			state.nextAt = Date.now() + family.minMs + Math.floor(Math.random() * family.jitterMs);
			state.calls += 1;
			state.lastAt = Date.now();
			entry.resolve(await entry.task());
		} catch (error) {
			entry.reject(error);
		} finally {
			state.running = false;
			pump(family, state);
		}
	})();
}

/**
 * Run `task` through the queue for the URL's upstream family.
 * @param {string} input
 * @param {() => Promise<any>} task
 * @param {{priority?: "high" | "low"}} [opts]
 */
export function limitUrl(input, task, opts = {}) {
	if (isTest()) return task();
	let hostname;
	try {
		hostname = new URL(String(input)).hostname;
	} catch {
		return task();
	}
	const family = familyFor(hostname);
	const state = stateFor(family.key);
	return new Promise((resolve, reject) => {
		const entry = { task, resolve, reject };
		if (opts.priority === "low") state.low.push(entry);
		else state.high.push(entry);
		pump(family, state);
	});
}

/** Observability for /metrics: per-family call counts and queue depth. */
export function limiterStats() {
	const out = {};
	for (const [key, state] of queues) {
		out[key] = {
			calls: state.calls,
			waits: state.waits,
			highQueued: state.high.length,
			lowQueued: state.low.length,
			lastAt: state.lastAt === 0 ? null : new Date(state.lastAt).toISOString(),
			nextInMs: Math.max(0, state.nextAt - Date.now()),
		};
	}
	return out;
}

/** Test helper: drop all pacing state. */
export function resetLimiterForTests() {
	queues.clear();
}

/** Exposed for tests: the interval this URL's family would use outside tests. */
export function policyForUrl(input) {
	try {
		const family = familyFor(new URL(String(input)).hostname);
		return { key: family.key, minMs: family.minMs, jitterMs: family.jitterMs };
	} catch {
		return { key: "default", minMs: 50, jitterMs: 10 };
	}
}
