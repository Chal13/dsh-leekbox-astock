// Agent-facing tool layer: one tool per skill layer + a catalog tool.
//
// The tool descriptions are the "端点能力分类提示": the model routes a user
// request to a layer tool by these keywords, then picks `action` (which is the
// skill's endpoint name) from the enum.
import { CAPABILITIES, LAYERS, capabilitiesOfLayer, capabilityList, runCapability } from "./capabilities.js";
import { toToolError } from "./contract.js";

const MAX_ROWS = 10;

/** Registration diagnostics surfaced by /health and /capabilities. */
export const astockStatus = { registered: false, tools: [], error: "" };

/** Union of the parameters used by a layer's capabilities. */
function parameterSpec(defs) {
	const spec = {
		action: {
			type: "string",
			required: true,
			description: `要查询的端点，可选：${defs.map((d) => d.id).join(" / ")}`,
			enum: defs.map((d) => d.id),
		},
	};
	for (const def of defs) {
		for (const [key, param] of Object.entries(def.params)) {
			if (spec[key] !== undefined) continue;
			spec[key] = {
				type: param.type,
				required: param.required === true,
				description: param.hint ?? `${def.label} 的 ${key}`,
				...(param.enum ? { enum: param.enum } : {}),
			};
		}
	}
	return spec;
}

function layerDescription(layer, defs) {
	const meta = LAYERS[layer];
	return [
		`${meta.label}层（skill §${meta.no}）：${meta.hint}。`,
		`action 取值为 ${defs.map((d) => d.id).join(" / ")}；`,
		"返回表格默认截断为前 10 行，可用 limit 调整（最多 50）；",
		"数据来自公开免费接口，失败会返回明确中文原因。",
	].join("");
}

/** Render a capability result as a compact Markdown block. */
function formatResult(result, limit) {
	const lines = [];
	lines.push(`# ${result.capability}`);
	lines.push(`source: ${result.source} · fetchedAt: ${result.fetchedAt}`);
	const unit = Object.entries(result.unit ?? {});
	if (unit.length > 0) lines.push(`unit: ${unit.map(([k, v]) => `${k}=${v}`).join(", ")}`);

	// Scalar extras worth showing (skip arrays / nested objects / rows).
	for (const [key, value] of Object.entries(result)) {
		if (["capability", "layer", "source", "sourceUrl", "fetchedAt", "unit", "rows", "partial"].includes(key)) continue;
		if (value === null || value === undefined || typeof value === "object") continue;
		if (String(value) === "") continue;
		lines.push(`${key}: ${value}`);
	}
	if (result.note) lines.push(`note: ${result.note}`);
	if (result.partial) lines.push("partial: true（部分数据缺失）");

	const rows = Array.isArray(result.rows) ? result.rows : [];
	if (rows.length === 0) {
		lines.push("");
		lines.push("无数据。");
		return lines.join("\n");
	}

	const columns = [];
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			if (!columns.includes(key)) columns.push(key);
		}
		if (columns.length >= 8) break;
	}
	const shown = rows.slice(0, limit);
	lines.push("");
	lines.push(`| ${columns.join(" | ")} |`);
	lines.push(`| ${columns.map(() => "---").join(" | ")} |`);
	for (const row of shown) {
		lines.push(`| ${columns.map((c) => String(row[c] ?? "")).join(" | ")} |`);
	}
	if (rows.length > shown.length) {
		lines.push("");
		lines.push(`共 ${rows.length} 行，已显示前 ${shown.length} 行；传 limit=50 查看更多。`);
	} else {
		lines.push("");
		lines.push(`共 ${rows.length} 行。`);
	}
	return lines.join("\n");
}

function makeLayerTool(layer, defs) {
	return {
		name: `astock_${layer}`,
		description: layerDescription(layer, defs),
		parameters: parameterSpec(defs),
		async execute(args = {}) {
			const action = String(args.action ?? defs[0]?.id ?? "");
			const def = defs.find((d) => d.id === action);
			if (def === undefined) return `error: 未知的 action「${action}」`;
			const params = {};
			for (const key of Object.keys(def.params)) {
				if (args[key] !== undefined) params[key] = args[key];
			}
			const limit = Math.min(Math.max(Number(args.limit ?? MAX_ROWS) || MAX_ROWS, 1), 50);
			try {
				const result = await runCapability(def.id, params);
				return formatResult(result, limit);
			} catch (error) {
				return `error: ${toToolError(error)}`;
			}
		},
	};
}

const catalogTool = {
	name: "astock_catalog",
	description:
		"列出 a-stock-data 的全部能力分类（层 → 端点 → 参数 → 数据源）。在不确定用哪个 action 时先调用它；不需要参数。",
	parameters: {},
	async execute() {
		const lines = ["# a-stock-data 能力目录", ""];
		for (const [layer, meta] of Object.entries(LAYERS)) {
			const defs = capabilitiesOfLayer(layer);
			if (defs.length === 0) continue;
			lines.push(`## §${meta.no} ${meta.label} — ${meta.hint}`);
			for (const def of defs) {
				const params = Object.entries(def.params)
					.map(([k, v]) => `${k}${v.required ? "*" : ""}`)
					.join(", ");
				lines.push(`- ${def.id}（${def.label}）参数：${params || "无"} · 源：${def.source}`);
			}
			lines.push("");
		}
		lines.push("带 * 的参数必填；code 支持 600519 / SH600519 / 600519.SH。");
		return lines.join("\n");
	},
};

/** All tool definitions this plugin contributes to ctx.tools. */
export function astockTools() {
	const tools = [];
	const layers = [...new Set(CAPABILITIES.map((def) => def.layer))];
	for (const layer of layers) {
		const defs = capabilitiesOfLayer(layer);
		if (defs.length > 0) tools.push(makeLayerTool(layer, defs));
	}
	tools.push(catalogTool);
	return tools;
}

/** Registration diagnostics for /health. */
export function astockToolNames() {
	return astockTools().map((tool) => tool.name);
}

export const __test__ = { formatResult, parameterSpec, capabilityList };
