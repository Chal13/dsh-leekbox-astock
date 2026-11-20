// Layer 14 — 事件驱动 (skill §14.1–§14.6).
import { invalidParam, notPublished, ok, upstreamDown } from "../contract.js";
import { cnDateStr } from "../calendar.js";
import { eastmoneyDatacenter, normTicker, oneLine } from "./util.js";

const day = (value) => (value ? String(value).slice(0, 10) : "");
const num = (value) => (value === null || value === undefined || value === "" ? null : Number(value));

function eventFilter(code, extra = "", start = null, end = null, dateField = null) {
	let out = extra;
	if (code) {
		const t = normTicker(code);
		out += `(SECURITY_CODE="${t.code}")`;
	}
	if (dateField && start) out += `(${dateField}>='${start}')`;
	if (dateField && end) out += `(${dateField}<='${end}')`;
	return out;
}

/** 业绩预告（§14.1）。金额单位：元。 */
export async function earningsForecast({ code = null, reportDate = null, limit = 200 } = {}) {
	const filter = eventFilter(code, reportDate ? `(REPORT_DATE='${reportDate}')` : "");
	const data = await eastmoneyDatacenter({
		reportName: "RPT_PUBLIC_OP_NEWPREDICT",
		filter,
		pageSize: Math.min(Math.max(limit, 1), 500),
		sortColumns: "NOTICE_DATE,SECURITY_CODE,REPORT_DATE,PREDICT_FINANCE_CODE",
		sortTypes: "-1,1,-1,1",
	});
	const rows = data.map((r) => ({
		code: r.SECURITY_CODE,
		name: r.SECURITY_NAME_ABBR,
		notice_date: day(r.NOTICE_DATE),
		report_date: day(r.REPORT_DATE),
		indicator: r.PREDICT_FINANCE,
		forecast_type: r.PREDICT_TYPE,
		amount_lower: num(r.PREDICT_AMT_LOWER),
		amount_upper: num(r.PREDICT_AMT_UPPER),
		change_pct_lower: num(r.ADD_AMP_LOWER),
		change_pct_upper: num(r.ADD_AMP_UPPER),
		prior_year_amount: num(r.PREYEAR_SAME_PERIOD),
		content: oneLine(r.PREDICT_CONTENT, 120),
		reason: oneLine(r.CHANGE_REASON_EXPLAIN, 120),
	}));
	return ok({
		capability: "earnings_forecast",
		layer: "event",
		source: "eastmoney-datacenter",
		sourceUrl: "https://datacenter-web.eastmoney.com",
		unit: { amount_lower: "元", amount_upper: "元", change_pct_lower: "%", change_pct_upper: "%" },
		rows,
		extra: { total: rows.length, report_date: reportDate ?? "" },
	});
}

/** 机构调研（§14.2）。 */
export async function institutionSurvey({ code = null, start = null, end = null, detail = "false", limit = 200 } = {}) {
	const isDetail = String(detail) === "true";
	const extra = '(IS_SOURCE="1")' + (isDetail ? "" : '(NUMBERNEW="1")');
	const filter = eventFilter(code, extra, start, end, "NOTICE_DATE");
	const data = await eastmoneyDatacenter({
		reportName: "RPT_ORG_SURVEYNEW",
		filter,
		pageSize: Math.min(Math.max(limit, 1), 500),
		sortColumns: isDetail ? "NOTICE_DATE,SECURITY_CODE,RECEIVE_START_DATE,NUMBERNEW" : "NOTICE_DATE,SECURITY_CODE,RECEIVE_START_DATE",
		sortTypes: isDetail ? "-1,1,-1,1" : "-1,1,-1",
	});
	const rows = data.map((r) => {
		const row = {
			code: r.SECURITY_CODE,
			name: r.SECURITY_NAME_ABBR,
			notice_date: day(r.NOTICE_DATE),
			survey_date: day(r.RECEIVE_START_DATE),
			survey_end: day(r.RECEIVE_END_DATE),
			org_count: num(r.SUM),
			survey_way: r.RECEIVE_WAY_EXPLAIN,
			place: oneLine(r.RECEIVE_PLACE, 60),
			receptionist: oneLine(r.RECEPTIONIST, 60),
		};
		if (isDetail) {
			row.org_name = oneLine(r.RECEIVE_OBJECT, 60);
			row.org_type = r.ORG_TYPE;
			row.investigators = oneLine(r.INVESTIGATORS, 60);
		}
		return row;
	});
	return ok({
		capability: "institution_survey",
		layer: "event",
		source: "eastmoney-datacenter",
		sourceUrl: "https://datacenter-web.eastmoney.com",
		unit: {},
		rows,
		extra: { total: rows.length, detail: isDetail },
	});
}

/** 股东增减持（§14.3）。股数单位：万股。 */
export async function holderTrades({ code = null, direction = null, start = null, end = null, limit = 200 } = {}) {
	if (direction && !["增持", "减持"].includes(direction)) throw invalidParam("direction 只能是 增持 / 减持");
	const extra = direction ? `(DIRECTION="${direction}")` : "";
	const filter = eventFilter(code, extra, start, end, "NOTICE_DATE");
	const data = await eastmoneyDatacenter({
		reportName: "RPT_SHARE_HOLDER_INCREASE",
		filter,
		pageSize: Math.min(Math.max(limit, 1), 500),
		sortColumns: "NOTICE_DATE,SECURITY_CODE,HOLDER_NAME,START_DATE,END_DATE",
		sortTypes: "-1,1,1,1,1",
	});
	const rows = data.map((r) => ({
		code: r.SECURITY_CODE,
		name: r.SECURITY_NAME_ABBR,
		holder: oneLine(r.HOLDER_NAME, 60),
		direction: r.DIRECTION,
		change_shares_10k: num(r.CHANGE_NUM_SYMBOL),
		change_pct_total: num(r.AFTER_CHANGE_RATE),
		change_pct_float: num(r.CHANGE_FREE_RATIO),
		after_shares_10k: num(r.AFTER_HOLDER_NUM),
		after_pct_total: num(r.HOLD_RATIO),
		after_float_shares_10k: num(r.FREE_SHARES),
		after_pct_float: num(r.FREE_SHARES_RATIO),
		avg_price: num(r.TRADE_AVERAGE_PRICE),
		channel: r.MARKET,
		start_date: day(r.START_DATE),
		end_date: day(r.END_DATE),
		notice_date: day(r.NOTICE_DATE),
	}));
	return ok({
		capability: "holder_trades",
		layer: "event",
		source: "eastmoney-datacenter",
		sourceUrl: "https://datacenter-web.eastmoney.com",
		unit: { change_shares_10k: "万股", after_shares_10k: "万股", change_pct_total: "%", change_pct_float: "%" },
		rows,
		extra: { total: rows.length, direction: direction ?? "" },
	});
}

const BUYBACK_PROGRESS = {
	"001": "董事会预案",
	"002": "股东大会通过",
	"003": "股东大会否决",
	"004": "实施中",
	"005": "停止实施",
	"006": "完成实施",
};

/** 股票回购（§14.4）。 */
export async function shareBuyback({ code = null, progress = null, limit = 200 } = {}) {
	const codes = Object.fromEntries(Object.entries(BUYBACK_PROGRESS).map(([k, v]) => [v, k]));
	if (progress && codes[progress] === undefined) throw invalidParam(`progress 只能是 ${Object.keys(codes).join(" / ")}`);
	let filter = "";
	if (code) filter += `(DIM_SCODE="${normTicker(code).code}")`;
	if (progress) filter += `(REPURPROGRESS="${codes[progress]}")`;
	const data = await eastmoneyDatacenter({
		reportName: "RPTA_WEB_GETHGLIST_NEW",
		filter,
		pageSize: Math.min(Math.max(limit, 1), 500),
		sortColumns: "UPD,DIM_SCODE,REPURCODE",
		sortTypes: "-1,1,1",
	});
	const rows = data.map((r) => ({
		code: r.DIM_SCODE,
		name: r.SECURITYSHORTNAME,
		progress: BUYBACK_PROGRESS[r.REPURPROGRESS] ?? null,
		progress_code: r.REPURPROGRESS,
		plan_start: day(r.REPURSTARTDATE),
		plan_end: day(r.REPURENDDATE),
		price_cap: num(r.REPURPRICECAP),
		shares_lower: num(r.REPURNUMLOWER),
		shares_upper: num(r.REPURNUMCAP),
		amount_lower: num(r.REPURAMOUNTLOWER),
		amount_upper: num(r.REPURAMOUNTLIMIT),
		pct_total_lower: num(r.ZSZXX),
		pct_total_upper: num(r.ZSZSX),
		done_shares: num(r.REPURNUM),
		done_amount: num(r.REPURAMOUNT),
		done_price_low: num(r.REPURPRICELOWER1),
		done_price_high: num(r.REPURPRICECAP1),
		latest_notice: day(r.UPDATEDATE),
		objective: oneLine(r.REPUROBJECTIVE, 80),
	}));
	return ok({
		capability: "share_buyback",
		layer: "event",
		source: "eastmoney-datacenter",
		sourceUrl: "https://datacenter-web.eastmoney.com",
		unit: { shares_lower: "股", shares_upper: "股", amount_lower: "元", amount_upper: "元", done_amount: "元" },
		rows,
		extra: { total: rows.length, progress: progress ?? "" },
	});
}

/** 股权质押（§14.5）：中国结算周度，仅沪深。 */
export async function equityPledge({ code = null, date = null, limit = 500 } = {}) {
	if (code && date) throw invalidParam("code 与 date 只能给一个");
	const report = "RPT_CSDC_LIST";
	let filter;
	let sourceDate = date;
	if (code) {
		const t = normTicker(code);
		if (t.market === "BJ") throw invalidParam(`${code} 是北交所证券；中国结算质押统计只覆盖沪深`);
		filter = `(SECURITY_CODE="${t.code}")`;
	} else {
		if (!sourceDate) {
			const latest = await eastmoneyDatacenter({
				reportName: report,
				filter: "",
				pageSize: 1,
				sortColumns: "TRADE_DATE",
				sortTypes: "-1",
			});
			if (latest.length === 0) throw notPublished("没有可用的质押统计日");
			sourceDate = day(latest[0].TRADE_DATE);
		}
		filter = `(TRADE_DATE='${sourceDate}')`;
	}
	const data = await eastmoneyDatacenter({
		reportName: report,
		filter,
		pageSize: Math.min(Math.max(limit, 1), 5000),
		sortColumns: code ? "TRADE_DATE" : "PLEDGE_RATIO,SECURITY_CODE",
		sortTypes: code ? "-1" : "-1,1",
	});
	if (data.length === 0) {
		throw notPublished(`${sourceDate ?? ""} 不是中国结算质押统计日（按周发布，通常为周五）`);
	}
	const rows = data.map((r) => ({
		date: day(r.TRADE_DATE),
		code: r.SECURITY_CODE,
		name: r.SECURITY_NAME_ABBR,
		industry: r.INDUSTRY,
		pledge_ratio_pct: num(r.PLEDGE_RATIO),
		pledged_shares_10k: num(r.REPURCHASE_BALANCE),
		pledged_mktcap_10k: num(r.PLEDGE_MARKET_CAP),
		pledge_count: num(r.PLEDGE_DEAL_NUM),
		unrestricted_pledged_10k: num(r.REPURCHASE_UNLIMITED_BALANCE),
		restricted_pledged_10k: num(r.REPURCHASE_LIMITED_BALANCE),
	}));
	return ok({
		capability: "equity_pledge",
		layer: "event",
		source: "eastmoney-datacenter",
		sourceUrl: "https://datacenter-web.eastmoney.com",
		unit: { pledge_ratio_pct: "%", pledged_shares_10k: "万股", pledged_mktcap_10k: "万元" },
		rows,
		extra: { date: sourceDate ?? "", total: rows.length, note: "仅覆盖沪深，无北交所" },
	});
}

/** 新股申购日历（§14.6）。 */
export async function ipoCalendar({ limit = 100 } = {}) {
	const data = await eastmoneyDatacenter({
		reportName: "RPTA_APP_IPOAPPLY",
		filter: "",
		pageSize: Math.min(Math.max(limit, 1), 500),
		sortColumns: "APPLY_DATE,SECURITY_CODE",
		sortTypes: "-1,-1",
	});
	const rows = data.map((r) => ({
		code: r.SECURITY_CODE,
		name: r.SECURITY_NAME,
		apply_code: r.APPLY_CODE,
		exchange: r.TRADE_MARKET,
		board: r.MARKET || r.MARKET_TYPE_NEW,
		apply_date: day(r.APPLY_DATE),
		ballot_date: day(r.BALLOT_NUM_DATE),
		pay_date: day(r.BALLOT_PAY_DATE),
		listing_date: day(r.LISTING_DATE),
		issue_price: num(r.ISSUE_PRICE) || null,
		issue_pe: num(r.AFTER_ISSUE_PE),
		industry_pe: num(r.INDUSTRY_PE),
		issue_shares_10k: num(r.ISSUE_NUM),
		online_shares: num(r.ONLINE_ISSUE_NUM),
		apply_upper_shares: num(r.ONLINE_APPLY_UPPER),
		top_apply_mktcap_10k: num(r.TOP_APPLY_MARKETCAP),
		win_rate_pct: num(r.ONLINE_ISSUE_LWR),
		first_close: num(r.CLOSE_PRICE),
		first_close_chg_pct: num(r.LD_CLOSE_CHANGE),
	}));
	return ok({
		capability: "ipo_calendar",
		layer: "event",
		source: "eastmoney-datacenter",
		sourceUrl: "https://datacenter-web.eastmoney.com",
		unit: { issue_price: "元", issue_shares_10k: "万股", online_shares: "股", win_rate_pct: "%" },
		rows,
		extra: { total: rows.length },
	});
}
