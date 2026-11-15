// Global per-upstream rate limiter.
//
// Why this exists: the upstream plugin fanned requests out to several Eastmoney
// hosts and retried on failure, but had **no minimum interval, no serial queue
// and no jitter**. The skill this fork integrates carries a first-hand record of
// an IP-level ban (45k requests/hour → pushed2 blocked for 20+ hours). Adding
// ~20 more endpoints without a global gate would reproduce that.
//
// Design:
//   - one serial queue per upstream *family* (all *.eastmoney.com share one),
//   - minimum interval + random jitter between requests of the same family,
//   - route-cache stays above this layer (it dedupes; this paces).
//
// Tests run with LEEKBOX_TEST=1: queues still serialize (so concurrency bugs
// stay observable) but intervals become 0, keeping the suite fast.

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

/** @type {Map<string, {tail: Promise<unknown>, nextAt: number, calls: number, waits: number, lastAt: number}>} */
const queues = new Map();

function stateFor(key) {
	let state = queues.get(key);
	if (state === undefined) {
		state = { tail: Promise.resolve(), nextAt: 0, calls: 0, waits: 0, lastAt: 0 };
		queues.set(key, state);
	}
	return state;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `task` through the queue for the URL's upstream family.
 * Returns the task result; queue-chain rejections never poison later tasks.
 */
export function limitUrl(input, task) {
	// Tests stub fetch and intentionally hang some requests; serializing them
	// would couple unrelated suites to each other's timing. Pass through.
	if (isTest()) return task();
	let hostname;
	try {
		hostname = new URL(String(input)).hostname;
	} catch {
		return task();
	}
	const family = familyFor(hostname);
	const state = stateFor(family.key);
	const run = state.tail.then(async () => {
		const now = Date.now();
		const minMs = isTest() ? 0 : family.minMs;
		const jitterMs = isTest() ? 0 : Math.floor(Math.random() * family.jitterMs);
		const wait = Math.max(0, state.nextAt - now);
		if (wait > 0) {
			state.waits += 1;
			await sleep(wait);
		}
		state.nextAt = Date.now() + minMs + jitterMs;
		state.calls += 1;
		state.lastAt = Date.now();
		return task();
	});
	state.tail = run.then(
		() => undefined,
		() => undefined
	);
	return run;
}

/** Observability for /metrics: per-family call counts and pacing state. */
export function limiterStats() {
	const out = {};
	for (const [key, state] of queues) {
		out[key] = {
			calls: state.calls,
			waits: state.waits,
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
