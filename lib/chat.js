// 插件内对话：直连宿主 LLM + 插件侧工具循环。
//
// 为什么不用 ctx.agents：实测（v0.20.0-astock.4）宿主 agent 路径的每个请求都会
// 在 2~10 秒被中途 abort（抓到的 abort 栈只有 undici 内部帧），adapter 把这种
// AbortError 包成 `DeepSeek Messages transport failed`，而同一个进程里直连
// `llm.stream`（AI 分析页）可以连续流 100+ 秒不受影响。因此这里改走直连链路：
// 与主窗口同一份模型凭据、不依赖 agent 会话，也顺带把"无需用户填 API Key"落全。
//
// 结构：一个内存 + 落盘的对话记录（items 用于面板渲染），模型侧历史只保留
// 用户/助手文本（不保留工具中间态），工具调用在单轮内由插件自己执行 astock_*。
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { astockTools } from "./astock-tools.js";

const MAX_INPUT = 8000;
const MAX_MESSAGES = 80;
const MAX_HISTORY = 20;
const MAX_TOOL_STEPS = 4;
const MAX_TOKENS = 4096;
const TOOL_RESULT_MAX = 4000;

const SYSTEM_PROMPT = [
	"你是「韭菜盒子」A 股助手，嵌在 DeepSeek Harness 的看盘面板里。",
	"回答用简体中文，直接给结论，再补必要说明；不确定就说不知道，不要编造数据。",
	"你可以调用 astock_* 工具取真实 A 股数据（行情、两融、龙虎榜、涨停池、研报、宏观等）。",
	"需要具体数据时先调用工具，再基于结果作答；工具的日期/代码参数要按当前日期填写。",
	"只做数据解读与风险提示，不给买卖指令，不承诺收益。",
].join("\n");

/** 把 provider 的失败翻成能直接展示的中文。 */
function describeChatError(error) {
	const text = String(error?.message ?? error ?? "");
	if (/transport failed|UND_ERR|fetch failed/i.test(text)) {
		return "模型连接失败：请检查网络/代理，或在 DSH 设置里换一个默认模型";
	}
	if (/no provider\/model|no default model|没有默认模型|未提供 llm/i.test(text)) {
		return "DSH 没有可用的默认模型：请先在 DSH 设置里选一个模型";
	}
	if (/404|status code \(no body\)/i.test(text)) return "模型路由不可用：请在 DSH 设置里换一个默认模型";
	if (/idle timeout/i.test(text)) return "模型响应超时：请稍后重试";
	if (/rate limit|429/i.test(text)) return "模型调用被限流：请稍后重试";
	if (/unauthorized|401|sign in|credential/i.test(text)) return "模型未登录或凭据失效：请在 DSH 设置里重新登录";
	if (/UNSUPPORTED_REASONING_EFFORT/i.test(text)) return "当前模型不支持所选推理档位：请在 DSH 设置里换一档或换模型";
	if (text === "") return "模型调用失败：请稍后重试";
	return `模型调用失败：${text}`;
}

/** 把插件的工具定义转成 llm.stream 需要的 JSON Schema。 */
function toToolSchema(def) {
	const properties = {};
	const required = [];
	for (const [key, param] of Object.entries(def.parameters ?? {})) {
		properties[key] = {
			type: param?.type ?? "string",
			...(typeof param?.description === "string" ? { description: param.description } : {}),
			...(Array.isArray(param?.enum) ? { enum: param.enum } : {}),
		};
		if (param?.required === true) required.push(key);
	}
	return {
		name: def.name,
		description: def.description,
		parameters: { type: "object", properties, ...(required.length > 0 ? { required } : {}) },
	};
}

export function createChat(ctx, { dshHome, logger, selection: pickSelection }) {
	const file = join(dshHome, ".leekbox-chat.json");
	const sessionId = "leekbox-direct";
	let items = [];
	let history = [];
	let seq = 0;
	let busy = false;
	let lastError = "";
	let lastRoute = "";
	let lastEffort = "";

	try {
		if (existsSync(file)) {
			const saved = JSON.parse(readFileSync(file, "utf8"));
			if (Array.isArray(saved?.items)) {
				items = saved.items.filter((it) => isPlainObject(it) && typeof it.text === "string").slice(-MAX_MESSAGES);
				seq = items.reduce((max, it) => (typeof it.seq === "number" && it.seq > max ? it.seq : max), 0);
			}
			if (Array.isArray(saved?.history)) {
				history = saved.history
					.filter((m) => isPlainObject(m) && (m.role === "user" || m.role === "assistant") && typeof m.text === "string")
					.slice(-MAX_HISTORY);
			}
		}
	} catch {
		// 记录损坏就当新对话。
	}

	function save() {
		try {
			const tmp = `${file}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify({ items, history }, null, 2), "utf8");
			renameSync(tmp, file);
		} catch (error) {
			logger?.warn?.(error);
		}
	}

	function isPlainObject(value) {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	/** 宿主当前的模型选择；插件设置里显式挑的优先，没有就回宿主默认。 */
	function selection() {
		const normalize = (sel) => {
			if (
				typeof sel?.provider === "string" &&
				sel.provider !== "" &&
				typeof sel?.model === "string" &&
				sel.model !== ""
			) {
				return {
					provider: sel.provider,
					model: sel.model,
					...(typeof sel.reasoningEffort === "string" && sel.reasoningEffort !== "" ? { reasoningEffort: sel.reasoningEffort } : {}),
				};
			}
			return undefined;
		};
		if (typeof pickSelection === "function") {
			try {
				const picked = normalize(pickSelection());
				if (picked !== undefined) return picked;
			} catch {
				// 配置读取失败就退回宿主默认。
			}
		}
		try {
			return normalize(ctx.get?.("agentDefaultModel")?.currentSelection?.());
		} catch {
			// 服务缺失按"没有默认模型"处理。
		}
		return undefined;
	}

	function llmService() {
		const llm = typeof ctx.get === "function" ? ctx.get("llm") : undefined;
		return llm !== undefined && typeof llm.stream === "function" ? llm : undefined;
	}

	/** 一次流式调用：收集文本与工具调用。 */
	async function streamOnce(llm, sel, messages) {
		const tools = astockTools().map(toToolSchema);
		const options = {
			provider: sel.provider,
			model: sel.model,
			system: SYSTEM_PROMPT,
			messages,
			tools,
			maxTokens: MAX_TOKENS,
			signal: AbortSignal.timeout(180_000),
			...(sel.reasoningEffort === undefined ? {} : { reasoningEffort: sel.reasoningEffort }),
		};
		let text = "";
		const calls = new Map();
		for await (const chunk of llm.stream(options)) {
			if (chunk?.type === "text-delta" && typeof chunk.text === "string") {
				text += chunk.text;
			} else if (chunk?.type === "tool-call-delta" && typeof chunk.id === "string") {
				const prev = calls.get(chunk.id) ?? { id: chunk.id, name: "", arguments: "" };
				if (typeof chunk.name === "string" && chunk.name !== "") prev.name = chunk.name;
				if (typeof chunk.argumentsDelta === "string") prev.arguments += chunk.argumentsDelta;
				calls.set(chunk.id, prev);
			} else if (chunk?.type === "block-end" && chunk.block?.type === "tool-call") {
				calls.set(chunk.block.id, {
					id: chunk.block.id,
					name: chunk.block.name,
					arguments: chunk.block.arguments,
				});
			} else if (chunk?.type === "finish" && chunk.reason?.kind === "error") {
				throw new Error(chunk.reason.failure?.message ?? "模型返回错误");
			}
		}
		return { text, toolCalls: [...calls.values()].filter((call) => call.name !== "") };
	}

	/** 执行一个 astock 工具，返回给模型的文本结果（有界）。 */
	async function runTool(call) {
		const def = astockTools().find((tool) => tool.name === call.name);
		if (def === undefined) return `工具不存在：${call.name}`;
		let args = {};
		try {
			args = call.arguments === "" ? {} : JSON.parse(call.arguments);
		} catch {
			return `参数不是合法 JSON：${String(call.arguments).slice(0, 200)}`;
		}
		try {
			const result = await def.execute(args);
			const text = String(result ?? "");
			return text.length > TOOL_RESULT_MAX ? `${text.slice(0, TOOL_RESULT_MAX)}\n…（已截断）` : text;
		} catch (error) {
			return `工具执行失败：${error instanceof Error ? error.message : String(error)}`;
		}
	}

	/** 一轮对话：可能包含多次工具调用，最终落一条 assistant 文本。 */
	async function runTurn(userText) {
		busy = true;
		lastError = "";
		try {
			const llm = llmService();
			if (llm === undefined) throw new Error("DSH 未提供 llm 服务，无法使用内置模型");
			const sel = selection();
			if (sel === undefined) throw new Error("DSH 没有默认模型");
			lastRoute = `${sel.provider}/${sel.model}`;
			lastEffort = sel.reasoningEffort ?? "";

			const working = [
				...history.map((m) => ({ role: m.role, content: [{ type: "text", text: m.text }] })),
				{ role: "user", content: [{ type: "text", text: userText }] },
			];
			let answer = "";
			for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
				const { text, toolCalls } = await streamOnce(llm, sel, working);
				if (text !== "") answer = text;
				if (toolCalls.length === 0) break;
				const blocks = [];
				if (text !== "") blocks.push({ type: "text", text });
				for (const call of toolCalls) {
					blocks.push({ type: "tool-call", id: call.id, name: call.name, arguments: call.arguments });
				}
				working.push({
					role: "assistant",
					id: randomUUID(),
					source: { kind: "model", provider: sel.provider, model: sel.model },
					content: blocks,
				});
				for (const call of toolCalls) {
					const result = await runTool(call);
					working.push({
						role: "tool",
						id: randomUUID(),
						source: { kind: "tool", callId: call.id },
						toolCallId: call.id,
						content: [{ type: "text", text: result }],
						isError: false,
					});
				}
			}
			if (answer === "") answer = "（模型没有返回文本）";
			seq += 1;
			items.push({ seq, role: "assistant", text: answer, time: Date.now() });
			if (items.length > MAX_MESSAGES) items = items.slice(-MAX_MESSAGES);
			history = [...history, { role: "user", text: userText }, { role: "assistant", text: answer }].slice(-MAX_HISTORY);
			save();
		} catch (error) {
			lastError = describeChatError(error);
			logger?.warn?.(error);
		} finally {
			busy = false;
		}
	}

	/** 发一条消息：立刻返回，回复异步写入 items（面板轮询）。
	 *
	 * 用 setTimeout 甩出 HTTP 请求上下文：避免 turn 与本次请求生命周期绑定。 */
	async function send(text) {
		const value = String(text ?? "").trim();
		if (value === "") throw new Error("消息不能为空");
		if (value.length > MAX_INPUT) throw new Error(`消息过长（上限 ${MAX_INPUT} 字）`);
		if (busy) throw new Error("上一条消息还在处理，请稍候再发");
		if (llmService() === undefined) throw new Error("DSH 未提供 llm 服务，插件内对话不可用");
		seq += 1;
		const beforeSeq = seq - 1;
		items.push({ seq, role: "user", text: value, time: Date.now() });
		if (items.length > MAX_MESSAGES) items = items.slice(-MAX_MESSAGES);
		save();
		setTimeout(() => {
			void runTurn(value);
		}, 0);
		return { sessionId, beforeSeq, route: lastRoute };
	}

	function snapshot(since = -1) {
		return {
			sessionId,
			ready: llmService() !== undefined && selection() !== undefined,
			busy,
			pendingTools: [],
			error: lastError,
			lastSeq: seq,
			items: items.filter((item) => typeof item.seq === "number" && item.seq > since),
		};
	}

	async function reset() {
		items = [];
		history = [];
		seq = 0;
		lastError = "";
		save();
		return { sessionId };
	}

	function status() {
		return {
			ready: llmService() !== undefined && selection() !== undefined,
			sessionId,
			busy,
			route: lastRoute,
			effort: lastEffort,
			lastError,
		};
	}

	function dispose() {
		// 无长期持有的宿主句柄：没有需要释放的资源。
	}

	return { send, snapshot, reset, status, dispose };
}
