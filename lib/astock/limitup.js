// Layer 8 — 打板层 (skill §8.1–§8.5).
import { fetchJson } from "../fetch-utils.js";
import { invalidParam, notPublished, ok, upstreamDown } from "../contract.js";
import { cnDateStr } from "../calendar.js";
import { oneLine } from "./util.js";

const ZTB_UT = "7eea3edcaed734bea9cbfc24409ed989";
const POOL_URL = "https://push2ex.eastmoney.com";

const compactDate = (value) => {
	if (!value) return cnDateStr().replace(/-/g, "");
	const text = String(value).trim();
	if (/^\d{8}$/.test(text)) return text;
	if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text.replace(/-/g, "");
	throw invalidParam("date 需为 YYYY-MM-DD 或 YYYYMMDD");
};

const dashDate = (day) => `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;

const fmtTime = (value) => {
	const text = String(value ?? "").padStart(6, "0");
	return `${text.slice(0, 2)}:${text.slice(2, 4)}:${text.slice(4, 6)}`;
};

async function ztPool(endpoint, sort, date) {
	const params = new URLSearchParams({
		ut: ZTB_UT,
		dpt: "wz.ztzt",
		Pageindex: "0",
		pagesize: "10000",
		sort,
		date,
	});
	const payload = await fetchJson(`${POOL_URL}/${endpoint}?${params}`, {
		timeoutMs: 15000,
		headers: { referer: "https://quote.eastmoney.com/" },
	});
	if (payload === null) throw upstreamDown("涨停板行情接口暂时不可用，请稍后重试", endpoint);
	const pool = payload?.data?.pool;
	// data 为 null：非交易日或参数错。交给调用方按「无数据」处理。
	return Array.isArray(pool) ? pool : null;
}

function ztStat(item) {
	const days = item?.zttj?.days ?? "?";
	const count = item?.zttj?.ct ?? "?";
	return `${days}天${count}板`;
}

async function poolCapability({ endpoint, sort, date, capability, label, mapRow, unit }) {
	const day = compactDate(date);
	const pool = await ztPool(endpoint, sort, day);
	if (pool === null) {
		return ok({
			capability,
			layer: "limitup",
			source: "eastmoney-push2ex",
			sourceUrl: `${POOL_URL}/${endpoint}`,
			unit,
			rows: [],
			extra: { date: dashDate(day), note: "无数据（非交易日或盘后未更新）" },
		});
	}
	return ok({
		capability,
		layer: "limitup",
		source: "eastmoney-push2ex",
		sourceUrl: `${POOL_URL}/${endpoint}`,
		unit,
		rows: pool.map(mapRow),
		extra: { date: dashDate(day), total: pool.length },
	});
}

export async function emZtPool({ date } = {}) {
	return poolCapability({
		endpoint: "getTopicZTPool",
		sort: "fbt:asc",
		date,
		capability: "em_zt_pool",
		label: "涨停池",
		unit: { price: "元", pct: "%", amount: "元", float_cap: "元", seal_fund: "元" },
		mapRow: (p) => ({
			code: p.c,
			name: p.n,
			price: p.p / 1000,
			pct: Math.round(p.zdp * 100) / 100,
			amount: p.amount,
			float_cap: p.ltsz,
			turnover: Math.round(p.hs * 100) / 100,
			limit_days: p.lbc,
			first_seal: fmtTime(p.fbt),
			last_seal: fmtTime(p.lbt),
			seal_fund: p.fund,
			break_times: p.zbc,
			industry: p.hybk ?? "",
			zt_stat: ztStat(p),
		}),
	});
}

export async function emZbPool({ date } = {}) {
	return poolCapability({
		endpoint: "getTopicZBPool",
		sort: "fbt:asc",
		date,
		capability: "em_zb_pool",
		label: "炸板池",
		unit: { price: "元", limit_price: "元", pct: "%", amplitude: "%", speed: "%" },
		mapRow: (p) => ({
			code: p.c,
			name: p.n,
			price: p.p / 1000,
			limit_price: p.ztp / 1000,
			pct: Math.round(p.zdp * 100) / 100,
			turnover: Math.round(p.hs * 100) / 100,
			first_seal: fmtTime(p.fbt),
			break_times: p.zbc,
			amplitude: Math.round(p.zf * 100) / 100,
			speed: Math.round(p.zs * 100) / 100,
			industry: p.hybk ?? "",
			zt_stat: ztStat(p),
		}),
	});
}

export async function emDtPool({ date } = {}) {
	return poolCapability({
		endpoint: "getTopicDTPool",
		sort: "fund:asc",
		date,
		capability: "em_dt_pool",
		label: "跌停池",
		unit: { price: "元", pct: "%", seal_fund: "元", board_amount: "元" },
		mapRow: (p) => ({
			code: p.c,
			name: p.n,
			price: p.p / 1000,
			pct: Math.round(p.zdp * 100) / 100,
			turnover: Math.round(p.hs * 100) / 100,
			pe: p.pe,
			seal_fund: p.fund,
			last_seal: fmtTime(p.lbt),
			board_amount: p.fba,
			dt_days: p.days,
			open_times: p.oc,
			industry: p.hybk ?? "",
		}),
	});
}

export async function emYztPool({ date } = {}) {
	return poolCapability({
		endpoint: "getYesterdayZTPool",
		sort: "zs:desc",
		date,
		capability: "em_yzt_pool",
		label: "昨涨停池",
		unit: { price: "元", pct: "%", amplitude: "%", speed: "%" },
		mapRow: (p) => ({
			code: p.c,
			name: p.n,
			price: p.p / 1000,
			pct: Math.round(p.zdp * 100) / 100,
			turnover: Math.round(p.hs * 100) / 100,
			amplitude: Math.round(p.zf * 100) / 100,
			speed: Math.round(p.zs * 100) / 100,
			y_first_seal: fmtTime(p.yfbt),
			y_limit_days: p.ylbc,
			industry: p.hybk ?? "",
			zt_stat: ztStat(p),
		}),
	});
}

/** 同花顺涨停揭秘（§8.2）：涨停原因题材 + 封板成功率 + 板型。 */
export async function thsLimitUpPool({ date } = {}) {
	const day = compactDate(date);
	const params = new URLSearchParams({
		page: "1",
		limit: "200",
		field: "199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004",
		filter: "HS,GEM2STAR",
		order_field: "330324",
		order_type: "0",
		date: day,
	});
	const payload = await fetchJson(`https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool?${params}`, {
		timeoutMs: 15000,
	});
	if (payload === null) throw upstreamDown("同花顺涨停揭秘暂时不可用，请稍后重试");
	const info = payload?.data?.info;
	if (!Array.isArray(info)) throw upstreamDown("同花顺涨停揭秘返回结构变化", "missing data.info");
	const rows = info.map((it) => {
		const ft = it.first_limit_up_time;
		return {
			code: it.code,
			name: it.name,
			price: it.latest,
			pct: it.change_rate,
			reason: oneLine(it.reason_type, 80),
			board_type: it.limit_up_type ?? "",
			seal_rate: it.limit_up_suc_rate,
			break_times: it.open_num ?? 0,
			seal_amount: it.order_amount,
			high_days: it.high_days ?? "",
			first_time: ft ? new Date(Number(ft) * 1000).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "",
			is_again: it.is_again_limit,
		};
	});
	return ok({
		capability: "ths_limit_up_pool",
		layer: "limitup",
		source: "10jqka",
		sourceUrl: "https://data.10jqka.com.cn",
		unit: { price: "元", pct: "%", seal_amount: "元" },
		rows,
		extra: { date: dashDate(day), total: rows.length },
	});
}

/** 打板情绪速算（§8.3）：炸板率 / 最高连板 / 连板梯队。 */
export async function limitUpSentiment({ date } = {}) {
	const day = compactDate(date);
	const [zt, zb, dt] = await Promise.all([
		ztPool("getTopicZTPool", "fbt:asc", day),
		ztPool("getTopicZBPool", "fbt:asc", day),
		ztPool("getTopicDTPool", "fund:asc", day),
	]);
	if (zt === null || zb === null || dt === null) {
		return ok({
			capability: "limit_up_sentiment",
			layer: "limitup",
			source: "eastmoney-push2ex",
			sourceUrl: POOL_URL,
			unit: { break_rate: "%" },
			rows: [],
			extra: { date: dashDate(day), note: "无数据（非交易日或盘后未更新）" },
		});
	}
	const ladder = {};
	for (const s of zt) ladder[s.lbc] = (ladder[s.lbc] ?? 0) + 1;
	const ztN = zt.length;
	const zbN = zb.length;
	const summary = {
		date: dashDate(day),
		zt_count: ztN,
		zb_count: zbN,
		dt_count: dt.length,
		break_rate: ztN + zbN ? Math.round((zbN / (ztN + zbN)) * 1000) / 10 : 0,
		max_height: zt.reduce((m, s) => Math.max(m, s.lbc ?? 0), 0),
	};
	const ladderRows = Object.entries(ladder)
		.map(([height, count]) => ({ height: Number(height), count }))
		.sort((a, b) => a.height - b.height);
	return ok({
		capability: "limit_up_sentiment",
		layer: "limitup",
		source: "eastmoney-push2ex",
		sourceUrl: POOL_URL,
		unit: { break_rate: "%" },
		rows: [summary],
		extra: { ladder: ladderRows },
	});
}

/** 东财重点监控池（§8.4）。 */
export async function emStockMonitor({ onlyActive = true } = {}) {
	const payload = await fetchJson("https://mobappconfig.securities.eastmoney.com/emcfg/stock_monitor.json", {
		timeoutMs: 20000,
		headers: { referer: "https://vipmoney.eastmoney.com/" },
	});
	if (payload === null) throw upstreamDown("重点监控池接口暂时不可用，请稍后重试");
	if (!Array.isArray(payload)) throw upstreamDown("重点监控池返回结构变化");
	const today = cnDateStr();
	const marketMap = { "1": "SH", "0": "SZ", B: "BJ" };
	const rows = [];
	for (const item of payload) {
		const start = String(item.VALIDATESTARTDATE ?? "");
		const end = String(item.VALIDATEENDDATE ?? "");
		if (onlyActive && !(start <= today && today <= end)) continue;
		const raw = String(item.MARKET ?? "").toUpperCase();
		rows.push({
			code: item.STKCODE ?? "",
			name: item.STKNAME ?? "",
			market: marketMap[raw] ?? `?${raw}`,
			start,
			end,
			link: item.LINK_URL ?? "",
		});
	}
	return ok({
		capability: "em_stock_monitor",
		layer: "limitup",
		source: "eastmoney-app-config",
		sourceUrl: "https://mobappconfig.securities.eastmoney.com",
		unit: {},
		rows,
		extra: { date: today, total: rows.length, only_active: onlyActive },
	});
}

const ANOMALY_BASE = "https://dycalchis.eastmoney.com/price-anomaly";
const HQ_PARAMS = { team: "h5", product: "EastMoney", client: "WAP", version: "9001", name: "WAP", user: "123" };
const ANOMALY_RULES = {
	1: "主板连续10个交易日内4次出现同向异常波动",
	2: "创业板连续10个交易日内3次出现同向异常波动",
	3: "科创板连续10个交易日内3次出现同向异常波动",
	4: "连续十个交易日内日收盘价涨跌幅偏离值累计达到+100%",
	5: "连续十个交易日内日收盘价涨跌幅偏离值累计达到-50%",
	6: "连续三十个交易日内日收盘价涨跌幅偏离值累计达到+200%",
	7: "连续三十个交易日内日收盘价涨跌幅偏离值累计达到-70%",
	8: "北交所连续10个交易日内3次出现同向异常波动",
	40: "连续十个交易日内日收盘价涨跌幅偏离值累计达到+150%",
	50: "连续十个交易日内日收盘价涨跌幅偏离值累计达到-60%",
	60: "连续30个交易日内日收盘价涨跌幅偏离值累计达到+300%",
	70: "连续30个交易日内日收盘价涨跌幅偏离值累计达到-75%",
};

function anomalyMarket(code, m, board) {
	const c = String(code ?? "");
	if (/^(4|8|92)/.test(c) || board === 8) return "BJ";
	return m === 1 ? "SH" : "SZ";
}

async function anomalyGet(path, pageSize, pageNo, extra = {}) {
	const params = new URLSearchParams({
		...HQ_PARAMS,
		pageSize: String(pageSize),
		pageNo: String(pageNo),
		...extra,
	});
	const payload = await fetchJson(`${ANOMALY_BASE}/${path}?${params}`, {
		timeoutMs: 20000,
		headers: { referer: "https://vipmoney.eastmoney.com/" },
	});
	if (payload === null) throw upstreamDown("异动接口暂时不可用，请稍后重试", path);
	if (payload.result !== 0) throw upstreamDown("东财异动接口拒绝请求", `result=${payload.result} msg=${payload.msg}`);
	return payload;
}

/** 日内异动明细（§8.5）。 */
export async function emPriceAnomaly({ pageSize = 200, pageNo = 1 } = {}) {
	const payload = await anomalyGet("list", Math.min(Math.max(pageSize, 1), 500), Math.max(pageNo, 1));
	const items = (payload.data ?? []).map((x) => {
		const ruleCode = x.s === 6 && [4, 5, 6, 7].includes(x.e) ? x.e * 10 : x.e;
		return {
			code: x.c,
			name: x.n,
			market: anomalyMarket(x.c, x.m, x.s),
			change_pct: x.a,
			deviation: x.x,
			days: x.d,
			board: x.s,
			rule_code: ruleCode,
			rule: ANOMALY_RULES[ruleCode] ?? `未知规则码 ${ruleCode}`,
			is_today: x.o !== 2,
		};
	});
	return ok({
		capability: "em_price_anomaly",
		layer: "limitup",
		source: "eastmoney-price-anomaly",
		sourceUrl: ANOMALY_BASE,
		unit: { change_pct: "%", deviation: "%" },
		rows: items,
		extra: { date: String(payload.date ?? ""), pages: payload.pages ?? 0, total: items.length },
	});
}

/** 异动统计（§8.5）。 */
export async function emPriceAnomalyCount({ pageSize = 50, pageNo = 1 } = {}) {
	const payload = await anomalyGet("count", Math.min(Math.max(pageSize, 1), 200), Math.max(pageNo, 1));
	const items = (payload.data ?? []).map((x) => ({
		code: x.c,
		name: x.n,
		market: anomalyMarket(x.c, x.m, x.s),
		price: x.p,
		change_pct: x.a,
		times: x.t,
		deviation: x.x,
		days: x.d,
		board: x.s,
	}));
	return ok({
		capability: "em_price_anomaly_count",
		layer: "limitup",
		source: "eastmoney-price-anomaly",
		sourceUrl: ANOMALY_BASE,
		unit: { price: "元", change_pct: "%", deviation: "%" },
		rows: items,
		extra: { date: String(payload.date ?? ""), pages: payload.pages ?? 0, total: items.length },
	});
}
