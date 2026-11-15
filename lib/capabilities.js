// Capability registry — the machine-readable form of the skill's endpoint map.
//
// One entry per endpoint the fork exposes. Adding an endpoint = one declaration
// here + one loader in lib/astock/<layer>.js. The agent tool layer, /capabilities
// and /metrics all read this single source, so they cannot drift apart.
import { cached } from "./route-cache.js";
import { sessionTtl } from "./calendar.js";
import * as signal from "./astock/signal.js";
import * as capital from "./astock/capital.js";
import * as limitup from "./astock/limitup.js";
import * as event from "./astock/event.js";
import * as research from "./astock/research.js";
import * as macro from "./astock/macro.js";

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
	{
		id: "margin_trading",
		layer: "capital",
		label: "融资融券明细",
		source: "eastmoney-datacenter",
		params: {
			code: { type: "string", required: true },
			pageSize: { type: "number", default: 30, max: 120 },
		},
		ttlMs: TTL.long,
		staleIfError: 24 * 60 * 60_000,
		load: capital.marginTrading,
	},
	{
		id: "block_trade",
		layer: "capital",
		label: "大宗交易",
		source: "eastmoney-datacenter",
		params: {
			code: { type: "string", required: true },
			pageSize: { type: "number", default: 20, max: 100 },
		},
		ttlMs: TTL.long,
		staleIfError: 24 * 60 * 60_000,
		load: capital.blockTrade,
	},
	{
		id: "holder_num_change",
		layer: "capital",
		label: "股东户数变化",
		source: "eastmoney-datacenter",
		params: {
			code: { type: "string", required: true },
			pageSize: { type: "number", default: 10, max: 40 },
		},
		ttlMs: TTL.long,
		staleIfError: 7 * 24 * 60 * 60_000,
		load: capital.holderNumChange,
	},
	{
		id: "dividend_history",
		layer: "capital",
		label: "分红送转历史",
		source: "eastmoney-datacenter",
		params: {
			code: { type: "string", required: true },
			pageSize: { type: "number", default: 20, max: 60 },
		},
		ttlMs: TTL.long,
		staleIfError: 24 * 60 * 60_000,
		load: capital.dividendHistory,
	},
	{
		id: "stock_fund_flow_120d",
		layer: "capital",
		label: "个股资金流（120日）",
		source: "eastmoney-push2his",
		params: { code: { type: "string", required: true } },
		ttlMs: TTL.short,
		staleIfError: 30 * 60_000,
		load: capital.stockFundFlow120d,
	},
	{
		id: "chip_distribution",
		layer: "capital",
		label: "筹码分布（CYQ）",
		source: "local-compute",
		params: {
			code: { type: "string", required: true },
			days: { type: "number", default: 250, max: 500 },
			decay: { type: "number", default: 1.0, max: 3 },
		},
		ttlMs: TTL.short,
		staleIfError: 30 * 60_000,
		load: capital.chipDistribution,
	},
	{
		id: "etf_shares",
		layer: "capital",
		label: "ETF 份额",
		source: "sse/szse",
		params: {
			date: { type: "string", hint: "YYYY-MM-DD，深市只能取最新一天" },
			exchange: { type: "string", enum: ["SH", "SZ"], default: "SH" },
		},
		ttlMs: TTL.long,
		staleIfError: 24 * 60 * 60_000,
		load: capital.etfShares,
	},
	{
		id: "em_zt_pool",
		layer: "limitup",
		label: "涨停池",
		source: "eastmoney-push2ex",
		params: { date: { type: "string", hint: "YYYY-MM-DD 或 YYYYMMDD，缺省今天" } },
		ttlMs: TTL.short,
		staleIfError: 10 * 60_000,
		load: limitup.emZtPool,
	},
	{
		id: "em_zb_pool",
		layer: "limitup",
		label: "炸板池",
		source: "eastmoney-push2ex",
		params: { date: { type: "string", hint: "YYYY-MM-DD 或 YYYYMMDD" } },
		ttlMs: TTL.short,
		staleIfError: 10 * 60_000,
		load: limitup.emZbPool,
	},
	{
		id: "em_dt_pool",
		layer: "limitup",
		label: "跌停池",
		source: "eastmoney-push2ex",
		params: { date: { type: "string", hint: "YYYY-MM-DD 或 YYYYMMDD" } },
		ttlMs: TTL.short,
		staleIfError: 10 * 60_000,
		load: limitup.emDtPool,
	},
	{
		id: "em_yzt_pool",
		layer: "limitup",
		label: "昨涨停池",
		source: "eastmoney-push2ex",
		params: { date: { type: "string", hint: "YYYY-MM-DD 或 YYYYMMDD" } },
		ttlMs: TTL.short,
		staleIfError: 10 * 60_000,
		load: limitup.emYztPool,
	},
	{
		id: "ths_limit_up_pool",
		layer: "limitup",
		label: "涨停原因与封板质量",
		source: "10jqka",
		params: { date: { type: "string", hint: "YYYY-MM-DD 或 YYYYMMDD" } },
		ttlMs: TTL.short,
		staleIfError: 10 * 60_000,
		load: limitup.thsLimitUpPool,
	},
	{
		id: "limit_up_sentiment",
		layer: "limitup",
		label: "打板情绪（炸板率/连板梯队）",
		source: "eastmoney-push2ex",
		params: { date: { type: "string", hint: "YYYY-MM-DD 或 YYYYMMDD" } },
		ttlMs: TTL.short,
		staleIfError: 10 * 60_000,
		load: limitup.limitUpSentiment,
	},
	{
		id: "em_stock_monitor",
		layer: "limitup",
		label: "重点监控池",
		source: "eastmoney-app-config",
		params: { onlyActive: { type: "string", enum: ["true", "false"], default: "true" } },
		ttlMs: TTL.long,
		staleIfError: 24 * 60 * 60_000,
		load: (params) => limitup.emStockMonitor({ onlyActive: params.onlyActive !== "false" }),
	},
	{
		id: "em_price_anomaly",
		layer: "limitup",
		label: "日内异动明细",
		source: "eastmoney-price-anomaly",
		params: {
			pageSize: { type: "number", default: 200, max: 500 },
			pageNo: { type: "number", default: 1, max: 20 },
		},
		ttlMs: TTL.short,
		staleIfError: 10 * 60_000,
		load: limitup.emPriceAnomaly,
	},
	{
		id: "em_price_anomaly_count",
		layer: "limitup",
		label: "异动统计（按标的聚合）",
		source: "eastmoney-price-anomaly",
		params: {
			pageSize: { type: "number", default: 50, max: 200 },
			pageNo: { type: "number", default: 1, max: 20 },
		},
		ttlMs: TTL.short,
		staleIfError: 10 * 60_000,
		load: limitup.emPriceAnomalyCount,
	},
	{
		id: "earnings_forecast",
		layer: "event",
		label: "业绩预告",
		source: "eastmoney-datacenter",
		params: {
			code: { type: "string", hint: "可选；不给则查全市场最新" },
			reportDate: { type: "string", hint: "报告期 YYYY-MM-DD" },
			limit: { type: "number", default: 200, max: 500 },
		},
		ttlMs: TTL.long,
		staleIfError: 24 * 60 * 60_000,
		load: event.earningsForecast,
	},
	{
		id: "institution_survey",
		layer: "event",
		label: "机构调研",
		source: "eastmoney-datacenter",
		params: {
			code: { type: "string" },
			start: { type: "string", hint: "公告日起 YYYY-MM-DD" },
			end: { type: "string", hint: "公告日止 YYYY-MM-DD" },
			detail: { type: "string", enum: ["true", "false"], default: "false" },
			limit: { type: "number", default: 200, max: 500 },
		},
		ttlMs: TTL.long,
		staleIfError: 24 * 60 * 60_000,
		load: event.institutionSurvey,
	},
	{
		id: "holder_trades",
		layer: "event",
		label: "股东增减持",
		source: "eastmoney-datacenter",
		params: {
			code: { type: "string" },
			direction: { type: "string", enum: ["增持", "减持"], hint: "可选" },
			start: { type: "string" },
			end: { type: "string" },
			limit: { type: "number", default: 200, max: 500 },
		},
		ttlMs: TTL.long,
		staleIfError: 24 * 60 * 60_000,
		load: event.holderTrades,
	},
	{
		id: "share_buyback",
		layer: "event",
		label: "股票回购",
		source: "eastmoney-datacenter",
		params: {
			code: { type: "string" },
			progress: { type: "string", hint: "董事会预案 / 股东大会通过 / 实施中 / 停止实施 / 完成实施" },
			limit: { type: "number", default: 200, max: 500 },
		},
		ttlMs: TTL.long,
		staleIfError: 24 * 60 * 60_000,
		load: event.shareBuyback,
	},
	{
		id: "equity_pledge",
		layer: "event",
		label: "股权质押（周度）",
		source: "eastmoney-datacenter",
		params: {
			code: { type: "string", hint: "与 date 二选一" },
			date: { type: "string", hint: "统计日 YYYY-MM-DD，通常为周五" },
			limit: { type: "number", default: 500, max: 5000 },
		},
		ttlMs: TTL.long,
		staleIfError: 7 * 24 * 60 * 60_000,
		load: event.equityPledge,
	},
	{
		id: "ipo_calendar",
		layer: "event",
		label: "新股申购日历",
		source: "eastmoney-datacenter",
		params: { limit: { type: "number", default: 100, max: 500 } },
		ttlMs: TTL.long,
		staleIfError: 24 * 60 * 60_000,
		load: event.ipoCalendar,
	},
	{
		id: "eastmoney_reports",
		layer: "research",
		label: "个股研报",
		source: "eastmoney-reportapi",
		params: {
			code: { type: "string", required: true },
			maxPages: { type: "number", default: 1, max: 5 },
		},
		ttlMs: TTL.long,
		staleIfError: 24 * 60 * 60_000,
		load: research.eastmoneyReports,
	},
	{
		id: "eastmoney_industry_reports",
		layer: "research",
		label: "行业研报",
		source: "eastmoney-reportapi",
		params: {
			industryCode: { type: "string", default: "*", hint: "东财行业码；* = 全行业" },
			maxPages: { type: "number", default: 1, max: 5 },
			begin: { type: "string", hint: "起始日期，缺省近两年" },
		},
		ttlMs: TTL.long,
		staleIfError: 24 * 60 * 60_000,
		load: research.eastmoneyIndustryReports,
	},
	{
		id: "ths_eps_forecast",
		layer: "research",
		label: "一致预期 EPS",
		source: "10jqka-basic",
		params: { code: { type: "string", required: true } },
		ttlMs: TTL.long,
		staleIfError: 24 * 60 * 60_000,
		load: research.thsEpsForecast,
	},
	{
		id: "sina_research_reports",
		layer: "research",
		label: "新浪研报列表",
		source: "sina",
		params: {
			code: { type: "string", hint: "可选；不给则全市场最新" },
			page: { type: "number", default: 1, max: 20 },
		},
		ttlMs: TTL.long,
		staleIfError: 24 * 60 * 60_000,
		load: research.sinaResearchReports,
	},
	{
		id: "pboc_social_financing",
		layer: "macro",
		label: "社会融资规模增量",
		source: "pbc",
		params: {
			year: { type: "number", hint: "年份；不给取最新年（仅 2021 起）" },
		},
		ttlMs: TTL.long,
		staleIfError: 7 * 24 * 60 * 60_000,
		load: macro.pbocSocialFinancing,
	},
	{
		id: "nbs_pmi",
		layer: "macro",
		label: "PMI",
		source: "stats.gov.cn",
		params: {},
		ttlMs: TTL.long,
		staleIfError: 7 * 24 * 60 * 60_000,
		load: macro.nbsPmi,
	},
	{
		id: "chinabond_yield_curve",
		layer: "macro",
		label: "中债收益率曲线",
		source: "chinabond",
		params: {
			start: { type: "string", required: true, hint: "YYYY-MM-DD" },
			end: { type: "string", hint: "YYYY-MM-DD，缺省今天" },
			curve: { type: "string", enum: ["all", "treasury", "bank_aaa", "mtn_aaa"], default: "all" },
		},
		ttlMs: TTL.long,
		staleIfError: 7 * 24 * 60 * 60_000,
		load: macro.chinabondYieldCurve,
	},
	{
		id: "repo_fixing_rates",
		layer: "macro",
		label: "回购定盘利率 FR/FDR",
		source: "chinamoney",
		params: { kind: { type: "string", enum: ["FR", "FDR"], default: "FR" } },
		ttlMs: TTL.long,
		staleIfError: 7 * 24 * 60 * 60_000,
		load: macro.repoFixingRates,
	},
	{
		id: "lpr_history",
		layer: "macro",
		label: "LPR 全历史",
		source: "eastmoney-datacenter",
		params: {},
		ttlMs: TTL.long,
		staleIfError: 7 * 24 * 60 * 60_000,
		load: macro.lprHistory,
	},
	{
		id: "macro_calendar",
		layer: "macro",
		label: "全球宏观日历",
		source: "wallstreetcn",
		params: {
			start: { type: "string", required: true, hint: "YYYY-MM-DD" },
			end: { type: "string", hint: "YYYY-MM-DD，缺省 start+6 天" },
			country: { type: "string", hint: "例：中国 / 美国" },
			minImportance: { type: "number", default: 1, max: 4 },
		},
		ttlMs: TTL.short,
		staleIfError: 60 * 60_000,
		load: macro.macroCalendar,
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
