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
	isIdle?: boolean;
	hasPendingMessages?: boolean;
	/** UI 通知同步抛错（测结果回调不阻塞检查点）。 */
	notifyThrows?: boolean;
	/** compact 回调重复调用（测只结算和通知一次）。 */
	compactCallbacksTwice?: boolean;
	/** 挂起 compact 完成，用 releaseCompact() 手控时机（测 inFlight 与阻塞语义）。 */
	compactHoldOpen?: boolean;
	/** compact 同步抛错（测扩展实例失效等异常路径不悬挂）。 */
	compactThrows?: boolean;
	/** compact 异步失败（测安全检查点可重试且不启动 continuation）。 */
	compactFails?: boolean;
}

function makeCtx(cwd: string, options: MockContextOptions) {
	const notifications: string[] = [];
	let compactCalls = 0;
	let compactCompleted = false;
	let releaseCompact: (() => void) | null = null;
	const ctx = {
		cwd,
		hasUI: options.uiAvailable ?? true,
		isIdle: () => options.isIdle ?? true,
		hasPendingMessages: () => options.hasPendingMessages ?? false,
		ui: {
			notify: (message: string) => {
				if (options.notifyThrows) {
					throw new Error("stale UI");
				}
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
		compact: (compactOptions?: { onComplete?: () => void; onError?: (error: Error) => void }) => {
			compactCalls += 1;
			if (options.compactThrows) {
				throw new Error("extension instance stale");
			}
			if (options.compactHoldOpen) {
				releaseCompact = () => {
					compactCompleted = true;
					compactOptions?.onComplete?.();
				};
				return;
			}
			queueMicrotask(() => {
				if (options.compactFails) {
					const error = new Error("compaction failed");
					compactOptions?.onError?.(error);
					if (options.compactCallbacksTwice) {
						compactOptions?.onError?.(error);
					}
					return;
				}
				compactCompleted = true;
				compactOptions?.onComplete?.();
				if (options.compactCallbacksTwice) {
					compactOptions?.onComplete?.();
				}
			});
		},
	} as unknown as ExtensionContext;
	return {
		ctx,
		notifications,
		getCompactCalls: () => compactCalls,
		isCompactCompleted: () => compactCompleted,
		releaseCompact: () => releaseCompact?.(),
	};
}

/** agent_end 事件载荷：messages 只需覆盖"最后一条 assistant 消息"的判断。 */
const agentEndEvent = (stopReason = "toolUse") => ({
	type: "agent_end",
	messages: [{ role: "assistant", stopReason }],
});

const agentSettledEvent = { type: "agent_settled" };
const beforeAgentStartEvent = { type: "before_agent_start", prompt: "hi", systemPrompt: "", systemPromptOptions: {} };

async function setupExtension(cwd: string) {
	const { default: factory } = await import("./index.ts");
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const sentMessages: Array<{ message: unknown; options?: unknown }> = [];
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
			commands.set(name, options);
		},
		sendMessage: (message: unknown, options?: unknown) => {
			sentMessages.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	factory(pi);

	const sessionStart = handlers.get("session_start")!;
	const agentEnd = handlers.get("agent_end")!;
	const agentSettled = handlers.get("agent_settled")!;
	const beforeAgentStart = handlers.get("before_agent_start")!;
	const { ctx, notifications } = makeCtx(cwd, { tokens: 1000, contextWindow: 200_000 });
	await sessionStart({ type: "session_start", reason: "resume" }, ctx);
	return {
		handlers,
		commands,
		ctx,
		notifications,
		sentMessages,
		sessionStart,
		agentEnd,
		agentSettled,
		beforeAgentStart,
	};
}

describe("扩展入口", () => {
	it("注册事件处理器与命令", async () => {
		const cwd = makeCwd(null);
		const { handlers, commands } = await setupExtension(cwd);
		assert.ok(handlers.has("session_start"));
		assert.ok(handlers.has("agent_end"));
		assert.ok(handlers.has("agent_settled"));
		assert.ok(handlers.has("before_agent_start"));
		assert.ok(!handlers.has("agent_start"));
		assert.ok(!handlers.has("turn_end"));
		assert.ok(!handlers.has("context"));
		assert.ok(commands.has("compact-thresholds"));
		assert.ok(commands.has("compact-toggle"));
	});

	it("工具链中途不触发 compact，也不发送 continuation message", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { handlers, sentMessages } = await setupExtension(cwd);
		// 扩展不监听中途事件，完全交给 pi 原生 loop 的 auto-compaction 兜底。
		assert.ok(!handlers.has("agent_start"));
		assert.ok(!handlers.has("turn_end"));
		assert.ok(!handlers.has("context"));
		assert.equal(sentMessages.length, 0);
	});

	it("未配置扩展阈值时不接管（pi 内置阈值最低的场景）", async () => {
		const cwd = makeCwd(null);
		const { agentEnd, agentSettled } = await setupExtension(cwd);
		// 150k < 内置阈值 183616 且未配置扩展阈值 → 无扩展阈值可触发
		const { ctx, getCompactCalls } = makeCtx(cwd, { tokens: 150_000, contextWindow: 200_000 });
		await agentEnd(agentEndEvent(), ctx);
		await agentSettled(agentSettledEvent, ctx);
		assert.equal(getCompactCalls(), 0);
	});

	it("已越过 pi 内置阈值时交给原生处理，扩展不触发", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { agentEnd, agentSettled } = await setupExtension(cwd);
		// 190k > 内置阈值 183616 → 原生 threshold/overflow 机制的全责，扩展不动作
		const { ctx, getCompactCalls } = makeCtx(cwd, { tokens: 190_000, contextWindow: 200_000 });
		await agentEnd(agentEndEvent(), ctx);
		await agentSettled(agentSettledEvent, ctx);
		assert.equal(getCompactCalls(), 0);
	});

	it("配置 usedTokensThreshold 后超过阈值触发 compact", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { agentEnd, agentSettled, sentMessages } = await setupExtension(cwd);
		const { ctx, getCompactCalls, notifications } = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000 });
		await agentEnd(agentEndEvent(), ctx);
		await agentSettled(agentSettledEvent, ctx);
		assert.equal(getCompactCalls(), 1);
		assert.equal(sentMessages.length, 0);
		assert.ok(notifications.some((n) => n.includes("115,000") && n.includes("compact 完成")));
	});

	it("压缩完成前不重复触发（inFlight 期间第二次检查跳过）", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { agentEnd, agentSettled } = await setupExtension(cwd);
		const first = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000, compactHoldOpen: true });
		const second = makeCtx(cwd, { tokens: 116_000, contextWindow: 200_000 });
		await agentEnd(agentEndEvent(), first.ctx);
		const pending = agentSettled(agentSettledEvent, first.ctx);
		await agentSettled(agentSettledEvent, second.ctx);
		assert.equal(first.getCompactCalls(), 1);
		assert.equal(second.getCompactCalls(), 0);
		assert.equal(first.notifications.length, 0, "压缩未完成前不应显示完成提示");
		first.releaseCompact();
		await pending;
		assert.ok(first.isCompactCompleted());
		assert.equal(first.notifications.length, 1, "压缩完成后只显示一次结果提示");
	});

	it("agent_settled 等待压缩完成后才返回（此时调用 compact 不会死锁）", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { agentEnd, agentSettled } = await setupExtension(cwd);
		const { ctx, getCompactCalls, isCompactCompleted } = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000 });
		await agentEnd(agentEndEvent(), ctx);
		await agentSettled(agentSettledEvent, ctx);
		assert.equal(getCompactCalls(), 1);
		assert.ok(isCompactCompleted(), "handler 返回时压缩应已完成");
	});

	it("before_agent_start 等待进行中的压缩完成后再检查放行", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { agentEnd, agentSettled, handlers } = await setupExtension(cwd);
		// run 结束触发压缩并挂起（模拟压缩进行中）
		const running = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000, compactHoldOpen: true });
		await agentEnd(agentEndEvent(), running.ctx);
		const settled = agentSettled(agentSettledEvent, running.ctx);
		// 压缩未完成时用户发送新消息：before_agent_start 被阻塞，不产生第二次压缩
		const sending = makeCtx(cwd, { tokens: 5000, contextWindow: 200_000 });
		let sendReturned = false;
		const send = Promise.resolve(
			handlers.get("before_agent_start")!(beforeAgentStartEvent, sending.ctx),
		).then(() => {
			sendReturned = true;
		});
		await Promise.resolve();
		assert.equal(sendReturned, false, "压缩进行中 before_agent_start 不应放行");
		assert.equal(sending.getCompactCalls(), 0);
		// 压缩完成后放行
		running.releaseCompact();
		await settled;
		await send;
		assert.ok(running.isCompactCompleted());
		assert.equal(running.getCompactCalls(), 1);
	});

	it("before_agent_start 等待压缩完成后才返回（压缩完成后新消息才发出）", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { handlers, sentMessages } = await setupExtension(cwd);
		const { ctx, getCompactCalls, isCompactCompleted } = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000 });
		await handlers.get("before_agent_start")!(beforeAgentStartEvent, ctx);
		assert.equal(getCompactCalls(), 1);
		assert.equal(sentMessages.length, 0);
		assert.ok(isCompactCompleted(), "handler 返回时压缩应已完成");
	});

	it("ctx.compact 同步抛错时不悬挂，且压缩标志复位允许后续触发", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { agentEnd, agentSettled } = await setupExtension(cwd);
		const first = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000, compactThrows: true });
		await agentEnd(agentEndEvent(), first.ctx);
		await agentSettled(agentSettledEvent, first.ctx);
		const second = makeCtx(cwd, { tokens: 116_000, contextWindow: 200_000 });
		await agentEnd(agentEndEvent(), second.ctx);
		await agentSettled(agentSettledEvent, second.ctx);
		assert.equal(first.getCompactCalls(), 1);
		assert.equal(second.getCompactCalls(), 1);
	});

	it("用量未知时不触发", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { agentEnd, agentSettled } = await setupExtension(cwd);
		const { ctx, getCompactCalls } = makeCtx(cwd, { tokens: null });
		await agentEnd(agentEndEvent(), ctx);
		await agentSettled(agentSettledEvent, ctx);
		assert.equal(getCompactCalls(), 0);
	});

	it("用户中断的 run（aborted）跳过压缩，由发送前检查点兜底", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { agentEnd, agentSettled, handlers } = await setupExtension(cwd);
		const { ctx, getCompactCalls } = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000 });
		await agentEnd(agentEndEvent("aborted"), ctx);
		await agentSettled(agentSettledEvent, ctx);
		assert.equal(getCompactCalls(), 0);
		// 用户重发消息时兜底压缩
		await handlers.get("before_agent_start")!(beforeAgentStartEvent, ctx);
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
		await handlers.get("before_agent_start")!(beforeAgentStartEvent, ctx);
		assert.equal(getCompactCalls(), 1);
	});

	it("before_agent_start 时检查并等待 compact（对应原生发送前检查点）", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { handlers } = await setupExtension(cwd);
		const { ctx, getCompactCalls } = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000 });
		await handlers.get("before_agent_start")!(beforeAgentStartEvent, ctx);
		assert.equal(getCompactCalls(), 1);
	});

	it("compact 失败后安全检查点可重试，且不发送 continuation", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { handlers, sentMessages } = await setupExtension(cwd);
		const failed = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000, compactFails: true });
		await handlers.get("before_agent_start")!(beforeAgentStartEvent, failed.ctx);
		assert.equal(failed.getCompactCalls(), 1);
		assert.equal(sentMessages.length, 0);

		const retry = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000 });
		await handlers.get("before_agent_start")!(beforeAgentStartEvent, retry.ctx);
		assert.equal(retry.getCompactCalls(), 1);
		assert.equal(sentMessages.length, 0);
	});

	it("任务仍在运行或有待处理消息时检查点不应触发 compact", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { agentEnd, agentSettled, beforeAgentStart } = await setupExtension(cwd);
		const running = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000, isIdle: false });

		await agentEnd(agentEndEvent(), running.ctx);
		await agentSettled(agentSettledEvent, running.ctx);
		await beforeAgentStart(beforeAgentStartEvent, running.ctx);

		assert.equal(running.getCompactCalls(), 0);
		assert.ok(!running.notifications.some((n) => n.includes("compact")));

		const queued = makeCtx(cwd, { tokens: 116_000, contextWindow: 200_000, hasPendingMessages: true });
		await agentSettled(agentSettledEvent, queued.ctx);
		assert.equal(queued.getCompactCalls(), 0);
	});

	it("compact 失败时不显示成功提示，而是报告失败", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { handlers } = await setupExtension(cwd);
		const failed = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000, compactFails: true });
		await handlers.get("before_agent_start")!(beforeAgentStartEvent, failed.ctx);

		assert.ok(!failed.notifications.some((n) => n.includes("开始 compact")));
		assert.ok(failed.notifications.some((n) => n.includes("compact 失败") && n.includes("compaction failed")));
	});

	it("compact 回调重复时只显示一次并释放 inFlight", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { handlers } = await setupExtension(cwd);
		const first = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000, compactCallbacksTwice: true });
		await handlers.get("before_agent_start")!(beforeAgentStartEvent, first.ctx);
		assert.equal(first.getCompactCalls(), 1);
		assert.equal(first.notifications.length, 1);

		const retry = makeCtx(cwd, { tokens: 116_000, contextWindow: 200_000 });
		await handlers.get("before_agent_start")!(beforeAgentStartEvent, retry.ctx);
		assert.equal(retry.getCompactCalls(), 1, "重复回调不应让 inFlight 永久占用");
	});

	it("结果通知抛错时检查点仍返回且下次可重试", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { handlers } = await setupExtension(cwd);
		const first = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000, notifyThrows: true });
		await assert.doesNotReject(async () => {
			await handlers.get("before_agent_start")!(beforeAgentStartEvent, first.ctx);
		});
		assert.equal(first.getCompactCalls(), 1);

		const retry = makeCtx(cwd, { tokens: 116_000, contextWindow: 200_000 });
		await handlers.get("before_agent_start")!(beforeAgentStartEvent, retry.ctx);
		assert.equal(retry.getCompactCalls(), 1);
	});

	it("无 UI 时 compact 结果通知保持静默", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { handlers } = await setupExtension(cwd);
		const run = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000, uiAvailable: false });
		await handlers.get("before_agent_start")!(beforeAgentStartEvent, run.ctx);
		assert.equal(run.getCompactCalls(), 1);
		assert.equal(run.notifications.length, 0);
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
		const { agentEnd, agentSettled, beforeAgentStart } = await setupExtension(cwd);
		const { ctx, getCompactCalls, notifications } = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000 });
		await agentEnd(agentEndEvent(), ctx);
		await agentSettled(agentSettledEvent, ctx);
		await beforeAgentStart(beforeAgentStartEvent, ctx);
		assert.equal(getCompactCalls(), 0);
		assert.ok(!notifications.some((n) => n.includes("compact")));
	});

	it("compact-toggle args 关闭再开启：写入配置文件并本次会话立即生效", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 110_000 });
		const { commands, agentEnd, agentSettled } = await setupExtension(cwd);
		const toggle = commands.get("compact-toggle")!;
		const { ctx, notifications } = makeCtx(cwd, { tokens: 1000, contextWindow: 200_000 });

		await toggle.handler("used off", ctx);
		assert.ok(notifications.some((n) => n.includes("已关闭") && n.includes("立即生效")));
		const rawOff = readFileSync(join(cwd, ".pi", "better-auto-compact.json"), "utf-8");
		assert.deepEqual(JSON.parse(rawOff), { usedTokensThreshold: 110_000, usedTokensEnabled: false });
		// 关闭立即生效：超过阈值也不触发
		const offRun = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000 });
		await agentEnd(agentEndEvent(), offRun.ctx);
		await agentSettled(agentSettledEvent, offRun.ctx);
		assert.equal(offRun.getCompactCalls(), 0);

		await toggle.handler("used on", ctx);
		assert.ok(notifications.some((n) => n.includes("已开启")));
		const rawOn = readFileSync(join(cwd, ".pi", "better-auto-compact.json"), "utf-8");
		assert.deepEqual(JSON.parse(rawOn), { usedTokensThreshold: 110_000 });
		// 开启立即生效：超过阈值恢复触发
		const onRun = makeCtx(cwd, { tokens: 115_000, contextWindow: 200_000 });
		await agentEnd(agentEndEvent(), onRun.ctx);
		await agentSettled(agentSettledEvent, onRun.ctx);
		assert.equal(onRun.getCompactCalls(), 1);
	});

	it("compact-toggle args 设置数值：写入配置文件并本次会话立即生效", async () => {
		const cwd = makeCwd({ usedTokensThreshold: 150_000 });
		const { commands, agentEnd, agentSettled } = await setupExtension(cwd);
		const toggle = commands.get("compact-toggle")!;
		const { ctx, notifications } = makeCtx(cwd, { tokens: 1000, contextWindow: 200_000 });

		await toggle.handler("used 240000", ctx);
		assert.ok(notifications.some((n) => n.includes("已设为 240,000 tokens") && n.includes("立即生效")));
		assert.deepEqual(JSON.parse(readFileSync(join(cwd, ".pi", "better-auto-compact.json"), "utf-8")), {
			usedTokensThreshold: 240_000,
		});
		// 新值立即生效：160k 超过旧值 150k（会触发），但未到新值 240k，不触发
		const run = makeCtx(cwd, { tokens: 160_000, contextWindow: 200_000 });
		await agentEnd(agentEndEvent(), run.ctx);
		await agentSettled(agentSettledEvent, run.ctx);
		assert.equal(run.getCompactCalls(), 0);
	});

	it("compact-toggle args 设置数值：均未配置时创建项目配置并生效", async () => {
		const cwd = makeCwd(null);
		const { commands, agentEnd, agentSettled } = await setupExtension(cwd);
		const toggle = commands.get("compact-toggle")!;
		const { ctx, notifications } = makeCtx(cwd, { tokens: 1000, contextWindow: 200_000 });

		await toggle.handler("percent 50", ctx);
		assert.ok(notifications.some((n) => n.includes("已设为 50%") && n.includes("立即生效")));
		assert.deepEqual(JSON.parse(readFileSync(join(cwd, ".pi", "better-auto-compact.json"), "utf-8")), { percentThreshold: 50 });
		// 立即生效：120k 超过 50% 阈值（100k），由扩展触发 compact
		const run = makeCtx(cwd, { tokens: 120_000, contextWindow: 200_000 });
		await agentEnd(agentEndEvent(), run.ctx);
		await agentSettled(agentSettledEvent, run.ctx);
		assert.equal(run.getCompactCalls(), 1);
	});

	it("compact-toggle args 设置数值：越界值提示且不改动配置", async () => {
		const cwd = makeCwd({ percentThreshold: 80, usedTokensThreshold: 110_000 });
		const { commands } = await setupExtension(cwd);
		const { ctx, notifications } = makeCtx(cwd, { tokens: 1000, contextWindow: 200_000 });

		await commands.get("compact-toggle")!.handler("percent 150", ctx);
		assert.ok(notifications.some((n) => n.includes("必须是 (0, 100] 内的数字")));
		await commands.get("compact-toggle")!.handler("used 110.5", ctx);
		assert.ok(notifications.some((n) => n.includes("必须是正整数")));
		assert.deepEqual(JSON.parse(readFileSync(join(cwd, ".pi", "better-auto-compact.json"), "utf-8")), {
			percentThreshold: 80,
			usedTokensThreshold: 110_000,
		});
	});

	it("compact-toggle args 设置数值：项目配置根不是对象时报错且不改动文件", async () => {
		const cwd = makeCwd(null);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "better-auto-compact.json"), "[1, 2]");
		const { commands } = await setupExtension(cwd);
		const { ctx, notifications } = makeCtx(cwd, { tokens: 1000, contextWindow: 200_000 });

		await commands.get("compact-toggle")!.handler("used 240000", ctx);
		assert.ok(notifications.some((n) => n.includes("必须是 JSON 对象")));
		assert.equal(readFileSync(join(cwd, ".pi", "better-auto-compact.json"), "utf-8"), "[1, 2]");
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
