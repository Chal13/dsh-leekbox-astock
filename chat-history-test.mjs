// 回归：对话历史 → llm.stream 消息的转换必须给 assistant 消息带上 source。
//
// 背景（2026-11-21 线上报错）：历史里的 assistant 原来只转成 { role, content }，
// DSH 的 LlmRuntime.forAdapter() 会读 message.source.replayState →
// `Cannot read properties of undefined (reading 'replayState')`，整轮对话失败。
import assert from "node:assert";
import { historyMessages } from "./lib/chat.js";

const selection = { provider: "deepseek-account", model: "deepseek-flash" };
const history = [
	{ role: "user", text: "茅台最近两融怎么样" },
	{ role: "assistant", text: "融资余额 145 亿，环比下降" },
	{ role: "user", text: "那股东户数呢" },
];
const messages = historyMessages(history, selection);

assert.strictEqual(messages.length, 3, "每条历史都要保留");

const user = messages[0];
assert.strictEqual(user.role, "user");
assert.ok(!Object.hasOwn(user, "source"), "user 消息保持精简形态");
assert.deepStrictEqual(user.content, [{ type: "text", text: history[0].text }]);

const assistant = messages[1];
assert.strictEqual(assistant.role, "assistant");
assert.ok(assistant.source, "assistant 必须带 source（否则 forAdapter 会读 undefined.replayState）");
assert.strictEqual(assistant.source.kind, "model");
assert.strictEqual(assistant.source.provider, selection.provider);
assert.strictEqual(assistant.source.model, selection.model);
assert.strictEqual(typeof assistant.id, "string");
assert.ok(assistant.id.length > 8, "assistant 必须带稳定 id");
assert.deepStrictEqual(assistant.content, [{ type: "text", text: history[1].text }]);

// 模拟 DSH 的访问路径：不能抛。
for (const message of messages) {
	if (message.role === "assistant") assert.strictEqual(message.source.replayState, undefined);
}

// 空历史也要能处理。
assert.deepStrictEqual(historyMessages([], selection), []);

console.log("✅ 对话历史消息转换全部通过（assistant 带 source/id）");
