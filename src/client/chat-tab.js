// 韭菜盒子大A版 — 客户端 bundle 源码：插件内对话页
//
// Talks to the host-side chat controller (/api/leekbox/chat*), which owns a DSH
// agent session. Replies are polled from the durable session event log; no SSE
// plumbing and no second chat application is mounted.
import { h, useCallback, useEffect, useRef, useState } from "./react.js";
import { API, api, describeError } from "./core.js";

const EXAMPLES = [
	"今天涨停池和炸板率怎么样？",
	"茅台最近两融、股东户数和分红",
	"2026-11-13 全市场龙虎榜，按净买入排序",
	"贵州茅台最新研报和一致预期 EPS",
];

export function ChatTab({ active = true }) {
	const [messages, setMessages] = useState([]);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [pending, setPending] = useState([]);
	const [error, setError] = useState("");
	const [sending, setSending] = useState(false);
	const [ready, setReady] = useState(false);
	const sinceRef = useRef(-1);
	const listRef = useRef(null);

	const poll = useCallback(async () => {
		try {
			const data = await api(`${API.chatPoll}?since=${sinceRef.current}`);
			setReady(data.ready === true);
			setBusy(data.busy === true);
			setPending(Array.isArray(data.pendingTools) ? data.pendingTools : []);
			setError(typeof data.error === "string" ? data.error : "");
			const items = Array.isArray(data.items) ? data.items : [];
			if (items.length > 0) {
				setMessages((prev) => {
					const seen = new Set(prev.map((m) => m.seq));
					const next = prev.concat(items.filter((m) => !seen.has(m.seq)));
					return next.length > 200 ? next.slice(next.length - 200) : next;
				});
				for (const item of items) {
					if (typeof item.seq === "number" && item.seq > sinceRef.current) sinceRef.current = item.seq;
				}
			} else if (typeof data.lastSeq === "number" && data.lastSeq > sinceRef.current && data.busy !== true) {
				sinceRef.current = data.lastSeq;
			}
		} catch {
			// A transient poll failure must not spam the transcript.
		}
	}, []);

	useEffect(() => {
		if (!active) return undefined;
		poll();
		const timer = setInterval(poll, 1200);
		return () => clearInterval(timer);
	}, [active, poll]);

	useEffect(() => {
		const node = listRef.current;
		if (node !== null) node.scrollTop = node.scrollHeight;
	}, [messages, pending, busy]);

	const send = async () => {
		const text = input.trim();
		if (text === "" || sending) return;
		setSending(true);
		setError("");
		setInput("");
		try {
			await api(API.chat, { method: "POST", body: { text } });
			await poll();
		} catch (err) {
			setError(describeError(err));
		} finally {
			setSending(false);
		}
	};

	const reset = async () => {
		try {
			await api(API.chatReset, { method: "POST", body: {} });
			setMessages([]);
			setError("");
			sinceRef.current = -1;
			await poll();
		} catch (err) {
			setError(describeError(err));
		}
	};

	const onKeyDown = (e) => {
		if (e.key !== "Enter" || e.shiftKey || e.nativeEvent?.isComposing) return;
		e.preventDefault();
		send();
	};

	const statusText = busy ? `思考中${pending.length > 0 ? " · " + pending.join(", ") : ""}` : ready ? "就绪" : "尚未开始";

	return h(
		"div",
		{ className: "lkb_chat" },
		h(
			"div",
			{ className: "lkb_chatBar" },
			h("span", { className: "lkb_chatStatus", "data-busy": busy ? "true" : "false" }, statusText),
			h("button", { className: "lkb-btnGhost", onClick: reset, title: "结束当前对话并新开一个会话" }, "新对话")
		),
		h(
			"div",
			{ className: "lkb_chatList", ref: listRef },
			messages.length === 0
				? h(
						"div",
						{ className: "lkb_chatEmpty" },
						h("div", { className: "lkb_chatEmptyTitle" }, "在插件里直接问 A 股"),
						h("div", { className: "lkb_chatEmptyHint" }, "对话由 DSH Agent 执行，已挂载龙虎榜、两融、涨停池、研报、宏观等能力。"),
						h(
							"div",
							{ className: "lkb_chatExamples" },
							EXAMPLES.map((example) =>
								h(
									"button",
									{ key: example, className: "lkb_chatExample", onClick: () => setInput(example) },
									example
								)
							)
						)
					)
				: messages.map((message) =>
						h(
							"div",
							{ key: message.seq, className: "lkb_chatRow", "data-role": message.role },
							h("div", { className: "lkb_chatBubble" }, String(message.text ?? ""))
						)
					),
			busy ? h("div", { className: "lkb_chatPending" }, pending.length > 0 ? `正在执行：${pending.join(", ")}` : "正在思考…") : null,
			error !== "" ? h("div", { className: "lkb_chatError" }, error) : null
		),
		h(
			"div",
			{ className: "lkb_chatComposer" },
			h("textarea", {
				className: "lkb_chatInput",
				value: input,
				placeholder: "问点什么，例如「今天涨停池和炸板率」",
				rows: 2,
				onChange: (e) => setInput(e.target.value),
				onKeyDown,
			}),
			h(
				"button",
				{ className: "lkb_chatSend", onClick: send, disabled: sending || input.trim() === "" },
				sending ? "发送中" : "发送"
			)
		)
	);
}
