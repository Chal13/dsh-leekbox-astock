// Lazy Python sidecar client (JSON lines over stdio).
//
// Only three capabilities use it: PBC social financing (xls three-hop),
// Chinabond yield curves (HTML tables), ChinaMoney repo fixing (CSV). Everything
// else stays in Node. The child starts on first use, is killed on dispose, and
// is restarted automatically if it dies.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../python/astock_sidecar.py", import.meta.url));
const PYTHON = process.env.LEEKBOX_PYTHON || "python";
const CALL_TIMEOUT_MS = 90_000;

/** @type {import("node:child_process").ChildProcessWithoutNullStreams | null} */
let child = null;
let buffer = "";
let seq = 0;
/** @type {Map<number, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
const pending = new Map();
let lastError = "";

function ensureChild() {
	if (child !== null) return child;
	if (process.env.LEEKBOX_TEST === "1") {
		throw new Error("Python 边车在测试模式下不启动");
	}
	const proc = spawn(PYTHON, ["-X", "utf8", SCRIPT], {
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
	child = proc;
	buffer = "";
	lastError = "";
	proc.stdout.setEncoding("utf8");
	proc.stdout.on("data", (chunk) => {
		buffer += chunk;
		let cut;
		while ((cut = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, cut).trim();
			buffer = buffer.slice(cut + 1);
			if (line === "") continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			const waiter = pending.get(message.id);
			if (waiter === undefined) continue;
			pending.delete(message.id);
			clearTimeout(waiter.timer);
			if (message.ok) waiter.resolve(message);
			else waiter.reject(Object.assign(new Error(message.error || "边车执行失败"), { detail: message.detail }));
		}
	});
	proc.stderr.setEncoding("utf8");
	proc.stderr.on("data", (chunk) => {
		lastError = String(chunk).trim().slice(0, 500);
	});
	proc.on("error", (error) => {
		lastError = error instanceof Error ? error.message : String(error);
		failAll(new Error(`Python 边车启动失败：${lastError}`));
		child = null;
	});
	proc.on("exit", (code) => {
		child = null;
		failAll(new Error(`Python 边车已退出（code=${code}）${lastError ? "：" + lastError : ""}`));
	});
	return proc;
}

function failAll(error) {
	for (const [, waiter] of pending) {
		clearTimeout(waiter.timer);
		waiter.reject(error);
	}
	pending.clear();
}

/** Run one sidecar op and resolve its JSON response. */
export function callSidecar(op, args = {}) {
	const proc = ensureChild();
	const id = ++seq;
	const line = JSON.stringify({ id, op, args }) + "\n";
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`Python 边车执行超时（${op}）`));
		}, CALL_TIMEOUT_MS);
		pending.set(id, { resolve, reject, timer });
		try {
			proc.stdin.write(line);
		} catch (error) {
			clearTimeout(timer);
			pending.delete(id);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

export function sidecarStatus() {
	return {
		running: child !== null,
		pending: pending.size,
		lastError,
		python: PYTHON,
	};
}

export function disposeSidecar() {
	const proc = child;
	child = null;
	if (proc !== null) {
		try {
			proc.kill();
		} catch {}
	}
	failAll(new Error("Python 边车已关闭"));
}
