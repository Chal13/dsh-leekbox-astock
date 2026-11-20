// 韭菜盒子大A版 — 客户端 bundle 源码：插件内对话页
//
// Talks to the host-side chat controller (/api/leekbox/chat*), which owns a DSH
// agent session. Replies are polled from the durable session event log; no SSE
// plumbing and no second chat application is mounted.
import { h, useCallback, useEffect, useRef, useState } from "./react.js";
import { API, api, consumeChatDraft, describeError, onChatDraft } from "./core.js";

/**
 * 对话示例里的「最近一个交易日」。
 *
 * 原来这里写死了 `2026-11-13`，时间一过就变成一条永远指向过去某天的提示。
 * 现在按东八区当前时间算：工作日就用当天，周末回退到最近的周五；法定节假日
 * 仍可能没有榜（服务端会如实说明"该日尚未发布/非交易日"），但至少日期不会过期。
 */
function recentTradingDay() {
	const beijing = new Date(Date.now() + 8 * 60 * 60 * 1000);
	// 用 UTC 读取器避免宿主机时区干扰：上面已经手动加过 8 小时。
	let day = beijing.getUTCDay(); // 0=周日
	while (day === 0 || day === 6) {
		beijing.setUTCDate(beijing.getUTCDate() - 1);
		day = beijing.getUTCDay();
	}
	return beijing.toISOString().slice(0, 10);
}

/** 空态下的示例问题：日期动态生成，避免界面提示停留在过去某天。 */
function chatExamples() {
	return [
		"今天涨停池和炸板率怎么样？",
		`${recentTradingDay()} 全市场龙虎榜，按净买入排序`,
		"茅台最近两融、股东户数和分红",
		"贵州茅台最新研报和一致预期 EPS",
	];
}

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
	const inputRef = useRef(null);
	// 每次渲染重算：面板开着跨过零点时，示例日期也跟着翻页。
	const examples = chatExamples();

	// 行情/选股页的「💬」把股票写进对话草稿：首次进入本页时消费一次，
	// 已打开时通过订阅实时写入输入框，用户可以直接发或再改。
	useEffect(() => {
		const apply = (text) => {
			if (typeof text !== "string" || text === "") return;
			setInput(text);
			// 等 React 把值渲染进 textarea 后再聚焦，并把光标放到末尾。
			setTimeout(() => {
				const node = inputRef.current;
				if (node === null) return;
				node.focus();
				const end = node.value.length;
				try {
					node.setSelectionRange(end, end);
				} catch {}
			}, 0);
		};
		apply(consumeChatDraft());
		return onChatDraft(apply);
	}, []);

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
							examples.map((example) =>
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
				ref: inputRef,
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
