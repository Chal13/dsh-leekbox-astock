// Layer 2 — 研报层 (skill §2.1–§2.4).
import { fetchText, fetchJson, decodeGbk } from "../fetch-utils.js";
import { invalidParam, notPublished, ok, upstreamDown } from "../contract.js";
import { normTicker, oneLine } from "./util.js";

const REPORT_API = "https://reportapi.eastmoney.com/report/list";

/** 个股研报（§2.1）：评级 + 三年 EPS 预测。 */
export async function eastmoneyReports({ code, maxPages = 1 } = {}) {
	const t = normTicker(code);
	const records = [];
	let totalPage = 1;
	for (let page = 1; page <= Math.min(Math.max(maxPages, 1), 5); page++) {
		const params = new URLSearchParams({
			industryCode: "*",
			pageSize: "100",
			industry: "*",
			rating: "*",
			ratingChange: "*",
			beginTime: "2000-01-01",
			endTime: "2030-01-01",
			pageNo: String(page),
			fields: "",
			qType: "0",
			orgCode: "",
			code: t.code,
			rcode: "",
			p: String(page),
			pageNum: String(page),
			pageNumber: String(page),
		});
		const payload = await fetchJson(`${REPORT_API}?${params}`, {
			timeoutMs: 30000,
			headers: { referer: "https://data.eastmoney.com/" },
		});
		if (payload === null) throw upstreamDown("研报接口暂时不可用，请稍后重试");
		const rows = Array.isArray(payload.data) ? payload.data : [];
		if (rows.length === 0) break;
		records.push(...rows);
		totalPage = Number(payload.TotalPage ?? 1) || 1;
		if (page >= totalPage) break;
	}
	if (records.length === 0) {
		if (/^(43|83|87)/.test(t.code)) {
			throw invalidParam(`${t.code} 属北交所老号段，东财研报库已不再按老码索引；请改用 920xxx 代码`);
		}
		return ok({
			capability: "eastmoney_reports",
			layer: "research",
			source: "eastmoney-reportapi",
			sourceUrl: REPORT_API,
			unit: { eps: "元/股" },
			rows: [],
			extra: { code: t.code, note: "东财没有该标的的研报覆盖" },
		});
	}
	const rows = records.map((r) => ({
		date: String(r.publishDate ?? "").slice(0, 10),
		title: oneLine(r.title, 80),
		org: r.orgSName ?? "",
		rating: r.emRatingName ?? "",
		industry: r.indvInduName ?? "",
		eps_this_year: r.predictThisYearEps ?? null,
		eps_next_year: r.predictNextYearEps ?? null,
		eps_next_two_year: r.predictNextTwoYearEps ?? null,
		info_code: r.infoCode ?? "",
	}));
	return ok({
		capability: "eastmoney_reports",
		layer: "research",
		source: "eastmoney-reportapi",
		sourceUrl: REPORT_API,
		unit: { eps: "元/股" },
		rows,
		extra: { code: t.code, total: rows.length },
	});
}

/** 行业研报（§2.1，qType=1）。 */
export async function eastmoneyIndustryReports({ industryCode = "*", maxPages = 1, begin = "" } = {}) {
	const beginTime = begin || new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10);
	const records = [];
	let totalPage = 1;
	for (let page = 1; page <= Math.min(Math.max(maxPages, 1), 5); page++) {
		const params = new URLSearchParams({
			industryCode,
			pageSize: "100",
			industry: "*",
			rating: "*",
			ratingChange: "*",
			beginTime,
			endTime: "2030-01-01",
			pageNo: String(page),
			fields: "",
			qType: "1",
		});
		const payload = await fetchJson(`${REPORT_API}?${params}`, {
			timeoutMs: 30000,
			headers: { referer: "https://data.eastmoney.com/" },
		});
		if (payload === null) throw upstreamDown("行业研报接口暂时不可用，请稍后重试");
		const rows = Array.isArray(payload.data) ? payload.data : [];
		if (rows.length === 0) break;
		records.push(...rows);
		totalPage = Number(payload.TotalPage ?? 1) || 1;
		if (page >= totalPage) break;
	}
	const rows = records.map((r) => ({
		date: String(r.publishDate ?? "").slice(0, 10),
		title: oneLine(r.title, 80),
		industry: r.industryName ?? "",
		industry_code: r.industryCode ?? "",
		org: r.orgSName ?? "",
		rating: r.emRatingName ?? "",
		report_type: r.reportType ?? "",
		pages: r.attachPages ?? null,
		info_code: r.infoCode ?? "",
	}));
	return ok({
		capability: "eastmoney_industry_reports",
		layer: "research",
		source: "eastmoney-reportapi",
		sourceUrl: REPORT_API,
		unit: {},
		rows,
		extra: { industry_code: industryCode, begin: beginTime, total: rows.length },
	});
}

/** 同花顺一致预期 EPS（§2.2）：解析 HTML 表格。 */
export async function thsEpsForecast({ code } = {}) {
	const t = normTicker(code);
	const url = `https://basic.10jqka.com.cn/new/${t.code}/worth.html`;
	const buffer = await fetchText(url, {
		timeoutMs: 15000,
		headers: { referer: "https://basic.10jqka.com.cn/" },
	});
	if (buffer === null) throw upstreamDown("同花顺一致预期接口暂时不可用，请稍后重试");
	const html = decodeGbk(buffer);
	if (!html.includes("每股收益") && !html.includes("均值")) {
		throw notPublished(`${t.code} 没有一致预期 EPS 数据（可能机构覆盖不足）`);
	}
	// 找到含「每股收益」/「均值」的第一个表格，解析成行对象。
	const table = html.match(/<table[^>]*>[\s\S]*?<\/table>/gi)?.find((block) => block.includes("每股收益") || block.includes("均值"));
	if (!table) throw upstreamDown("同花顺页面结构变化（找不到 EPS 表格）");
	const rowBlocks = table.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
	const cellsOf = (block) =>
		(block.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) ?? []).map((cell) =>
			cell
				.replace(/<[^>]+>/g, "")
				.replace(/&nbsp;/g, " ")
				.replace(/\s+/g, " ")
				.trim()
		);
	const header = cellsOf(rowBlocks[0] ?? "");
	const rows = rowBlocks
		.slice(1)
		.map(cellsOf)
		.filter((cells) => cells.length >= 2)
		.map((cells) => {
			const row = {};
			header.forEach((key, index) => {
				row[key || `col${index}`] = cells[index] ?? "";
			});
			return row;
		});
	return ok({
		capability: "ths_eps_forecast",
		layer: "research",
		source: "10jqka-basic",
		sourceUrl: url,
		unit: { eps: "元/股" },
		rows,
		extra: { code: t.code, columns: header },
	});
}

let lastSinaReportAt = 0;

/** 新浪研报列表（§2.4）：研报第二来源，无评级。 */
export async function sinaResearchReports({ code = null, page = 1 } = {}) {
	const pageNo = Number(page);
	if (!Number.isInteger(pageNo) || pageNo < 1) throw invalidParam("page 从 1 开始");
	let url;
	let params;
	if (code === null) {
		url = "https://vip.stock.finance.sina.com.cn/q/go.php/vReport_List/kind/lastest/index.phtml";
		params = new URLSearchParams({ p: String(pageNo) });
	} else {
		const t = normTicker(code);
		const symbol = t.market === "BJ" ? "bj" + t.code : t.code;
		url = "https://vip.stock.finance.sina.com.cn/q/go.php/vReport_List/kind/search/index.phtml";
		params = new URLSearchParams({ symbol, t1: "all", p: String(pageNo) });
	}

	// 新浪对连续请求返回假空页；非测试模式强制 6 秒最小间隔（请求前等）。
	if (process.env.LEEKBOX_TEST !== "1") {
		const wait = 6000 - (Date.now() - lastSinaReportAt);
		if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
		lastSinaReportAt = Date.now();
	}

	const buffer = await fetchText(`${url}?${params}`, {
		timeoutMs: 20000,
		headers: { referer: "https://finance.sina.com.cn/" },
	});
	if (buffer === null) throw upstreamDown("新浪研报页面暂时不可用，请稍后重试");
	const html = decodeGbk(buffer);
	if (!html.includes("tb_01") || !html.includes("研究员")) {
		throw upstreamDown("新浪研报页面结构变化（找不到研报表格）");
	}
	const rows = [];
	const rowBlocks = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
	const strip = (fragment) =>
		fragment
			.replace(/<[^>]+>/g, "")
			.replace(/&nbsp;/g, " ")
			.replace(/&amp;/g, "&")
			.replace(/\s+/g, " ")
			.trim();
	for (const block of rowBlocks) {
		const link = block.match(/<a[^>]*title="([^"]*)"[^>]*href="([^"]*?\/rptid\/(\d+)\/[^"]*)"/i);
		if (!link) continue;
		const href = link[2].startsWith("//") ? "https:" + link[2] : link[2];
		const cells = (block.match(/<td[^>]*>[\s\S]*?<\/td>/gi) ?? []).map(strip);
		rows.push({
			date: cells[3] ?? "",
			title: link[1],
			type: cells[2] ?? "",
			org: cells[4] ?? "",
			author: cells[5] ?? "",
			report_id: link[3],
			url: href,
		});
	}
	const numbered = (html.match(/<tr[^>]*>\s*<td>\d+<\/td>/gi) ?? []).length;
	if (rows.length !== numbered && !(rows.length === 0 && html.includes("没有找到相关内容"))) {
		throw upstreamDown("新浪研报表格行结构与解析结果不一致", `${numbered} rows / ${rows.length} parsed`);
	}
	// 新浪对连续请求返回假空页；非测试模式强制 6 秒最小间隔。
	return ok({
		capability: "sina_research_reports",
		layer: "research",
		source: "sina",
		sourceUrl: url,
		unit: {},
		rows,
		extra: { code: code ?? "全市场", page: pageNo, total: rows.length },
	});
}
