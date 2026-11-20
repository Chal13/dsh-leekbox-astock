// DSH 模型目录桥：把宿主「已接入的 provider / model」列表和默认选择暴露给插件设置页。
//
// 插件不再自己保存 API Key / BaseURL（那是重复建设）。设置页只让用户从 DSH 已有的
// 模型里挑一个（或「跟随 DSH 默认」），实际请求仍然走 host-llm.js 的直连链路。
//
// 数据来源（均为宿主 llm 服务）：
// - listProviders() → [{ id, name }]
// - listModels(provider) → [{ provider, id, name, ... }]（adapter 未实现发现时为 []）
// - agentDefaultModel.currentSelection() → { provider, model, reasoningEffort? }

export function createModelCatalog(ctx) {
	const llmOf = () => (typeof ctx.get === "function" ? ctx.get("llm") : undefined);

	/** 宿主当前已接入的 provider 列表。 */
	function providers() {
		const llm = llmOf();
		if (llm === undefined || typeof llm.listProviders !== "function") return [];
		try {
			return llm
				.listProviders()
				.map((p) => ({ id: String(p?.id ?? ""), name: String(p?.name ?? p?.id ?? "") }))
				.filter((p) => p.id !== "");
		} catch {
			return [];
		}
	}

	/** 某个 provider 下 adapter 能发现的模型；拿不到就返回空数组（前端退化为手填）。 */
	async function models(provider) {
		if (typeof provider !== "string" || provider === "") return [];
		const llm = llmOf();
		if (llm === undefined || typeof llm.listModels !== "function") return [];
		try {
			const list = await llm.listModels(provider);
			return (list ?? [])
				.map((m) => ({ id: String(m?.id ?? ""), name: String(m?.name ?? m?.id ?? "") }))
				.filter((m) => m.id !== "");
		} catch {
			return [];
		}
	}

	/** 宿主默认模型选择（没有就 undefined）。 */
	function defaultSelection() {
		try {
			const sel = ctx.get?.("agentDefaultModel")?.currentSelection?.();
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
		} catch {
			// 服务缺失/配置非法都按"没有默认模型"处理。
		}
		return undefined;
	}

	return { providers, models, defaultSelection };
}
