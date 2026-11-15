// Layer 11 — 宏观与利率（Node 侧：PMI / LPR / 宏观日历）。
// 需要 Excel/复杂文件解析的三个端点在 python/astock_sidecar.py。
import { fetchText, fetchJson } from "../fetch-utils.js";
import { invalidParam, notPublished, ok, upstreamDown } from "../contract.js";
import { eastmoneyDatacenter } from "./util.js";
import { callSidecar } from "./sidecar.js";

const decodeUtf8 = (buffer) => (buffer === null ? "" : buffer.toString("utf8"));

function stripHtml(html) {
	return html
		.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");
}

/** 国家统计局 PMI（§11.2）。 */
export async function nbsPmi() {
	const indexHtml = decodeUtf8(
		await fetchText("https://www.stats.gov.cn/sj/zxfb/", { timeoutMs: 30000 })
	);
	if (indexHtml === "") throw upstreamDown("国家统计局页面暂时不可用，请稍后重试");
	const links = [...indexHtml.matchAll(/<a[^>]+href="([^"]+)"[^>]*>\s*([^<]{6,80}?)\s*<\/a>/g)];
	const hit = links.find(([, , title]) => title.includes("采购经理指数"));
	if (hit === undefined) throw upstreamDown("国家统计局发布页未找到「采购经理指数」条目");
	const href = hit[1];
	const url = href.startsWith("http") ? href : "https://www.stats.gov.cn/sj/zxfb/" + href.replace(/^\.?\//, "");
	const html = decodeUtf8(await fetchText(url, { timeoutMs: 30000 }));
	if (html === "") throw upstreamDown("PMI 正文页暂时不可用，请稍后重试");
	// 全角括号内可能带空格：把空白整个删掉再匹配。
	const text = stripHtml(html).replace(/[\s\u3000\xa0]+/g, "");
	const grab = (pattern) => {
		const m = text.match(pattern);
		return m ? Number(m[1]) : null;
	};
	const periodMatch = text.match(/(\d{4})年(\d{1,2})月/);
	const result = {
		period: periodMatch ? `${periodMatch[1]}-${String(Number(periodMatch[2])).padStart(2, "0")}` : null,
		manufacturing_pmi: grab(/(?<!非)制造业采购经理指数（PMI）为([\d.]+)%/),
		non_manufacturing_pmi: grab(/非制造业商务活动指数为([\d.]+)%/),
		composite_pmi: grab(/综合PMI产出指数为([\d.]+)%/),
		pmi_large: null,
		pmi_medium: null,
		pmi_small: null,
		source_url: url,
	};
	const combined = text.match(/大、中、小型企业PMI分别为([\d.]+)%、([\d.]+)%和([\d.]+)%/);
	if (combined) {
		[result.pmi_large, result.pmi_medium, result.pmi_small] = combined.slice(1, 4).map(Number);
	} else {
		const midSmall = text.match(/中、小型企业PMI分别为([\d.]+)%和([\d.]+)%/);
		if (midSmall) {
			result.pmi_medium = Number(midSmall[1]);
			result.pmi_small = Number(midSmall[2]);
		}
		const large = text.match(/大型企业PMI为([\d.]+)%/);
		if (large) result.pmi_large = Number(large[1]);
	}
	const missing = ["manufacturing_pmi", "non_manufacturing_pmi", "composite_pmi"].filter((k) => result[k] === null);
	if (missing.length > 0) {
		throw upstreamDown("PMI 正文措辞可能已变更，无法解析核心指标", `${missing.join(",")} @ ${url}`);
	}
	return ok({
		capability: "nbs_pmi",
		layer: "macro",
		source: "stats.gov.cn",
		sourceUrl: url,
		unit: { manufacturing_pmi: "", non_manufacturing_pmi: "", composite_pmi: "" },
		rows: [result],
		extra: { period: result.period },
	});
}

/** LPR 全历史（§11.5，东财数据中心）。 */
export async function lprHistory() {
	const data = await eastmoneyDatacenter({
		reportName: "RPTA_WEB_RATE",
		columns: "TRADE_DATE,LPR1Y,LPR5Y",
		filter: "",
		pageSize: 5000,
		sortColumns: "TRADE_DATE",
		sortTypes: "1",
	});
	const rows = data
		.filter((r) => r.LPR1Y !== null && r.LPR1Y !== undefined)
		.map((r) => ({
			date: String(r.TRADE_DATE ?? "").slice(0, 10),
			lpr_1y: Number(r.LPR1Y),
			lpr_5y: r.LPR5Y === null || r.LPR5Y === undefined ? null : Number(r.LPR5Y),
		}));
	if (rows.length === 0) throw upstreamDown("东财 LPR 报表里没有数据", "RPTA_WEB_RATE empty");
	return ok({
		capability: "lpr_history",
		layer: "macro",
		source: "eastmoney-datacenter",
		sourceUrl: "https://datacenter-web.eastmoney.com",
		unit: { lpr_1y: "%", lpr_5y: "%" },
		rows,
		extra: { total: rows.length, note: "2019-08 前为旧机制逐日 1 年期 LPR，5 年期为空" },
	});
}

/** 全球宏观日历（§11.6，华尔街见闻），按 7 天切片。 */export async function macroCalendar({ start, end = "", country = "", minImportance = 1 } = {}) {
	if (!start) throw invalidParam("缺少参数 start（YYYY-MM-DD）");
	const dayMs = 86400000;
	const first = new Date(`${start}T00:00:00+08:00`);
	const last = end ? new Date(`${end}T00:00:00+08:00`) : new Date(first.getTime() + 6 * dayMs);
	if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) throw invalidParam("start/end 需为 YYYY-MM-DD");
	if (first > last || (last - first) / dayMs > 91) throw invalidParam("区间需满足 start ≤ end 且不超过 92 天");
	const minLevel = Number(minImportance);
	if (![1, 2, 3, 4].includes(minLevel)) throw invalidParam("minImportance 只能是 1–4");

	const byId = new Map();
	const today = new Date();
	for (let cursor = new Date(first); cursor <= last; cursor = new Date(cursor.getTime() + 7 * dayMs)) {
		const stop = new Date(Math.min(cursor.getTime() + 6 * dayMs, last.getTime()));
		const beginSec = Math.floor(cursor.getTime() / 1000);
		const endSec = Math.floor((stop.getTime() + dayMs - 1000) / 1000);
		const payload = await fetchJson(
			`https://api-one-wscn.awtmt.com/apiv1/finance/macrodatas?start=${beginSec}&end=${endSec}`,
			{ timeoutMs: 20000 }
		);
		if (payload === null || payload.code !== 20000) {
			throw upstreamDown("华尔街见闻宏观日历返回错误", String(payload?.message ?? "code != 20000"));
		}
		const items = payload?.data?.items;
		if (!Array.isArray(items)) throw upstreamDown("华尔街见闻宏观日历结构变化", "missing data.items");
		if (items.length === 0 && stop - cursor === 6 * dayMs && cursor <= today) {
			throw upstreamDown("华尔街见闻整周 0 条，接口可能改了", `${cursor.toISOString().slice(0, 10)}`);
		}
		for (const item of items) {
			const stamp = item.public_date;
			if (item.id === undefined || typeof stamp !== "number") {
				throw upstreamDown("华尔街见闻日历条目缺 id 或时间戳", JSON.stringify(item.id));
			}
			const whenAbs = new Date(stamp * 1000);
			if (whenAbs < cursor || whenAbs > new Date(stop.getTime() + dayMs)) continue;
			const when = new Date(stamp * 1000 + 8 * 3600_000);
			const level = item.importance;
			if (![1, 2, 3, 4].includes(level)) {
				throw upstreamDown("华尔街见闻日历 importance 超出 1–4", String(level));
			}
			if (byId.has(item.id)) continue;
			byId.set(item.id, {
				time: when.toISOString().slice(0, 16).replace("T", " "),
				country: item.country,
				title: item.title,
				kind: { FD: "data", FE: "event" }[item.calendar_type] ?? item.calendar_type,
				importance: level,
				actual: item.actual === "" ? null : item.actual,
				forecast: item.forecast === "" ? null : item.forecast,
				previous: item.previous === "" ? null : item.previous,
				revised: item.revised === "" ? null : item.revised,
				unit: item.unit || null,
				period: item.period || null,
			});
		}
	}
	let rows = [...byId.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
	if (rows.length === 0) throw notPublished("该区间没有宏观日历条目（单日/周末/较远未来可能确实没有）");
	if (country) rows = rows.filter((row) => row.country === country);
	rows = rows.filter((row) => row.importance >= minLevel);
	if (rows.length === 0) throw notPublished(`该区间有条目，但 country=${country} / minImportance=${minLevel} 筛完为空`);
	return ok({
		capability: "macro_calendar",
		layer: "macro",
		source: "wallstreetcn",
		sourceUrl: "https://api-one-wscn.awtmt.com",
		unit: {},
		rows,
		extra: { start, end: end || last.toISOString().slice(0, 10), total: rows.length },
	});
}

// ---- Python sidecar endpoints (xls / HTML-table / CSV parsing) ----

function sidecarResult(capability, source, unit, response, extra = {}) {
	return ok({
		capability,
		layer: "macro",
		source,
		sourceUrl: "python-sidecar",
		unit,
		rows: response.rows ?? [],
		extra: { ...(response.meta ?? {}), ...extra, total: (response.rows ?? []).length },
	});
}

/** 人民银行社融（§11.1）：xls 三级跳，仅 2021 年起。 */
export async function pbocSocialFinancing({ year = null } = {}) {
	const response = await callSidecar("pboc_social_financing", {
		year: year === null || year === "" ? null : Number(year),
	});
	return sidecarResult("pboc_social_financing", "pbc", { afre_total: "亿元" }, response, {
		note: "仅支持 2021 年起；未发布月份不会出现在结果里",
	});
}

/** 中债收益率曲线（§11.3）。单位 %。 */
export async function chinabondYieldCurve({ start, end = "", curve = "all" } = {}) {
	if (!start) throw invalidParam("缺少参数 start（YYYY-MM-DD）");
	const response = await callSidecar("chinabond_yield_curve", {
		start,
		end: end || null,
		curve,
	});
	return sidecarResult("chinabond_yield_curve", "chinabond", { "3m": "%", "10y": "%" }, response);
}

/** 回购定盘利率（§11.4）。单位 %。 */
export async function repoFixingRates({ kind = "FR" } = {}) {
	const response = await callSidecar("repo_fixing_rates", { kind: String(kind).toUpperCase() });
	return sidecarResult("repo_fixing_rates", "chinamoney", { rates: "%" }, response);
}
