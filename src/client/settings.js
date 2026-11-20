// 韭菜盒子 LeekBox — 客户端 bundle 源码：全局设置弹窗（主题 + 选择 DSH 模型）
// 由 build.mjs 打包进 lib/client.js（npm run build）；不要手改产物。
//
// 面板头部 ⚙️ 打开。模型不再由插件自己配置（不填 API 地址/密钥）：这里只从
// **DSH 已接入的模型**里挑一个，或「跟随 DSH 默认」。列表来自服务端
// `/api/leekbox/analysis/config`（providers）与 `/api/leekbox/analysis/models`（某 provider 的模型）。
import { h, useEffect, useState } from "./react.js";
import { API, api, describeError, getAnalysisConfig, getTheme, saveAnalysisConfig, setTheme } from "./core.js";

/** 主题选项：跟随系统 / 浅色 / 深色。 */
const THEME_OPTIONS = [
	{ key: "system", label: "跟随系统" },
	{ key: "light", label: "浅色" },
	{ key: "dark", label: "深色" },
];

const EMPTY_EFFECTIVE = { provider: "", model: "", reasoningEffort: "", source: "dsh" };

/** 「provider/model」的人类可读串（缺字段用 — 顶替）。 */
function routeLabel(entry) {
	const provider = entry?.provider ?? "";
	const model = entry?.model ?? "";
	if (provider === "" && model === "") return "—";
	return `${provider}/${model}`;
}

export function SettingsDialog({ onClose }) {
	const [theme, setThemeState] = useState(getTheme());
	const [provider, setProvider] = useState("");
	const [model, setModel] = useState("");
	const [models, setModels] = useState([]);
	const [providers, setProviders] = useState([]);
	const [effective, setEffective] = useState(EMPTY_EFFECTIVE);
	const [loadingModels, setLoadingModels] = useState(false);
	const [saving, setSaving] = useState(false);
	const [msg, setMsg] = useState("");

	/** 拉某个 provider 下 DSH 能发现的模型。 */
	const loadModels = (id) => {
		if (id === "") {
			setModels([]);
			return Promise.resolve([]);
		}
		setLoadingModels(true);
		return api(`${API.analysisModels}?provider=${encodeURIComponent(id)}`)
			.then((d) => {
				const list = Array.isArray(d?.models)
					? d.models
							.filter((m) => m && typeof m.id === "string" && m.id !== "")
							.map((m) => ({ id: m.id, name: typeof m.name === "string" && m.name !== "" ? m.name : m.id }))
					: [];
				setModels(list);
				return list;
			})
			.catch((e) => {
				setModels([]);
				setMsg(describeError(e));
				return [];
			})
			.finally(() => setLoadingModels(false));
	};

	// 打开时用全局单例（面板挂载时已拉过一次）初始化；已选 provider 但模型列表为空时补拉。
	useEffect(() => {
		const c = getAnalysisConfig();
		setProviders(Array.isArray(c.providers) ? c.providers : []);
		setEffective(c.effective ?? EMPTY_EFFECTIVE);
		setProvider(c.provider ?? "");
		setModel(c.model ?? "");
		setModels(Array.isArray(c.models) ? c.models : []);
		setMsg("");
		if (typeof c.provider === "string" && c.provider !== "" && (!Array.isArray(c.models) || c.models.length === 0)) {
			void loadModels(c.provider);
		}
		// 只在打开时初始化一次。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// 捕获阶段 ESC 关闭（阻止冒泡到面板自身的 ESC 链：详情窗 → 面板）。
	useEffect(() => {
		const onKey = (e) => {
			if (e.key !== "Escape") return;
			e.stopPropagation();
			e.preventDefault();
			onClose();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [onClose]);

	const onProvider = (id) => {
		setProvider(id);
		setModel("");
		setMsg("");
		loadModels(id).then((list) => {
			// 模型只有一个时直接选中，省一次点击。
			if (list.length === 1) setModel(list[0].id);
		});
	};

	const save = () => {
		if (provider !== "" && model.trim() === "") {
			setMsg("请选择一个模型（或把供应商设为「跟随 DSH 默认」）");
			return;
		}
		setSaving(true);
		setMsg("");
		saveAnalysisConfig({ provider, model: provider === "" ? "" : model.trim() })
			.then((d) => {
				const c = getAnalysisConfig();
				setProviders(Array.isArray(c.providers) ? c.providers : providers);
				setEffective(c.effective ?? EMPTY_EFFECTIVE);
				setModels(Array.isArray(c.models) ? c.models : models);
				setProvider(c.provider ?? "");
				setModel(c.model ?? "");
				if (d?.written === false) {
					setMsg("保存失败：配置未能写入，请重试");
				} else if (d?.configured === false) {
					setMsg("已保存，但 DSH 当前没有可用模型：请先在 DSH 设置里配置模型");
				} else {
					setMsg(provider === "" ? "已改为跟随 DSH 默认模型" : "已保存");
				}
			})
			.catch((e) => setMsg(describeError(e)))
			.finally(() => setSaving(false));
	};

	return h(
		"div",
		{
			className: "lkb_settingsMask",
			onMouseDown: (e) => e.stopPropagation(),
			onClick: (e) => {
				if (e.target === e.currentTarget) onClose();
			},
		},
		h(
			"div",
			{ className: "lkb_settingsBox", role: "dialog", "aria-label": "全局设置" },
			h(
				"div",
				{ className: "lkb-settingsHead" },
				h("span", { className: "lkb-settingsTitle" }, "⚙️ 全局设置"),
				h("button", { className: "lkb_close", title: "关闭", onClick: onClose }, "✕")
			),
			h(
				"div",
				{ className: "lkb-settingsBody" },
				h(
					"div",
					{ className: "lkb-settingsSection" },
					h("div", { className: "lkb-settingsSectionTitle" }, "主题"),
					h(
						"div",
						{ className: "lkb-seg", role: "radiogroup", "aria-label": "主题" },
						THEME_OPTIONS.map((t) =>
							h(
								"button",
								{
									key: t.key,
									type: "button",
									className: "lkb-segBtn",
									"data-active": theme === t.key ? "true" : "false",
									onClick: () => {
										setTheme(t.key);
										setThemeState(t.key);
									},
								},
								t.label
							)
						)
					)
				),
				h("div", { className: "lkb-settingsDivider" }),
				h("div", { className: "lkb-settingsSectionTitle" }, "AI 模型"),
				h(
					"div",
					{ className: "lkb-hint", style: { marginBottom: 10 } },
					"模型来自 DSH 已接入的供应商；插件不保存 API 地址或密钥。要新增模型，请先在 DSH 设置里配置。"
				),
				h(
					"div",
					{ className: "lkb-anField", style: { marginBottom: 10 } },
					h("div", { className: "lkb-anLabel" }, "模型供应商"),
					h(
						"select",
						{ className: "lkb-input", value: provider, onChange: (e) => onProvider(e.target.value) },
						h("option", { value: "" }, `跟随 DSH 默认（${routeLabel(effective)}）`),
						providers.map((p) => h("option", { key: p.id, value: p.id }, p.name))
					)
				),
				provider === ""
					? h(
							"div",
							{ key: "effective", className: "lkb-anField" },
							h("div", { className: "lkb-anLabel" }, "当前生效"),
							h("div", { className: "lkb-status" }, effective.model === "" ? "DSH 还没有可用模型：请先在 DSH 设置里配置" : routeLabel(effective))
						)
					: h(
							"div",
							{ key: "model", className: "lkb-anField" },
							h("div", { className: "lkb-anLabel" }, "模型"),
							models.length > 0
								? h(
										"select",
										{ className: "lkb-input", value: model, onChange: (e) => setModel(e.target.value) },
										h("option", { value: "" }, "请选择模型…"),
										models.map((m) => h("option", { key: m.id, value: m.id }, m.name))
									)
								: h("input", {
										className: "lkb-input",
										value: model,
										onInput: (e) => setModel(e.target.value),
										placeholder: loadingModels ? "正在读取 DSH 模型列表…" : "该供应商未暴露模型列表，可直接输入模型名",
										spellcheck: "false",
									})
						),
				provider !== "" && models.length > 0
					? h("div", { className: "lkb-hint", style: { marginTop: 6 } }, `DSH 在该供应商下发现 ${models.length} 个模型。`)
					: null,
				h(
					"div",
					{ className: "lkb-settingsActions" },
					h("button", { className: "lkb-btn", onClick: save, disabled: saving }, saving ? "保存中…" : "保存"),
					h("button", { className: "lkb-btnGhost", onClick: onClose }, "关闭"),
					msg === "" ? null : h("span", { className: "lkb-status" }, msg)
				)
			)
		)
	);
}
