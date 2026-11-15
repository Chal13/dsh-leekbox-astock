// Run every regression suite in its own process and report each result.
//
// Why not `a && b && c` (the upstream shape): the first failure aborts the
// chain, so every suite after it is silently skipped. Upstream has a
// date-brittle suite (p1-f10-longhu-test.mjs pins its fixture to a past
// trading day), which makes the tail of the chain depend on today's date.
// This runner executes all suites, records durations, and treats a known
// upstream failure as a non-fatal "known" result.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

const SUITES = [
	"verify-fixes.mjs",
	"pinyin-test.mjs",
	"news-dedup-test.mjs",
	"sentiment-score-test.mjs",
	"error-text-test.mjs",
	"client-bundle-test.mjs",
	"analysis-tab-test.mjs",
	"analysis-data-test.mjs",
	"p0-universe-delta-test.mjs",
	"p0-position-alerts-test.mjs",
	"p0-minute-fflow-test.mjs",
	"indicators-equiv-test.mjs",
	"p1-screener-cache-test.mjs",
	"p1-f10-longhu-test.mjs",
	"kline-ttl-coldstart-test.mjs",
	"screener-meta-test.mjs",
	"p1-p2-stream-test.mjs",
	"p2-sse-route-test.mjs",
	"calendar-test.mjs",
	"route-cache-test.mjs",
	"p2-silent-fixes-test.mjs",
];

/** Upstream suites that fail for reasons outside this fork's control. */
const KNOWN_UPSTREAM_FAILURES = new Map([
	[
		"p1-f10-longhu-test.mjs",
		"fixture pinned to 2026-10-09; the route backtracks from today and finds no data in the window",
	],
]);

let failed = 0;
let known = 0;
const results = [];

for (const suite of SUITES) {
	const started = Date.now();
	const run = spawnSync(process.execPath, [join(root, suite)], {
		cwd: root,
		stdio: "inherit",
		env: { ...process.env, LEEKBOX_TEST: "1" },
	});
	const ms = Date.now() - started;
	const ok = run.status === 0;
	const isKnown = !ok && KNOWN_UPSTREAM_FAILURES.has(suite);
	if (!ok && !isKnown) failed += 1;
	if (!ok && isKnown) known += 1;
	results.push({ suite, ok, known: isKnown, ms, code: run.status });
	console.log(`\n[${ok ? "PASS" : isKnown ? "KNOWN" : "FAIL"}] ${suite} (${ms}ms)`);
}

console.log("\n===== test summary =====");
for (const r of results) {
	console.log(
		`${r.ok ? "PASS " : r.known ? "KNOWN" : "FAIL "} ${String(r.ms).padStart(6)}ms  ${r.suite}`
	);
}
if (known > 0) {
	for (const [suite, reason] of KNOWN_UPSTREAM_FAILURES) {
		if (results.some((r) => r.suite === suite && r.known)) {
			console.log(`\nknown upstream failure: ${suite} — ${reason}`);
		}
	}
}
console.log(`\nsuites=${results.length} failed=${failed} known=${known}`);
process.exit(failed === 0 ? 0 : 1);
