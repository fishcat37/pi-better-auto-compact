/**
 * 扩展入口集成冒烟测试：加载真实的 index.ts，mock pi API 与会话上下文，
 * 验证事件注册、阈值触发与命令输出。通过临时 HOME 隔离用户真实配置。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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

/** agent_end 事件载荷：messages 只需覆盖"最后一条 assistant 消息"的判断。 */
const agentEndEvent = (stopReason = "toolUse") => ({
	type: "agent_end",
	messages: [{ role: "assistant", stopReason }],
});

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
	const agentEnd = handlers.get("agent_end")!;
	const { ctx, notifications, getCompactCalls } = makeCtx(cwd, { tokens: 1000, contextWindow: 200_000 });
	await sessionStart({ type: "session_start", reason: "resume" }, ctx);
	return { handlers, commands, ctx, notifications, getCompactCalls, sessionStart, agentEnd };
}

describe("扩展入口", () => {
	it("注册事件处理器与命令", async () => {
		const cwd = makeCwd(null);
		const { handlers, commands } = await setupExtension(cwd);
		assert.ok(handlers.has("session_start"));
		assert.ok(handlers.has("agent_end"));
		assert.ok(handlers.has("before_agent_start"));
		assert.ok(handlers.has("session_compact_failed"));
		assert.ok(commands.has("compact-thresholds"));
		assert.ok(commands.has("compact-toggle"));
	});

	it("未配置扩展阈值时不接管（pi 内置阈值最低的场景）", async () => {
		const cwd = makeCwd(null);
		const { agentEnd, getCompactCalls } = await setupExtension(cwd);
		// 150k < 内置阈值 183616 且未配置扩展阈值 → 无扩展阈值可触发
		const { ctx } = makeCtx(cwd, { tokens: 150_000, contextWindow: 200_000 });
		await agentEnd(agentEndEvent(), ctx);
		assert.equal(getCompactCalls(), 0);
	});

	it("已越过 pi 内置阈值时交给原生处理，扩展不触发", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { agentEnd, getCompactCalls } = await setupExtension(cwd);
		// 190k > 内置阈值 183616 → 原生 threshold/overflow 机制的全责，扩展不动作
		const { ctx } = makeCtx(cwd, { tokens: 190_000, contextWindow: 200_000 });
		await agentEnd(agentEndEvent(), ctx);
		assert.equal(getCompactCalls(), 0);
	});

	it("配置 usedTokensThreshold 后超过阈值触发 compact", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { agentEnd } = await setupExtension(cwd);
		const { ctx, getCompactCalls, notifications } = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000 });
		await agentEnd(agentEndEvent(), ctx);
		assert.equal(getCompactCalls(), 1);
		assert.ok(notifications.some((n) => n.includes("115,000") && n.includes("compact")));
	});

	it("compact 进行中不重复触发", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { agentEnd } = await setupExtension(cwd);
		const { ctx: ctx1, getCompactCalls: calls1 } = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000 });
		const { ctx: ctx2, getCompactCalls: calls2 } = makeCtx(cwd, { tokens: 116_000, contextWindow: 200_000 });
		await agentEnd(agentEndEvent(), ctx1);
		await agentEnd(agentEndEvent(), ctx2);
		assert.equal(calls1(), 1);
		assert.equal(calls2(), 0);
	});

	it("用量未知时不触发", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { agentEnd, getCompactCalls } = await setupExtension(cwd);
		const { ctx } = makeCtx(cwd, { tokens: null });
		await agentEnd(agentEndEvent(), ctx);
		assert.equal(getCompactCalls(), 0);
	});

	it("用户中断的 run（aborted）跳过压缩，由发送前检查点兜底", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { handlers } = await setupExtension(cwd);
		const { ctx, getCompactCalls } = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000 });
		await handlers.get("agent_end")!(agentEndEvent("aborted"), ctx);
		assert.equal(getCompactCalls(), 0);
		// 用户重发消息时兜底压缩
		await handlers.get("before_agent_start")!({ type: "before_agent_start", prompt: "hi", systemPrompt: "", systemPromptOptions: {} }, ctx);
		assert.equal(getCompactCalls(), 1);
	});

	it("session_start 不主动触发，与原生一致（resume 后等发送前检查点）", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { default: factory } = await import("./index.ts");
		const handlers = new Map<string, Handler>();
		factory({
			on: (event: string, handler: Handler) => {
				handlers.set(event, handler);
			},
			registerCommand: () => {},
		} as unknown as ExtensionAPI);
		// resume 到已超限会话（150k）：session_start 不压缩，发消息时才检查
		const { ctx, getCompactCalls } = makeCtx(cwd, { tokens: 150_000, contextWindow: 200_000 });
		await handlers.get("session_start")!({ type: "session_start", reason: "resume" }, ctx);
		assert.equal(getCompactCalls(), 0);
		await handlers.get("before_agent_start")!({ type: "before_agent_start", prompt: "hi", systemPrompt: "", systemPromptOptions: {} }, ctx);
		assert.equal(getCompactCalls(), 1);
	});

	it("before_agent_start 时检查，失败遗留的超限立即重试（对应原生发送前检查点）", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { handlers } = await setupExtension(cwd);
		const { ctx, getCompactCalls } = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000 });
		await handlers.get("before_agent_start")!({ type: "before_agent_start", prompt: "hi", systemPrompt: "", systemPromptOptions: {} }, ctx);
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
		const { agentEnd, getCompactCalls, notifications } = await setupExtension(cwd);
		const { ctx } = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000 });
		await agentEnd(agentEndEvent(), ctx);
		assert.equal(getCompactCalls(), 0);
		assert.ok(!notifications.some((n) => n.includes("compact")));
	});

	it("compact-toggle args 关闭再开启：写入配置文件并本次会话立即生效", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { commands, agentEnd } = await setupExtension(cwd);
		const toggle = commands.get("compact-toggle")!;
		const { ctx, notifications } = makeCtx(cwd, { tokens: 1000, contextWindow: 200_000 });

		await toggle.handler("used off", ctx);
		assert.ok(notifications.some((n) => n.includes("已关闭") && n.includes("立即生效")));
		const rawOff = readFileSync(join(cwd, ".pi", "better-auto-compact.json"), "utf-8");
		assert.deepEqual(JSON.parse(rawOff), { usedTokensThreshold: 110_000, usedTokensEnabled: false });
		// 关闭立即生效：超过阈值也不触发
		const offRun = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000 });
		await agentEnd(agentEndEvent(), offRun.ctx);
		assert.equal(offRun.getCompactCalls(), 0);

		await toggle.handler("used on", ctx);
		assert.ok(notifications.some((n) => n.includes("已开启")));
		const rawOn = readFileSync(join(cwd, ".pi", "better-auto-compact.json"), "utf-8");
		assert.deepEqual(JSON.parse(rawOn), { usedTokensThreshold: 110_000 });
		// 开启立即生效：超过阈值恢复触发
		const onRun = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000 });
		await agentEnd(agentEndEvent(), onRun.ctx);
		assert.equal(onRun.getCompactCalls(), 1);
	});

	it("compact-toggle 非法参数提示用法，不改动配置", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { commands } = await setupExtension(cwd);
		const { ctx, notifications } = makeCtx(cwd, { tokens: 1000, contextWindow: 200_000 });
		await commands.get("compact-toggle")!.handler("what off", ctx);
		assert.ok(notifications.some((n) => n.includes("无法识别")));
		assert.deepEqual(
			JSON.parse(readFileSync(join(cwd, ".pi", "better-auto-compact.json"), "utf-8")),
			{ usedTokensThreshold: 110_000 },
		);
	});

	it("无 UI 且无参数时提示参数形式", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { commands } = await setupExtension(cwd);
		const { ctx, notifications } = makeCtx(cwd, { tokens: 1000, contextWindow: 200_000, uiAvailable: false });
		await commands.get("compact-toggle")!.handler("", ctx);
		assert.ok(notifications.some((n) => n.includes("无交互界面")));
	});

	it("compact-thresholds 显示被开关禁用的阈值", async () => {
		const cwd = makeCwd({ percentThreshold: 80, percentEnabled: false, usedTokensThreshold: 110_000 });
		const { commands, ctx, notifications } = await setupExtension(cwd);
		await commands.get("compact-thresholds")!.handler("", ctx);
		const output = notifications.join("\n");
		assert.ok(output.includes("已禁用"));
		assert.ok(output.includes("percentEnabled: false"));
		assert.ok(output.includes("已用 110,000 tokens"));
		assert.ok(!output.includes("80% 上下文窗口"));
	});
});
