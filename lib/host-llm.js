// 用宿主（DSH）自己接入的模型做一次性补全。
//
// 为什么需要它：插件的「AI 个股分析」原来要求用户自己填第三方 API Key，而 DSH
// 本身已经登录/配置了模型。这里直接走宿主的 `llm` 服务（与主窗口对话同一条链路、
// 同一份凭据），插件不再保存任何密钥，也不再向第三方发请求。
//
// 说明：
// - 路由取 `agentDefaultModel.currentSelection()`（provider/model/effort）。
// - effort 缺省时显式给 "low"：DeepSeek account 路由上 effort=high 会断连
//   （见 chat.js 的实测记录）；若模型不支持该档位，自动去掉 effort 重试一次。
// - 只向前端暴露中文文案，构造细节留给服务端日志。

/** 把流式 chunk 拼成人能看的中文错误。 */
function finishFailureText(failure) {
	const code = String(failure?.code ?? "");
	if (/TRANSPORT/i.test(code)) return "DSH 内置模型连接失败（传输层）：请检查网络/代理，或在 DSH 设置里换一个默认模型";
	if (/ACCOUNT_SIGN_IN|UNAUTHORIZED/i.test(code)) return "DSH 还没有登录模型账号：请在 DSH 设置里登录后重试";
	if (/RATE_LIMIT/i.test(code)) return "DSH 内置模型被限流：请稍后重试";
	if (/TIMEOUT|IDLE/i.test(code)) return "DSH 内置模型响应超时：请稍后重试";
	const detail = String(failure?.message ?? "");
	return detail === "" ? "DSH 内置模型调用失败：请稍后重试" : `DSH 内置模型调用失败：${detail}`;
}

export function createHostLlm(ctx, { selection: pickSelection } = {}) {
	const getLlm = () => (typeof ctx.get === "function" ? ctx.get("llm") : undefined);

	/** 规范成 { provider, model, reasoningEffort? }；缺字段返回 undefined。 */
	function normalize(sel) {
		if (
			typeof sel?.provider === "string" &&
			sel.provider !== "" &&
			typeof sel?.model === "string" &&
			sel.model !== ""
		) {
			const out = { provider: sel.provider, model: sel.model };
			if (typeof sel.reasoningEffort === "string" && sel.reasoningEffort !== "") {
				out.reasoningEffort = sel.reasoningEffort;
			}
			return out;
		}
		return undefined;
	}

	/** 宿主当前选中的模型选择；没有就返回 undefined。 */
	function selection() {
		// 插件设置里显式挑的 provider/model 优先（「跟随 DSH 默认」时回调返回 undefined）。
		if (typeof pickSelection === "function") {
			try {
				const picked = normalize(pickSelection());
				if (picked !== undefined) return picked;
			} catch {
				// 配置读取失败就退回宿主默认。
			}
		}
		try {
			const sel = ctx.get?.("agentDefaultModel")?.currentSelection?.();
			return normalize(sel);
		} catch {
			// 服务缺失/配置非法都按"没有默认模型"处理，由调用方给出中文提示。
		}
		return undefined;
	}

	function available() {
		const llm = getLlm();
		return llm !== undefined && typeof llm.stream === "function" && selection() !== undefined;
	}

	/** /analysis/config 用：告诉前端"内置模型可用吗、跑的是哪个模型、来源是哪"。 */
	function describe() {
		const sel = selection();
		const llm = getLlm();
		let source = "dsh";
		if (typeof pickSelection === "function") {
			try {
				if (normalize(pickSelection()) !== undefined) source = "plugin";
			} catch {
				// 读配置失败按宿主默认算。
			}
		}
		return {
			available: llm !== undefined && typeof llm.stream === "function" && sel !== undefined,
			source,
			provider: sel?.provider ?? "",
			model: sel?.model ?? "",
			reasoningEffort: sel?.reasoningEffort ?? "",
		};
	}

	/**
	 * 流式取一次补全的文本增量。
	 * @param {{system?: string, messages: Array<{role: string, content: string}>, signal?: AbortSignal, maxTokens?: number, temperature?: number}} request
	 */
	async function* streamText(request) {
		const llm = getLlm();
		if (llm === undefined || typeof llm.stream !== "function") {
			throw new Error("DSH 未提供 llm 服务，无法使用内置模型");
		}
		const sel = selection();
		if (sel === undefined) {
			throw new Error("DSH 没有可用模型：请先在 DSH 设置里选择模型，或在本插件设置里指定一个已接入的模型");
		}
		const base = {
			provider: sel.provider,
			model: sel.model,
			messages: request.messages,
			...(request.system === undefined ? {} : { system: request.system }),
			...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
			...(request.temperature === undefined ? {} : { temperature: request.temperature }),
			...(request.signal === undefined ? {} : { signal: request.signal }),
		};

		// 第一档：宿主选择里的 effort；没有就用 low（high 在 account 路由上会断连）。
		// 模型不认这个档位时（UNSUPPORTED_REASONING_EFFORT）去掉重试一次。
		const attempts = [];
		const preferred = sel.reasoningEffort ?? "low";
		attempts.push({ ...base, reasoningEffort: preferred });
		attempts.push({ ...base });

		let lastError;
		for (const options of attempts) {
			let emitted = false;
			try {
				for await (const chunk of llm.stream(options)) {
					if (chunk?.type === "text-delta" && typeof chunk.text === "string") {
						emitted = true;
						yield chunk.text;
					} else if (chunk?.type === "finish" && chunk.reason?.kind === "error") {
						throw Object.assign(new Error(finishFailureText(chunk.reason.failure)), {
							llmFailure: chunk.reason.failure,
						});
					}
				}
				return;
			} catch (error) {
				lastError = error;
				const message = error instanceof Error ? error.message : String(error);
				// 已经吐出内容就不能重试：重试会让前端看到重复的半截分析。
				if (emitted) throw error;
				if (!/UNSUPPORTED_REASONING_EFFORT|unsupported reasoning effort/i.test(message)) throw error;
			}
		}
		throw lastError instanceof Error ? lastError : new Error("DSH 内置模型调用失败：请稍后重试");
	}

	return { available, describe, selection, streamText };
}
