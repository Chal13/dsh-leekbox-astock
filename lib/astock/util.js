// Shared helpers for a-stock capabilities: ticker normalization and the two
// Eastmoney API shapes the skill relies on (datacenter reports + push2 clist).
import { fetchJson } from "../fetch-utils.js";
import { invalidParam, upstreamDown } from "../contract.js";

const DATACENTER_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const PUSH2_HOSTS = ["https://push2.eastmoney.com", "https://push2delay.eastmoney.com", "http://48.push2.eastmoney.com"];

/** Canonical market from the bare code (same rules as lib/search-index.js). */
export function marketFromCode(code) {
	if (/^11/.test(code)) return "SH";
	if (/^(12|13)/.test(code)) return "SZ";
	if (/^(4|8|92)/.test(code)) return "BJ";
	if (/^[569]/.test(code)) return "SH";
	return "SZ";
}

/**
 * Accept `600519` / `SH600519` / `600519.SH` / `600519.XSHG` and return the
 * normalized identity. Contradictory prefixes/suffixes throw instead of
 * silently picking one (the skill documents this as the "wrong stock" class of
 * bug: 000016.SH is 上证50, not 深康佳A).
 */
export function normTicker(raw) {
	let text = String(raw ?? "").trim().toUpperCase();
	if (text === "") throw invalidParam("缺少股票代码");

	let suffix = "";
	const dot = text.match(/^(\d{5,6})\.(SH|SZ|BJ|XSHG|XSHE)$/);
	if (dot) {
		text = dot[1];
		suffix = dot[2] === "XSHG" ? "SH" : dot[2] === "XSHE" ? "SZ" : dot[2];
	}

	let code;
	let market;
	const prefix = text.match(/^(SH|SZ|BJ)(\d{5,6})$/);
	if (prefix) {
		market = prefix[1];
		code = prefix[2];
	} else {
		code = text.replace(/\D/g, "");
		if (!/^\d{5,6}$/.test(code)) throw invalidParam(`股票代码无法识别：${raw}`);
		market = marketFromCode(code);
	}

	if (suffix !== "" && suffix !== market) {
		throw invalidParam(`股票代码前后缀矛盾：${raw}（${market} ≠ ${suffix}）`);
	}

	return {
		code,
		market,
		secid: `${market === "SH" ? "1" : "0"}.${code}`,
		tencent: market.toLowerCase() + code,
	};
}

/** Eastmoney datacenter report query (the skill's eastmoney_datacenter). */
export async function eastmoneyDatacenter({
	reportName,
	columns = "ALL",
	filter = "",
	pageSize = 50,
	pageNumber = 1,
	sortColumns = "",
	sortTypes = "-1",
}) {
	const params = new URLSearchParams({
		reportName,
		columns,
		filter,
		pageNumber: String(pageNumber),
		pageSize: String(pageSize),
		sortColumns,
		sortTypes,
		source: "WEB",
		client: "WEB",
	});
	const payload = await fetchJson(`${DATACENTER_URL}?${params.toString()}`, { timeoutMs: 15000 });
	if (payload === null) throw upstreamDown("东财数据中心暂时不可用，请稍后重试", `${reportName}: request failed`);
	if (payload.success === false) {
		const message = String(payload.message ?? "");
		// 东财对"筛选结果为空"也回 success:false —— 这是「确实没有」，不是接口坏了。
		if (/为空|没有数据|no data/i.test(message)) return [];
		throw upstreamDown("东财数据中心返回错误，请稍后重试", `${reportName}: ${message || payload.code || "unknown"}`);
	}
	return Array.isArray(payload?.result?.data) ? payload.result.data : [];
}

/** One page of a push2 clist query; tries mirrors serially (the queue paces). */
export async function push2Clist({ fs, fid, fields, pz = 200, pn = 1, po = 1, fltt = 2 }) {
	const query = new URLSearchParams({
		pn: String(pn),
		pz: String(pz),
		po: String(po),
		np: "1",
		fltt: String(fltt),
		invt: "2",
		fid,
		fs,
		fields,
	});
	let last = "all hosts failed";
	for (const host of PUSH2_HOSTS) {
		const payload = await fetchJson(`${host}/api/qt/clist/get?${query.toString()}`, { timeoutMs: 15000 });
		if (payload === null) {
			last = `${host}: request failed`;
			continue;
		}
		const data = payload.data ?? {};
		const diff = Array.isArray(data.diff) ? data.diff : [];
		if (diff.length > 0 || Number(data.total) === 0) {
			return { rows: diff, total: Number(data.total ?? diff.length) };
		}
		last = `${host}: empty diff`;
	}
	throw upstreamDown("行情接口暂时不可用，请稍后重试", last);
}

/** Trim a description to one line (tool output hygiene). */
export function oneLine(value, max = 120) {
	const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
	return text.length > max ? text.slice(0, max) + "…" : text;
}
