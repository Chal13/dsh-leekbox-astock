// Capability registry — the machine-readable form of the skill's endpoint map.
//
// One entry per endpoint the fork exposes. Adding an endpoint = one declaration
// here + one loader in lib/astock/<layer>.js. The agent tool layer, /capabilities
// and /metrics all read this single source, so they cannot drift apart.
import { cached } from "./route-cache.js";
import { sessionTtl } from "./calendar.js";
import * as signal from "./astock/signal.js";

export const LAYERS = {
	research: { no: 2, label: "研报", hint: "个股/行业研报、一致预期 EPS、研报列表" },
	signal: { no: 3, label: "信号", hint: "龙虎榜、解禁、板块资金流、行业排名" },
	capital: { no: 4, label: "资金面/筹码", hint: "两融、大宗、股东户数、分红、资金流、ETF 份额、筹码分布" },
	limitup: { no: 8, label: "打板", hint: "涨停/炸板/跌停/昨涨停池、情绪、监控池、异动" },
	macro: { no: 11, label: "宏观与利率", hint: "社融、PMI、收益率曲线、回购定盘、LPR、宏观日历" },
	event: { no: 14, label: "事件驱动", hint: "业绩预告、机构调研、增减持、回购、质押、新股" },
};

const TTL = {
	realtime: () => sessionTtl(30_000),
	short: () => sessionTtl(5 * 60_000),
	long: () => sessionTtl(60 * 60_000),
};

/**
 * @typedef {object} CapabilityDef
 * @property {string} id            action name (skill function name)
 * @property {string} layer         key of LAYERS
 * @property {string} label         中文名
 * @property {string} source        上游标识
 * @property {object} params        允许的参数（工具 schema 由它生成）
 * @property {() => number} ttlMs
 * @property {number} staleIfError
 * @property {(params: object) => Promise<object>} load
 */

/** @type {CapabilityDef[]} */
export const CAPABILITIES = [
	{
		id: "board_fund_flow",
		layer: "signal",
		label: "板块资金流向",
		source: "eastmoney",
		params: {
			boardType: { type: "string", enum: ["industry", "concept", "region"], default: "industry" },
			period: { type: "string", enum: ["today", "5d", "10d"], default: "today" },
			topN: { type: "number", default: 20, max: 200 },
		},
		ttlMs: TTL.realtime,
		staleIfError: 10 * 60_000,
		load: signal.boardFundFlow,
	},
	{
		id: "industry_comparison",
		layer: "signal",
		label: "行业板块涨跌排名",
		source: "eastmoney",
		params: { topN: { type: "number", default: 20, max: 100 } },
		ttlMs: TTL.realtime,
		staleIfError: 10 * 60_000,
		load: signal.industryComparison,
	},
	{
		id: "lockup_expiry",
		layer: "signal",
		label: "限售解禁日历",
		source: "eastmoney-datacenter",
		params: {
			code: { type: "string", required: true, hint: "600519 / SH600519 / 600519.SH" },
			tradeDate: { type: "string", hint: "YYYY-MM-DD，缺省今天" },
			forwardDays: { type: "number", default: 90, max: 365 },
		},
		ttlMs: TTL.long,
		staleIfError: 24 * 60 * 60_000,
		load: signal.lockupExpiry,
	},
	{
		id: "dragon_tiger_board",
		layer: "signal",
		label: "个股龙虎榜与席位",
		source: "eastmoney-datacenter",
		params: {
			code: { type: "string", required: true },
			tradeDate: { type: "string", hint: "YYYY-MM-DD，缺省今天（回溯起点）" },
			lookBack: { type: "number", default: 30, max: 365 },
		},
		ttlMs: TTL.short,
		staleIfError: 24 * 60 * 60_000,
		load: signal.dragonTigerBoard,
	},
	{
		id: "daily_dragon_tiger",
		layer: "signal",
		label: "全市场龙虎榜",
		source: "eastmoney-datacenter",
		params: {
			date: { type: "string", hint: "YYYY-MM-DD，缺省今天" },
			minNetBuy: { type: "number", hint: "净买入下限（万元）" },
		},
		ttlMs: TTL.short,
		staleIfError: 24 * 60 * 60_000,
		load: signal.dailyDragonTiger,
	},
];

const byId = new Map(CAPABILITIES.map((def) => [def.id, def]));

export function getCapability(id) {
	return byId.get(id);
}

export function capabilitiesOfLayer(layer) {
	return CAPABILITIES.filter((def) => def.layer === layer);
}

/** 给 astock_catalog 与 /capabilities 的机器可读清单。 */
export function capabilityList() {
	return CAPABILITIES.map((def) => ({
		id: def.id,
		layer: def.layer,
		layerNo: LAYERS[def.layer].no,
		layerLabel: LAYERS[def.layer].label,
		label: def.label,
		source: def.source,
		params: def.params,
	}));
}

/** Run one capability through the route cache (TTL + single-flight + stale-if-error). */
export async function runCapability(id, params = {}) {
	const def = byId.get(id);
	if (def === undefined) throw Object.assign(new Error(`未知的能力：${id}`), { code: "invalid_param", status: 400 });
	const clean = {};
	for (const [key, spec] of Object.entries(def.params)) {
		const value = params[key];
		if (value === undefined || value === null || value === "") {
			if (spec.required) throw Object.assign(new Error(`缺少参数 ${key}`), { code: "invalid_param", status: 400 });
			if (spec.default !== undefined) clean[key] = spec.default;
			continue;
		}
		if (spec.type === "number") {
			const n = Number(value);
			if (!Number.isFinite(n)) throw Object.assign(new Error(`参数 ${key} 需要数字`), { code: "invalid_param", status: 400 });
			clean[key] = spec.max !== undefined ? Math.min(n, spec.max) : n;
		} else {
			clean[key] = String(value);
		}
	}
	if (def.params.code?.required && clean.code === undefined) {
		throw Object.assign(new Error("缺少参数 code"), { code: "invalid_param", status: 400 });
	}
	return cached({
		name: `astock:${def.layer}`,
		key: `${id}:${JSON.stringify(clean)}`,
		ttlMs: def.ttlMs,
		staleIfError: def.staleIfError,
		load: () => def.load(clean),
	});
}
