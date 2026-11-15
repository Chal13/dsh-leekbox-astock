// In-plugin conversation: a DSH agent session owned by this plugin.
//
// Why host-side: the web panel cannot create sessions by itself, but the host
// plugin runs inside the DSH process and can use ctx.agents (the same service the
// WeChat bridge uses). One persisted session id keeps the conversation across
// restarts; replies are read from the durable session event log by polling, so
// no SSE/streaming plumbing is needed.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_INPUT = 8000;
const MAX_MESSAGES = 80;

function messageText(message) {
	const blocks = message?.content;
	if (!Array.isArray(blocks)) return "";
	let out = "";
	for (const block of blocks) {
		if (block?.type === "text" && typeof block.text === "string") out += block.text;
	}
	return out;
}

function streamText(stream) {
	if (!Array.isArray(stream)) return "";
	let out = "";
	for (const entry of stream) {
		if (entry?.type === "text-chunks" && Array.isArray(entry.texts)) out += entry.texts.join("");
		else if (entry?.type === "chunk" && entry.chunk?.type === "text-delta" && typeof entry.chunk.text === "string") {
			out += entry.chunk.text;
		}
	}
	return out;
}

const maxSeq = (events) => {
	let seq = -1;
	for (const event of events) {
		if (typeof event?.seq === "number" && event.seq > seq) seq = event.seq;
	}
	return seq;
};

export function createChat(ctx, { dshHome, logger }) {
	const file = join(dshHome, ".leekbox-chat.json");
	let handle = null;
	let sessionId = "";
	let lastError = "";
	let lastRoute = "";

	try {
		if (existsSync(file)) {
			const saved = JSON.parse(readFileSync(file, "utf8"));
			if (typeof saved?.sessionId === "string" && /^[0-9a-zA-Z-]{8,64}$/.test(saved.sessionId)) {
				sessionId = saved.sessionId;
			}
		}
	} catch {
		// A corrupt state file just means a fresh conversation.
	}

	function save() {
		try {
			const tmp = `${file}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify({ sessionId }, null, 2), "utf8");
			renameSync(tmp, file);
		} catch (error) {
			logger?.warn?.(error);
		}
	}

	async function defaultRoute() {
		try {
			const defaults = ctx.get?.("agentDefaultModel");
			const selection = defaults?.currentSelection?.();
			if (typeof selection?.provider === "string" && typeof selection?.model === "string") {
				return { provider: selection.provider, model: selection.model };
			}
		} catch {
			// fall through
		}
		return undefined;
	}

	async function composeSetup() {
		const presets = ctx.get?.("agentPresets");
		let presetId;
		if (typeof presets?.resolve === "function") {
			try {
				presetId = (await presets.resolve(undefined))?.id;
			} catch {
				presetId = undefined;
			}
		}
		const route = await defaultRoute();
		const setup = async (agentCtx) => {
			if (presetId !== undefined && typeof presets?.mount === "function") {
				await presets.mount(agentCtx, presetId);
			}
			if (route !== undefined) {
				try {
					const mod = await import("@deepseek-ai/dsh-agent");
					mod.installModelSelection?.(agentCtx, { current: route, assembled: undefined });
				} catch {
					// The route is still applied through agentOptions below.
				}
			}
		};
		return { route, setup };
	}

	async function ensureAgent() {
		if (handle !== null) return handle;
		const agents = ctx.get?.("agents");
		if (agents === undefined || typeof agents.create !== "function") {
			throw new Error("当前 DSH 未提供 agents 服务，插件内对话不可用（请升级 DSH 或改用主窗口会话）");
		}
		if (sessionId === "") {
			sessionId = randomUUID();
			save();
		}
		const { route, setup } = await composeSetup();
		const agentOptions = route === undefined ? undefined : { provider: route.provider, model: route.model };
		lastRoute = route === undefined ? "default" : `${route.provider}/${route.model}`;
		try {
			if (typeof agents.resume === "function") {
				handle = await agents.resume({
					resumeSessionId: sessionId,
					...(agentOptions === undefined ? {} : { agentOptions }),
					setup,
					signal: AbortSignal.timeout(30000),
				});
			} else {
				throw new Error("resume unavailable");
			}
		} catch {
			handle = await agents.create({
				sessionId,
				...(agentOptions === undefined ? {} : { agentOptions }),
				setup,
				signal: AbortSignal.timeout(30000),
			});
		}
		try {
			handle.agent.inbox?.clear?.();
		} catch {}
		lastError = "";
		return handle;
	}

	async function send(text) {
		const value = String(text ?? "").trim();
		if (value === "") throw new Error("消息不能为空");
		if (value.length > MAX_INPUT) throw new Error(`消息过长（上限 ${MAX_INPUT} 字）`);
		const current = await ensureAgent();
		const before = maxSeq(current.agent.session?.snapshotEvents?.() ?? []);
		current.agent.followup({
			content: [{ type: "text", text: value }],
			source: { kind: "user" },
		});
		return { sessionId, beforeSeq: before, route: lastRoute };
	}

	function snapshot(since = -1) {
		const events = handle?.agent?.session?.snapshotEvents?.() ?? [];
		const items = [];
		let busy = false;
		let error = "";
		const pending = new Set();
		for (const event of events) {
			const seq = typeof event?.seq === "number" ? event.seq : -1;
			switch (event?.type) {
				case "turn/start":
					busy = true;
					error = "";
					pending.clear();
					break;
				case "turn/end":
					busy = false;
					if (event.data?.reason?.kind === "error") {
						const message = event.data.reason.error?.message;
						error = typeof message === "string" && message !== "" ? message : "模型调用失败";
						lastError = error;
					}
					break;
				case "tool/call": {
					const name = typeof event.data?.name === "string" ? event.data.name : "tool";
					pending.add(name);
					break;
				}
				case "tool/result":
					break;
				case "user/message": {
					const text = messageText(event.data?.message);
					if (text !== "" && seq > since) items.push({ seq, role: "user", text, time: event.time ?? null });
					break;
				}
				case "assistant/message": {
					const text = streamText(event.data?.stream) || messageText(event.data?.message);
					if (text !== "" && seq > since) items.push({ seq, role: "assistant", text, time: event.time ?? null });
					break;
				}
				default:
					break;
			}
		}
		if (items.length > MAX_MESSAGES) items.splice(0, items.length - MAX_MESSAGES);
		return {
			sessionId,
			ready: handle !== null,
			busy,
			pendingTools: [...pending].slice(0, 3),
			error,
			lastSeq: maxSeq(events),
			items,
		};
	}

	async function reset() {
		const old = handle;
		handle = null;
		if (old !== null) {
			try {
				await old.dispose();
			} catch (error) {
				logger?.warn?.(error);
			}
		}
		sessionId = randomUUID();
		save();
		lastError = "";
		return { sessionId };
	}

	function status() {
		return {
			ready: handle !== null,
			sessionId,
			busy: Boolean(snapshot(-1).busy),
			route: lastRoute,
			lastError,
		};
	}

	function dispose() {
		const old = handle;
		handle = null;
		if (old !== null) {
			try {
				old.dispose?.()?.catch?.(() => {});
			} catch {}
		}
	}

	return { send, snapshot, reset, status, dispose };
}
