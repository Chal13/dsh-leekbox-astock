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

// 选股扫描专用节奏：腾讯/新浪的 K 线可以快一些（不封 IP，容忍批量），
// 东财**故意不加速**（IP 级封禁风险，见文件头）。选股请求走独立队列，
// 不会把交互请求（报价/详情）堵在扫描后面。
const SCREENER_PACING = {
	// concurrency：同时最多几个请求在飞；minMs 仍是"发起间隔"。
	// 新浪实测单请求 40~200ms，3 路并发既能提速，又远低于其容忍阈值。
	gtimg: { minMs: 60, jitterMs: 20, concurrency: 3 },
	sina: { minMs: 30, jitterMs: 10, concurrency: 6 },
};

function familyFor(hostname, profile) {
	for (const family of FAMILIES) {
		if (family.match.test(hostname)) {
			if (profile === "screener") {
				const pacing = SCREENER_PACING[family.key];
				if (pacing !== undefined) return { ...family, ...pacing };
			}
			return family;
		}
	}
	return FAMILIES[FAMILIES.length - 1];
}

/**
 * @type {Map<string, {high: Array<{task: Function, resolve: Function, reject: Function}>, low: Array<{task: Function, resolve: Function, reject: Function}>, active: number, nextAt: number, calls: number, waits: number, lastAt: number}>}
 */
const queues = new Map();

function stateFor(key) {
	let state = queues.get(key);
	if (state === undefined) {
		state = { high: [], low: [], active: 0, nextAt: 0, calls: 0, waits: 0, lastAt: 0 };
		queues.set(key, state);
	}
	return state;
}

/** 调度器：按「发起间隔」排队，同时允许 `family.concurrency` 个请求在飞。
 * 默认 concurrency=1 时与旧行为完全一致（严格串行）。 */
function pump(family, state) {
	const max = Math.max(1, Number(family.concurrency) || 1);
	while (state.active < max) {
		const entry = state.high.shift() ?? state.low.shift();
		if (entry === undefined) return;
		const wait = Math.max(0, state.nextAt - Date.now());
		state.nextAt = Date.now() + wait + family.minMs + Math.floor(Math.random() * family.jitterMs);
		if (wait > 0) state.waits += 1;
		state.active += 1;
		setTimeout(async () => {
			state.calls += 1;
			state.lastAt = Date.now();
			try {
				entry.resolve(await entry.task());
			} catch (error) {
				entry.reject(error);
			} finally {
				state.active -= 1;
				pump(family, state);
			}
		}, wait);
		// 继续填满其余并发槽位；它们会在 nextAt 到点后依次真正发出（wait 由上面的调度保证）。
	}
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
	const family = familyFor(hostname, opts.profile);
	// 不同 profile 用独立队列：扫描的批量请求不会占住交互请求的节拍。
	const queueKey = opts.profile === undefined ? family.key : `${family.key}:${opts.profile}`;
	const state = stateFor(queueKey);
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
			active: state.active,
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
