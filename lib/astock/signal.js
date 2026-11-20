// Layer 3 — 信号层 endpoints (skill §3.5–§3.9).
import { fetchJson } from "../fetch-utils.js";
import { invalidParam, upstreamDown, ok } from "../contract.js";
import { cnDateStr } from "../calendar.js";
import { eastmoneyDatacenter, normTicker, push2Clist } from "./util.js";

const BOARD_FS = { industry: "m:90+t:2", concept: "m:90+t:3", region: "m:90+t:1" };
const BOARD_PERIOD = {
	today: { fid: "f62", main: "f62", pct: "f184", chg: "f3", leader: "f204" },
	"5d": { fid: "f164", main: "f164", pct: "f165", chg: "f109", leader: "f257" },
	"10d": { fid: "f174", main: "f174", pct: "f175", chg: "f160", leader: null },
};

/** 板块资金流向（skill §3.8）：行业/概念/地域 × 今日/5日/10日。 */
export async function boardFundFlow({ boardType = "industry", period = "today", topN = 20 } = {}) {
	const fs = BOARD_FS[boardType];
	if (fs === undefined) throw invalidParam(`boardType 须为 ${Object.keys(BOARD_FS).join(" / ")}`);
	const spec = BOARD_PERIOD[period];
	if (spec === undefined) throw invalidParam(`period 须为 ${Object.keys(BOARD_PERIOD).join(" / ")}`);

	const fields = ["f12", "f14", spec.chg, spec.main, spec.pct];
	if (spec.leader) fields.push(spec.leader);
	if (period === "today") fields.push("f66", "f72", "f78", "f84");

	const base = { fs, fid: spec.fid, fields: [...new Set(fields)].join(","), pz: 200 };
	const first = await push2Clist({ ...base, pn: 1 });
	let items = first.rows;
	let total = first.total;
	let page = 2;
	while (items.length < topN && items.length < total && page <= 5) {
		const next = await push2Clist({ ...base, pn: page });
		if (next.rows.length === 0) break;
		items = items.concat(next.rows);
		total = Math.max(total, next.total);
		if (next.rows.length < 200) break;
		page += 1;
	}
	total = Math.max(total, items.length);

	const rows = items.slice(0, Math.max(0, topN)).map((item, index) => {
		const row = {
			rank: index + 1,
			name: String(item.f14 ?? ""),
			code: String(item.f12 ?? ""),
			change_pct: item[spec.chg] ?? 0,
			main_net: item[spec.main] ?? 0,
			main_pct: item[spec.pct] ?? 0,
			leader: spec.leader ? String(item[spec.leader] ?? "") : "",
		};
		if (period === "today") {
			row.super_large_net = item.f66 ?? 0;
			row.large_net = item.f72 ?? 0;
			row.medium_net = item.f78 ?? 0;
			row.small_net = item.f84 ?? 0;
		}
		return row;
	});

	return ok({
		capability: "board_fund_flow",
		layer: "signal",
		source: "eastmoney",
		sourceUrl: "https://push2.eastmoney.com/api/qt/clist/get",
		unit: { main_net: "元", main_pct: "%", change_pct: "%" },
		rows,
		extra: { board_type: boardType, period, total },
	});
}

/** 行业板块涨跌排名（skill §3.7）。 */
export async function industryComparison({ topN = 20 } = {}) {
	const page = await push2Clist({
		fs: "m:90+t:2",
		fid: "f3",
		fields: "f2,f3,f4,f12,f13,f14,f104,f105,f128,f136,f140,f141,f207",
		pz: 100,
	});
	const rows = page.rows.map((item, index) => ({
		rank: index + 1,
		name: String(item.f14 ?? ""),
		code: String(item.f12 ?? ""),
		change_pct: item.f3 ?? 0,
		up_count: item.f104 ?? 0,
		down_count: item.f105 ?? 0,
		leader: String(item.f140 ?? ""),
		leader_change: item.f136 ?? 0,
	}));
	const top = rows.slice(0, topN);
	const bottom = rows.slice(-topN);
	return ok({
		capability: "industry_comparison",
		layer: "signal",
		source: "eastmoney",
		sourceUrl: "https://push2.eastmoney.com/api/qt/clist/get",
		unit: { change_pct: "%" },
		rows: top,
		extra: { bottom, total: rows.length },
	});
}

/** 限售解禁日历（skill §3.6）。单位：万股 / 小数比例。 */
export async function lockupExpiry({ code, tradeDate = cnDateStr(), forwardDays = 90 } = {}) {
	const t = normTicker(code);
	const end = new Date(`${tradeDate}T00:00:00+08:00`);
	if (Number.isNaN(end.getTime())) throw invalidParam("tradeDate 须为 YYYY-MM-DD");
	end.setDate(end.getDate() + forwardDays);
	const endStr = end.toISOString().slice(0, 10);

	const [historyData, upcomingData] = await Promise.all([
		eastmoneyDatacenter({
			reportName: "RPT_LIFT_STAGE",
			filter: `(SECURITY_CODE="${t.code}")`,
			pageSize: 15,
			sortColumns: "FREE_DATE",
			sortTypes: "-1",
		}),
		eastmoneyDatacenter({
			reportName: "RPT_LIFT_STAGE",
			filter: `(SECURITY_CODE="${t.code}")(FREE_DATE>='${tradeDate}')(FREE_DATE<='${endStr}')`,
			pageSize: 20,
			sortColumns: "FREE_DATE",
			sortTypes: "1",
		}),
	]);

	const shape = (row) => ({
		date: String(row.FREE_DATE ?? "").slice(0, 10),
		type: String(row.FREE_SHARES_TYPE ?? ""),
		shares: row.FREE_SHARES ?? 0,
		able_shares: row.ABLE_FREE_SHARES ?? 0,
		ratio: row.FREE_RATIO ?? 0,
	});

	const rows = historyData.map(shape);
	return ok({
		capability: "lockup_expiry",
		layer: "signal",
		source: "eastmoney-datacenter",
		sourceUrl: "https://datacenter-web.eastmoney.com",
		unit: { shares: "万股", able_shares: "万股", ratio: "小数" },
		rows,
		extra: {
			code: t.code,
			history: rows,
			upcoming: upcomingData.map(shape),
			note: upcomingData.length === 0 ? `未来 ${forwardDays} 天无待解禁` : "",
		},
	});
}

/** 个股龙虎榜 + 买卖席位 TOP5 + 机构统计（skill §3.5）。 */
export async function dragonTigerBoard({ code, tradeDate = cnDateStr(), lookBack = 30 } = {}) {
	const t = normTicker(code);
	const start = new Date(`${tradeDate}T00:00:00+08:00`);
	if (Number.isNaN(start.getTime())) throw invalidParam("tradeDate 须为 YYYY-MM-DD");
	start.setDate(start.getDate() - lookBack);
	const startStr = start.toISOString().slice(0, 10);

	const detail = await eastmoneyDatacenter({
		reportName: "RPT_DAILYBILLBOARD_DETAILSNEW",
		filter: `(TRADE_DATE>='${startStr}')(TRADE_DATE<='${tradeDate}')(SECURITY_CODE="${t.code}")`,
		pageSize: 50,
		sortColumns: "TRADE_DATE",
		sortTypes: "-1",
	});

	const records = detail.map((row) => ({
		date: String(row.TRADE_DATE ?? "").slice(0, 10),
		reason: String(row.EXPLANATION ?? ""),
		net_buy: Math.round(((row.BILLBOARD_NET_AMT ?? 0) / 1e4) * 10) / 10,
		turnover: Math.round(Number(row.TURNOVERRATE ?? 0) * 100) / 100,
	}));

	let buyData = [];
	let sellData = [];
	if (records.length > 0) {
		const latest = records[0].date;
		[buyData, sellData] = await Promise.all([
			eastmoneyDatacenter({
				reportName: "RPT_BILLBOARD_DAILYDETAILSBUY",
				filter: `(TRADE_DATE='${latest}')(SECURITY_CODE="${t.code}")`,
				pageSize: 10,
				sortColumns: "BUY",
				sortTypes: "-1",
			}),
			eastmoneyDatacenter({
				reportName: "RPT_BILLBOARD_DAILYDETAILSSELL",
				filter: `(TRADE_DATE='${latest}')(SECURITY_CODE="${t.code}")`,
				pageSize: 10,
				sortColumns: "SELL",
				sortTypes: "-1",
			}),
		]);
	}

	const seat = (row) => ({
		name: String(row.OPERATEDEPT_NAME ?? ""),
		buy_amt: Math.round(((row.BUY ?? 0) / 1e4) * 10) / 10,
		sell_amt: Math.round(((row.SELL ?? 0) / 1e4) * 10) / 10,
		net: Math.round(((row.NET ?? 0) / 1e4) * 10) / 10,
	});
	const seats = { buy: buyData.slice(0, 5).map(seat), sell: sellData.slice(0, 5).map(seat) };

	const institution = { buy_amt: 0, sell_amt: 0, net_amt: 0 };
	for (const row of buyData) {
		if (String(row.OPERATEDEPT_CODE ?? "") === "0") institution.buy_amt += row.BUY ?? 0;
	}
	for (const row of sellData) {
		if (String(row.OPERATEDEPT_CODE ?? "") === "0") institution.sell_amt += row.SELL ?? 0;
	}
	institution.buy_amt = Math.round((institution.buy_amt / 1e4) * 10) / 10;
	institution.sell_amt = Math.round((institution.sell_amt / 1e4) * 10) / 10;
	institution.net_amt = Math.round((institution.buy_amt - institution.sell_amt) * 10) / 10;

	return ok({
		capability: "dragon_tiger_board",
		layer: "signal",
		source: "eastmoney-datacenter",
		sourceUrl: "https://datacenter-web.eastmoney.com",
		unit: { net_buy: "万元", buy_amt: "万元", sell_amt: "万元", turnover: "%" },
		rows: records,
		extra: {
			code: t.code,
			seats,
			institution,
			note: records.length === 0 ? `近 ${lookBack} 天没有上榜记录` : "",
		},
	});
}

/** 全市场龙虎榜（skill §3.9）。 */
export async function dailyDragonTiger({ date = cnDateStr(), minNetBuy = null } = {}) {
	const data = await eastmoneyDatacenter({
		reportName: "RPT_DAILYBILLBOARD_DETAILSNEW",
		filter: `(TRADE_DATE>='${date}')(TRADE_DATE<='${date}')`,
		pageSize: 500,
		sortColumns: "BILLBOARD_NET_AMT",
		sortTypes: "-1",
	});
	if (data.length === 0) {
		return ok({
			capability: "daily_dragon_tiger",
			layer: "signal",
			source: "eastmoney-datacenter",
			sourceUrl: "https://datacenter-web.eastmoney.com",
			unit: { net_buy_wan: "万元", change_pct: "%" },
			rows: [],
			extra: { date, total_records: 0, note: "无数据（非交易日或盘后未更新）" },
		});
	}
	const actualDate = String(data[0].TRADE_DATE ?? "").slice(0, 10) || date;
	const stocks = [];
	for (const row of data) {
		const net = (row.BILLBOARD_NET_AMT ?? 0) / 1e4;
		if (minNetBuy !== null && Number.isFinite(minNetBuy) && net < minNetBuy) continue;
		stocks.push({
			code: String(row.SECURITY_CODE ?? ""),
			name: String(row.SECURITY_NAME_ABBR ?? ""),
			reason: String(row.EXPLANATION ?? ""),
			close: row.CLOSE_PRICE ?? 0,
			change_pct: Math.round(Number(row.CHANGE_RATE ?? 0) * 100) / 100,
			net_buy_wan: Math.round(net * 10) / 10,
			buy_wan: Math.round(((row.BILLBOARD_BUY_AMT ?? 0) / 1e4) * 10) / 10,
			sell_wan: Math.round(((row.BILLBOARD_SELL_AMT ?? 0) / 1e4) * 10) / 10,
			turnover_pct: Math.round(Number(row.TURNOVERRATE ?? 0) * 100) / 100,
		});
	}
	return ok({
		capability: "daily_dragon_tiger",
		layer: "signal",
		source: "eastmoney-datacenter",
		sourceUrl: "https://datacenter-web.eastmoney.com",
		unit: { net_buy_wan: "万元", buy_wan: "万元", sell_wan: "万元", change_pct: "%" },
		rows: stocks,
		extra: { date: actualDate, total_records: stocks.length },
	});
}
