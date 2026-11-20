// Layer 4 — 资金面 / 筹码层 (skill §4.1–§4.7).
import { fetchJson } from "../fetch-utils.js";
import { invalidParam, notPublished, ok, upstreamDown } from "../contract.js";
import { cnDateStr } from "../calendar.js";
import { eastmoneyDatacenter, normTicker, oneLine } from "./util.js";

/** 融资融券明细（§4.1）。金额单位：元。 */
export async function marginTrading({ code, pageSize = 30 } = {}) {
	const t = normTicker(code);
	const data = await eastmoneyDatacenter({
		reportName: "RPTA_WEB_RZRQ_GGMX",
		filter: `(SCODE="${t.code}")`,
		pageSize: Math.min(Math.max(pageSize, 1), 120),
		sortColumns: "DATE",
		sortTypes: "-1",
	});
	const rows = data.map((row) => ({
		date: String(row.DATE ?? "").slice(0, 10),
		rzye: row.RZYE ?? 0,
		rzmre: row.RZMRE ?? 0,
		rzche: row.RZCHE ?? 0,
		rqye: row.RQYE ?? 0,
		rqmcl: row.RQMCL ?? 0,
		rqchl: row.RQCHL ?? 0,
		rzrqye: row.RZRQYE ?? 0,
	}));
	return ok({
		capability: "margin_trading",
		layer: "capital",
		source: "eastmoney-datacenter",
		sourceUrl: "https://datacenter-web.eastmoney.com",
		unit: { rzye: "元", rzmre: "元", rzche: "元", rqye: "元", rzrqye: "元" },
		rows,
		extra: { code: t.code, note: rows.length === 0 ? "无两融数据（可能不是两融标的）" : "" },
	});
}

/** 大宗交易（§4.2）。amount 单位：元。 */
export async function blockTrade({ code, pageSize = 20 } = {}) {
	const t = normTicker(code);
	const data = await eastmoneyDatacenter({
		reportName: "RPT_DATA_BLOCKTRADE",
		filter: `(SECURITY_CODE="${t.code}")`,
		pageSize: Math.min(Math.max(pageSize, 1), 100),
		sortColumns: "TRADE_DATE",
		sortTypes: "-1",
	});
	const rows = data.map((row) => {
		const close = row.CLOSE_PRICE ?? 0;
		const price = row.DEAL_PRICE ?? 0;
		const premium = close ? (price / close - 1) * 100 : 0;
		return {
			date: String(row.TRADE_DATE ?? "").slice(0, 10),
			price,
			close,
			premium_pct: Math.round(premium * 100) / 100,
			vol: row.DEAL_VOLUME ?? 0,
			amount: row.DEAL_AMT ?? 0,
			buyer: oneLine(row.BUYER_NAME),
			seller: oneLine(row.SELLER_NAME),
		};
	});
	return ok({
		capability: "block_trade",
		layer: "capital",
		source: "eastmoney-datacenter",
		sourceUrl: "https://datacenter-web.eastmoney.com",
		unit: { price: "元", vol: "股", amount: "元", premium_pct: "%" },
		rows,
		extra: { code: t.code },
	});
}

/** 股东户数变化（§4.3）。 */
export async function holderNumChange({ code, pageSize = 10 } = {}) {
	const t = normTicker(code);
	const data = await eastmoneyDatacenter({
		reportName: "RPT_HOLDERNUMLATEST",
		filter: `(SECURITY_CODE="${t.code}")`,
		pageSize: Math.min(Math.max(pageSize, 1), 40),
		sortColumns: "END_DATE",
		sortTypes: "-1",
	});
	const rows = data.map((row) => ({
		date: String(row.END_DATE ?? "").slice(0, 10),
		holder_num: row.HOLDER_NUM ?? 0,
		change_num: row.HOLDER_NUM_CHANGE ?? 0,
		change_ratio: row.HOLDER_NUM_RATIO ?? 0,
		avg_shares: row.AVG_FREE_SHARES ?? 0,
	}));
	return ok({
		capability: "holder_num_change",
		layer: "capital",
		source: "eastmoney-datacenter",
		sourceUrl: "https://datacenter-web.eastmoney.com",
		unit: { change_ratio: "%", avg_shares: "股" },
		rows,
		extra: { code: t.code },
	});
}

/** 分红送转历史（§4.4）。 */
export async function dividendHistory({ code, pageSize = 20 } = {}) {
	const t = normTicker(code);
	const data = await eastmoneyDatacenter({
		reportName: "RPT_SHAREBONUS_DET",
		filter: `(SECURITY_CODE="${t.code}")`,
		pageSize: Math.min(Math.max(pageSize, 1), 60),
		sortColumns: "EX_DIVIDEND_DATE",
		sortTypes: "-1",
	});
	const rows = data.map((row) => ({
		date: String(row.EX_DIVIDEND_DATE ?? "").slice(0, 10),
		bonus_rmb: row.PRETAX_BONUS_RMB ?? 0,
		transfer_ratio: row.TRANSFER_RATIO ?? 0,
		bonus_ratio: row.BONUS_RATIO ?? 0,
		plan: oneLine(row.ASSIGN_PROGRESS, 40),
	}));
	return ok({
		capability: "dividend_history",
		layer: "capital",
		source: "eastmoney-datacenter",
		sourceUrl: "https://datacenter-web.eastmoney.com",
		unit: { bonus_rmb: "元/股", transfer_ratio: "每10股", bonus_ratio: "每10股" },
		rows,
		extra: { code: t.code },
	});
}

/** 个股资金流（120 日，日级，§4.5）。单位：元。 */
export async function stockFundFlow120d({ code } = {}) {
	const t = normTicker(code);
	const params = new URLSearchParams({
		secid: t.secid,
		fields1: "f1,f2,f3,f7",
		fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65",
		lmt: "120",
	});
	const payload = await fetchJson(`https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?${params}`, {
		timeoutMs: 15000,
		headers: { referer: "https://quote.eastmoney.com/", origin: "https://quote.eastmoney.com" },
	});
	if (payload === null) throw upstreamDown("资金流接口暂时不可用，请稍后重试", "push2his fflow request failed");
	const lines = payload?.data?.klines;
	if (!Array.isArray(lines)) throw upstreamDown("资金流接口返回结构变化", "missing data.klines");
	const rows = [];
	for (const line of lines) {
		const parts = String(line).split(",");
		if (parts.length >= 6) {
			const num = (v) => (v === "-" || v === undefined ? 0 : Number(v));
			rows.push({
				date: parts[0],
				main_net: num(parts[1]),
				small_net: num(parts[2]),
				mid_net: num(parts[3]),
				large_net: num(parts[4]),
				super_net: num(parts[5]),
			});
		}
	}
	return ok({
		capability: "stock_fund_flow_120d",
		layer: "capital",
		source: "eastmoney-push2his",
		sourceUrl: "https://push2his.eastmoney.com",
		unit: { main_net: "元", small_net: "元", mid_net: "元", large_net: "元", super_net: "元" },
		rows,
		extra: { code: t.code },
	});
}

/** 日 K（前复权）+ 换手率，供 CYQ 使用。 */
async function fetchDailyBars(t, { limit = 250 } = {}) {
	const params = new URLSearchParams({
		secid: t.secid,
		fields1: "f1,f2,f3,f4,f5,f6",
		fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
		klt: "101",
		fqt: "1",
		beg: "0",
		end: "20500101",
		lmt: String(Math.min(Math.max(limit, 20), 500)),
	});
	const payload = await fetchJson(`https://push2his.eastmoney.com/api/qt/stock/kline/get?${params}`, {
		timeoutMs: 15000,
		headers: { referer: "https://quote.eastmoney.com/" },
	});
	const lines = payload?.data?.klines;
	if (!Array.isArray(lines)) throw upstreamDown("K 线接口暂时不可用，请稍后重试", "missing data.klines");
	const parsed = lines
		.map((line) => {
			const p = String(line).split(",");
			if (p.length < 11) return null;
			return {
				date: p[0],
				open: Number(p[1]),
				close: Number(p[2]),
				high: Number(p[3]),
				low: Number(p[4]),
				volume: Number(p[5]),
				amount: Number(p[6]),
				turn: Number(p[10]),
			};
		})
		.filter((row) => row !== null && row.high > 0);
	// EM sometimes ignores lmt when beg/end are supplied; enforce the window here.
	return parsed.slice(-Math.min(Math.max(limit, 20), 500)).slice();
}

/** 筹码分布 CYQ（§4.6，纯 JS 本地推演）。 */
export async function chipDistribution({ code, days = 250, gridSize = 300, decay = 1.0 } = {}) {
	const t = normTicker(code);
	const bars = await fetchDailyBars(t, { limit: days });
	if (bars.length < 20) throw notPublished("有效 K 线不足 20 根，无法推演筹码分布", `rows=${bars.length}`);
	const sorted = bars.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
	const gridN = Math.min(Math.max(Math.round(gridSize), 60), 600);
	const lo = Math.min(...sorted.map((r) => r.low));
	const hi = Math.max(...sorted.map((r) => r.high));
	const pad = (hi - lo) * 0.02 || Math.max(lo * 0.02, 0.01);
	const grid = Array.from({ length: gridN }, (_, i) => lo - pad + ((hi + pad - (lo - pad)) * i) / (gridN - 1));

	const triangular = (low, high, avg) => {
		const w = new Array(gridN).fill(0);
		if (![low, high, avg].every(Number.isFinite) || high < low) return w;
		avg = Math.min(Math.max(avg, low), high);
		if (high - low < 1e-9) {
			let best = 0;
			for (let i = 1; i < gridN; i++) if (Math.abs(grid[i] - low) < Math.abs(grid[best] - low)) best = i;
			w[best] = 1;
			return w;
		}
		let total = 0;
		for (let i = 0; i < gridN; i++) {
			const p = grid[i];
			let v = 0;
			if (p >= low && p <= avg) v = avg - low > 1e-9 ? (p - low) / (avg - low) : 1;
			else if (p > avg && p <= high) v = high - avg > 1e-9 ? (high - p) / (high - avg) : 1;
			w[i] = v;
			total += v;
		}
		if (total > 0) return w.map((v) => v / total);
		let best = 0;
		for (let i = 1; i < gridN; i++) if (Math.abs(grid[i] - avg) < Math.abs(grid[best] - avg)) best = i;
		w.fill(0);
		w[best] = 1;
		return w;
	};

	let chips = null;
	for (const row of sorted) {
		const turn = Math.min(Math.max((row.turn / 100) * decay, 0), 1);
		const avg = (row.high + row.low + row.close) / 3;
		const w = triangular(row.low, row.high, avg);
		if (chips === null) {
			chips = w;
			continue;
		}
		for (let i = 0; i < gridN; i++) chips[i] = chips[i] * (1 - turn) + w[i] * turn;
	}
	const total = chips.reduce((a, b) => a + b, 0);
	if (!(total > 0)) throw upstreamDown("筹码分布推演失败：筹码总量为 0", "chips sum <= 0");
	for (let i = 0; i < gridN; i++) chips[i] /= total;

	const cumulative = [];
	let acc = 0;
	for (const c of chips) cumulative.push((acc += c));
	const priceAt = (q) => {
		if (q <= 0) return grid[0];
		if (q >= 1) return grid[gridN - 1];
		let i = cumulative.findIndex((c) => c >= q);
		if (i <= 0) i = 1;
		const c0 = cumulative[i - 1];
		const c1 = cumulative[i];
		const t2 = c1 - c0 === 0 ? 0 : (q - c0) / (c1 - c0);
		return grid[i - 1] + (grid[i] - grid[i - 1]) * t2;
	};

	const price = sorted[sorted.length - 1].close;
	const profitRatio = chips.reduce((sum, c, i) => (grid[i] <= price ? sum + c : sum), 0);
	const avgCost = chips.reduce((sum, c, i) => sum + grid[i] * c, 0);
	const p05 = priceAt(0.05);
	const p15 = priceAt(0.15);
	const p85 = priceAt(0.85);
	const p95 = priceAt(0.95);
	let peak = 0;
	for (let i = 1; i < gridN; i++) if (chips[i] > chips[peak]) peak = i;

	const summary = {
		price,
		profit_ratio: Math.round(profitRatio * 10000) / 10000,
		avg_cost: Math.round(avgCost * 100) / 100,
		cost_90: [Math.round(p05 * 100) / 100, Math.round(p95 * 100) / 100],
		cost_70: [Math.round(p15 * 100) / 100, Math.round(p85 * 100) / 100],
		concentration_90: p95 + p05 ? Math.round(((p95 - p05) / (p95 + p05)) * 10000) / 10000 : null,
		concentration_70: p85 + p15 ? Math.round(((p85 - p15) / (p85 + p15)) * 10000) / 10000 : null,
		peak_price: Math.round(grid[peak] * 100) / 100,
		bars: sorted.length,
		window_turnover: Math.round(sorted.reduce((s, r) => s + r.turn, 0) * 100) / 100,
	};
	const histogram = grid
		.map((p, i) => [Math.round(p * 100) / 100, Math.round(chips[i] * 1e6) / 1e6])
		.filter(([, c]) => c > 1e-6);
	return ok({
		capability: "chip_distribution",
		layer: "capital",
		source: "local-compute",
		sourceUrl: "computed from eastmoney kline",
		unit: { profit_ratio: "0-1", window_turnover: "%" },
		rows: [summary],
		extra: { code: t.code, histogram },
	});
}

/** ETF 份额（§4.7）：上交所按日、深交所当前快照。单位：万份。 */
export async function etfShares({ date = cnDateStr(), exchange = "SH" } = {}) {
	const ex = String(exchange).toUpperCase();
	if (ex === "SH") return etfSharesSh(date);
	if (ex === "SZ") return etfSharesSz(date);
	throw invalidParam("exchange 只能是 SH 或 SZ");
}

async function etfSharesSh(day) {
	const params = new URLSearchParams({
		sqlId: "COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L",
		STAT_DATE: day,
		isPagination: "true",
		"pageHelp.pageSize": "10000",
		"pageHelp.pageNo": "1",
		"pageHelp.beginPage": "1",
		"pageHelp.cacheSize": "1",
		"pageHelp.endPage": "1",
	});
	const payload = await fetchJson(`https://query.sse.com.cn/commonQuery.do?${params}`, {
		timeoutMs: 20000,
		headers: { referer: "https://www.sse.com.cn/" },
	});
	if (payload === null) throw upstreamDown("上交所 ETF 份额接口不可用，请稍后重试");
	const result = payload?.result;
	const total = Number(payload?.pageHelp?.total);
	if (!Array.isArray(result) || !Number.isFinite(total)) throw upstreamDown("上交所 ETF 接口返回结构变化");
	if (result.length === 0) throw notPublished(`上交所 ${day} 没有 ETF 份额数据（非交易日或尚未发布）`);
	if (result.length !== total) throw upstreamDown("上交所 ETF 返回条数与自报总数不符", `${result.length}/${total}`);
	const rows = result.map((rec) => ({
		date: String(rec.STAT_DATE ?? ""),
		exchange: "SH",
		code: String(rec.SEC_CODE ?? ""),
		name: String(rec.SEC_NAME ?? ""),
		etf_type: String(rec.ETF_TYPE ?? ""),
		shares_10k: Number(rec.TOT_VOL ?? 0),
	}));
	return ok({
		capability: "etf_shares",
		layer: "capital",
		source: "sse",
		sourceUrl: "https://query.sse.com.cn/commonQuery.do",
		unit: { shares_10k: "万份" },
		rows,
		extra: { date: day, exchange: "SH", total },
	});
}

async function etfSharesSz(day) {
	const base = "https://fund.szse.cn/api/report/ShowReport/data";
	const rows = [];
	let page = 1;
	let snapDate = null;
	let pageCount = 1;
	let recordCount = 0;
	while (page <= pageCount) {
		const params = new URLSearchParams({
			SHOWTYPE: "JSON",
			CATALOGID: "1000_lf",
			TABKEY: "tab1",
			selectJjlb: "ETF",
			PAGENO: String(page),
		});
		const payload = await fetchJson(`${base}?${params}`, {
			timeoutMs: 20000,
			headers: { referer: "https://fund.szse.cn/" },
		});
		const table = Array.isArray(payload) ? payload[0] : null;
		const meta = table?.metadata;
		const data = table?.data;
		if (!meta || !Array.isArray(data)) throw upstreamDown("深交所基金列表返回结构变化", `page ${page}`);
		const currentSnap = String(meta.subname ?? "").trim();
		const currentPageCount = Number(meta.pagecount);
		const currentRecordCount = Number(meta.recordcount);
		if (snapDate === null) {
			snapDate = currentSnap;
			pageCount = currentPageCount;
			recordCount = currentRecordCount;
			if (snapDate !== day) {
				throw notPublished(`深交所当前规模快照日期是 ${snapDate}，不是 ${day}；深市只能取最新一天`);
			}
		} else if (currentSnap !== snapDate || currentPageCount !== pageCount) {
			throw upstreamDown("深交所 ETF 列表翻页时快照发生变化，请重试");
		}
		if (data.length === 0) throw upstreamDown(`深交所 ETF 第 ${page} 页为空，结果不完整`);
		for (const rec of data) {
			const code = String(rec.sys_key ?? "").match(/<u>(\d{6})<\/u>/);
			const name = String(rec.jjjcurl ?? "").match(/<u>(.*?)<\/u>/);
			const shares = String(rec.dqgm ?? "").match(/>([\d,.]+)<\/a>/);
			if (!code || !name || !shares) throw upstreamDown("深交所基金列表字段格式改变");
			rows.push({
				date: day,
				exchange: "SZ",
				code: code[1],
				name: name[1],
				fund_category: String(rec.tzlb ?? ""),
				shares_10k: Number(String(shares[1]).replace(/,/g, "")) || 0,
				manager: String(rec.glrmc ?? ""),
				listing_date: String(rec.ssrq ?? ""),
			});
		}
		page += 1;
	}
	if (rows.length !== recordCount) {
		throw upstreamDown("深交所 ETF 返回条数与自报总数不符", `${rows.length}/${recordCount}`);
	}
	return ok({
		capability: "etf_shares",
		layer: "capital",
		source: "szse",
		sourceUrl: base,
		unit: { shares_10k: "万份" },
		rows,
		extra: { date: day, exchange: "SZ", total: recordCount },
	});
}
