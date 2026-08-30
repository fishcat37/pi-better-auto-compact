/**
 * 扩展入口集成冒烟测试：加载真实的 index.ts，mock pi API 与会话上下文，
 * 验证事件注册、阈值触发与命令输出。通过临时 HOME 隔离用户真实配置。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

let homeRoot: string;

before(() => {
	homeRoot = mkdtempSync(join(tmpdir(), "bac-home-"));
	process.env.HOME = homeRoot;
});

after(() => {
	rmSync(homeRoot, { recursive: true, force: true });
});

function makeCwd(withConfig: Record<string, unknown> | null): string {
	const cwd = mkdtempSync(join(tmpdir(), "bac-cwd-"));
	if (withConfig) {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "better-auto-compact.json"), JSON.stringify(withConfig));
	}
	return cwd;
}

interface MockContextOptions {
	tokens: number | null;
	contextWindow?: number;
	percent?: number | null;
	uiAvailable?: boolean;
}

function makeCtx(cwd: string, options: MockContextOptions) {
	const notifications: string[] = [];
	let compactCalls = 0;
	const ctx = {
		cwd,
		hasUI: options.uiAvailable ?? true,
		ui: {
			notify: (message: string) => {
				notifications.push(message);
			},
		},
		getContextUsage: () =>
			options.tokens === null
				? undefined
				: {
						tokens: options.tokens,
						contextWindow: options.contextWindow ?? 200_000,
						percent: options.percent ?? null,
					},
		compact: () => {
			compactCalls += 1;
		},
	} as unknown as ExtensionContext;
	return { ctx, notifications, getCompactCalls: () => compactCalls };
}

async function setupExtension(cwd: string) {
	const { default: factory } = await import("./index.ts");
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
			commands.set(name, options);
		},
	} as unknown as ExtensionAPI;
	factory(pi);

	const sessionStart = handlers.get("session_start")!;
	const turnEnd = handlers.get("turn_end")!;
	const { ctx, notifications, getCompactCalls } = makeCtx(cwd, { tokens: 1000, contextWindow: 200_000 });
	await sessionStart({ type: "session_start", reason: "resume" }, ctx);
	return { handlers, commands, ctx, notifications, getCompactCalls, sessionStart, turnEnd };
}

describe("扩展入口", () => {
	it("注册事件处理器与命令", async () => {
		const cwd = makeCwd(null);
		const { handlers, commands } = await setupExtension(cwd);
		assert.ok(handlers.has("session_start"));
		assert.ok(handlers.has("turn_end"));
		assert.ok(handlers.has("session_compact_failed"));
		assert.ok(commands.has("compact-thresholds"));
	});

	it("未配置扩展阈值时不接管（pi 内置阈值最低的场景）", async () => {
		const cwd = makeCwd(null);
		const { turnEnd, getCompactCalls, ctx } = await setupExtension(cwd);
		// 190k > 内置阈值 183616，但应由 pi 内置触发，扩展不动作
		const { ctx: turnCtx } = makeCtx(cwd, { tokens: 190_000, contextWindow: 200_000 });
		await turnEnd({ type: "turn_end", turnIndex: 0 }, turnCtx);
		await turnEnd({ type: "turn_end", turnIndex: 1 }, ctx);
		assert.equal(getCompactCalls(), 0);
	});

	it("配置 usedTokensThreshold 后超过阈值触发 compact", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { turnEnd } = await setupExtension(cwd);
		const { ctx, getCompactCalls, notifications } = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000 });
		await turnEnd({ type: "turn_end", turnIndex: 0 }, ctx);
		assert.equal(getCompactCalls(), 1);
		assert.ok(notifications.some((n) => n.includes("115,000") && n.includes("compact")));
	});

	it("compact 进行中不重复触发", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { turnEnd } = await setupExtension(cwd);
		const { ctx: ctx1, getCompactCalls: calls1 } = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000 });
		const { ctx: ctx2, getCompactCalls: calls2 } = makeCtx(cwd, { tokens: 116_000, contextWindow: 200_000 });
		await turnEnd({ type: "turn_end", turnIndex: 0 }, ctx1);
		await turnEnd({ type: "turn_end", turnIndex: 1 }, ctx2);
		assert.equal(calls1(), 1);
		assert.equal(calls2(), 0);
	});

	it("用量未知时不触发", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { turnEnd, getCompactCalls } = await setupExtension(cwd);
		const { ctx } = makeCtx(cwd, { tokens: null });
		await turnEnd({ type: "turn_end", turnIndex: 0 }, ctx);
		assert.equal(getCompactCalls(), 0);
	});

	it("session_start 时会话已超限也触发（resume 场景）", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		// 直接调用 session_start，初始 usage 就是 150k
		const { default: factory } = await import("./index.ts");
		const handlers = new Map<string, Handler>();
		factory({
			on: (event: string, handler: Handler) => {
				handlers.set(event, handler);
			},
			registerCommand: () => {},
		} as unknown as ExtensionAPI);
		const { ctx, getCompactCalls } = makeCtx(cwd, { tokens: 150_000, contextWindow: 200_000 });
		await handlers.get("session_start")!({ type: "session_start", reason: "resume" }, ctx);
		assert.equal(getCompactCalls(), 1);
	});

	it("compact-thresholds 命令输出阈值汇总", async () => {
		const cwd = makeCwd({ percentThreshold: 80, usedTokensThreshold: 110_000 });
		const { commands, ctx, notifications } = await setupExtension(cwd);
		await commands.get("compact-thresholds")!.handler("", ctx);
		const output = notifications.join("\n");
		assert.ok(output.includes("参与比较的阈值"));
		assert.ok(output.includes("80% 上下文窗口"));
		assert.ok(output.includes("已用 110,000 tokens"));
		assert.ok(output.includes("剩余 16,384 tokens（pi 内置）"));
		assert.ok(output.includes("← 最低"));
		assert.ok(output.includes("本扩展触发"));
	});

	it("enabled: false 时完全不动作", async () => {
		const cwd = makeCwd({ enabled: false, usedTokensThreshold: 110_000 });
		const { turnEnd, getCompactCalls, notifications } = await setupExtension(cwd);
		const { ctx } = makeCtx(cwd, { tokens: 190_000, contextWindow: 200_000 });
		await turnEnd({ type: "turn_end", turnIndex: 0 }, ctx);
		assert.equal(getCompactCalls(), 0);
		assert.ok(!notifications.some((n) => n.includes("compact")));
	});
});
