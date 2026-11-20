// No-network regression suite for the astock layer.
//
// Locks the contracts that are easy to break silently:
//   - ticker normalization (including contradictory prefix/suffix)
//   - push2 → capability row mapping + unit block
//   - datacenter "empty result" is not_published, not a 502
//   - agent tool output truncation and unknown-action errors
import assert from "node:assert/strict";
import { normTicker } from "./lib/astock/util.js";
import { capabilityList, runCapability } from "./lib/capabilities.js";
import { astockTools } from "./lib/astock-tools.js";

const realFetch = globalThis.fetch;
let lastUrl = "";

function stubFetch(handler) {
	globalThis.fetch = async (url) => {
		lastUrl = String(url);
		const body = handler(String(url));
		if (body === null) return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
		return { ok: true, arrayBuffer: async () => Buffer.from(JSON.stringify(body), "utf8") };
	};
}

try {
	console.log("== 1) normTicker: all accepted forms ==");
	assert.deepEqual(normTicker("600519"), { code: "600519", market: "SH", secid: "1.600519", tencent: "sh600519" });
	assert.equal(normTicker("SH600519").secid, "1.600519");
	assert.equal(normTicker("600519.SH").secid, "1.600519");
	assert.equal(normTicker("600519.XSHG").secid, "1.600519");
	assert.equal(normTicker("000001").secid, "0.000001");
	assert.equal(normTicker("920982").market, "BJ");
	assert.equal(normTicker("430047").market, "BJ");
	assert.throws(() => normTicker("000016.SH"), /矛盾/);
	assert.throws(() => normTicker("zzz"), /无法识别/);
	console.log("PASS  ticker normalization");

	console.log("== 2) board_fund_flow: push2 rows → capability rows ==");
	stubFetch((url) => {
		assert.ok(url.includes("clist/get"), "must call clist");
		return {
			data: {
				total: 496,
				diff: [
					{ f12: "BK0475", f14: "银行", f3: 1.23, f62: 123456789, f184: 4.5, f204: "招商银行", f66: 1, f72: 2, f78: 3, f84: 4 },
					{ f12: "BK0477", f14: "证券", f3: -0.5, f62: -5000, f184: -0.2, f204: "东方财富", f66: 0, f72: 0, f78: 0, f84: 0 },
				],
			},
		};
	});
	const flow = await runCapability("board_fund_flow", { boardType: "industry", period: "today", topN: 2 });
	assert.equal(flow.rows.length, 2);
	assert.equal(flow.rows[0].name, "银行");
	assert.equal(flow.rows[0].main_net, 123456789);
	assert.equal(flow.rows[0].super_large_net, 1);
	assert.equal(flow.unit.main_net, "元");
	assert.equal(flow.total, 496);
	console.log("PASS  board fund flow mapping + units");

	console.log("== 3) datacenter empty result is not an error ==");
	stubFetch(() => ({ success: false, message: "返回数据为空", code: 9201 }));
	const empty = await runCapability("daily_dragon_tiger", { date: "2026-01-01" });
	assert.equal(empty.rows.length, 0);
	assert.match(empty.note, /无数据/);
	console.log("PASS  empty datacenter response stays a normal empty result");

	console.log("== 4) datacenter rows map to the daily dragon-tiger shape ==");
	stubFetch(() => ({
		success: true,
		result: {
			data: [
				{
					TRADE_DATE: "2026-11-13 00:00:00",
					SECURITY_CODE: "600715",
					SECURITY_NAME_ABBR: "文投控股",
					EXPLANATION: "涨幅偏离值达到7%",
					CLOSE_PRICE: 3.4,
					CHANGE_RATE: 10.03,
					BILLBOARD_NET_AMT: 467778000,
					BILLBOARD_BUY_AMT: 563659000,
					BILLBOARD_SELL_AMT: 95881000,
					TURNOVERRATE: 10.9,
				},
			],
		},
	}));
	const daily = await runCapability("daily_dragon_tiger", { date: "2026-11-13" });
	assert.equal(daily.rows.length, 1);
	assert.equal(daily.rows[0].net_buy_wan, 46777.8);
	assert.equal(daily.rows[0].code, "600715");
	assert.equal(daily.date, "2026-11-13");
	console.log("PASS  dragon-tiger field mapping");

	console.log("== 5) agent tools: formatting, truncation, unknown action ==");
	const signalTool = astockTools().find((tool) => tool.name === "astock_signal");
	assert.ok(signalTool, "astock_signal must exist");
	const text = await signalTool.execute({ action: "daily_dragon_tiger", date: "2026-11-13", limit: 1 });
	assert.match(text, /# daily_dragon_tiger/);
	assert.match(text, /共 1 行/);
	assert.match(text, /net_buy_wan=万元/);
	const bad = await signalTool.execute({ action: "nope" });
	assert.match(bad, /未知的 action/);
	const catalog = await astockTools().find((tool) => tool.name === "astock_catalog").execute();
	assert.match(catalog, /§3 信号/);
	assert.match(catalog, /§4 资金面\/筹码/);
	assert.match(catalog, /board_fund_flow/);
	assert.ok(capabilityList().length >= 20, "registry should carry the first-phase endpoints");
	console.log("PASS  tool formatting + catalog");

	console.log("\nALL ASTOCK TESTS PASSED");
} finally {
	globalThis.fetch = realFetch;
}
