// Response contract shared by every a-stock capability.
//
// 沿用两边的语义约定：
//   - 用户可见文案必须是中文（message），技术细节只进 detail/reason；
//   - 「确实没有数据」(not_published) 与「接口坏了」(upstream_down) 必须分开；
//   - 单位写进响应（元 / 手 / 股），避免前端再次猜。
//
// CapabilityError 会被路由与 agent 工具共用：路由按 status 输出 JSON，
// 工具按 code 决定是正常空结果还是报错。

export class CapabilityError extends Error {
	constructor(code, message, detail = "", status = 502) {
		super(message);
		this.name = "CapabilityError";
		this.code = code;
		this.detail = detail;
		this.status = status;
	}
}

export function invalidParam(message, detail = "") {
	return new CapabilityError("invalid_param", message, detail, 400);
}

export function upstreamDown(message, detail = "") {
	return new CapabilityError("upstream_down", message, detail, 502);
}

export function rateLimited(message, detail = "") {
	return new CapabilityError("rate_limited", message, detail, 429);
}

/** 该交易日/该窗口确实没有发布数据 —— 不是故障。 */
export function notPublished(message, detail = "") {
	return new CapabilityError("not_published", message, detail, 200);
}

/**
 * 成功响应体。
 * @param {object} input
 * @param {string} input.capability 能力 id
 * @param {string} input.layer     skill 层（signal / capital / limitup / event / macro / research）
 * @param {string} input.source    上游名
 * @param {string} [input.sourceUrl]
 * @param {object} [input.unit]
 * @param {Array}  input.rows
 * @param {boolean} [input.partial]
 */
export function ok({ capability, layer, source, sourceUrl, unit, rows, partial = false, extra = {} }) {
	return {
		capability,
		layer,
		source,
		sourceUrl: sourceUrl ?? "",
		fetchedAt: new Date().toISOString(),
		unit: unit ?? {},
		partial,
		rows,
		...extra,
	};
}

/** 把 CapabilityError 转成路由响应；未知异常按 502 兜底。 */
export function toHttp(error, fallback = "数据获取失败，请稍后重试") {
	if (error instanceof CapabilityError) {
		return {
			status: error.status,
			body: {
				error: error.message,
				code: error.code,
				...(error.detail ? { reason: error.detail } : {}),
				...(error.code === "not_published" ? { rows: [] } : {}),
			},
		};
	}
	return { status: 502, body: { error: fallback, code: "upstream_down" } };
}

/** 工具侧：把错误压成一行中文（模型能直接转述）。 */
export function toToolError(error) {
	const message = error instanceof Error ? error.message : String(error);
	return /[\u4e00-\u9fa5]/.test(message) ? message : "数据获取失败，请稍后重试";
}
