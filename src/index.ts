/**
 * better-auto-compact：pi 的 auto-compact 补充阈值扩展。
 *
 * 在 pi 内置"剩余 token 阈值"（compaction.reserveTokens）之外，补充两种
 * 阈值方式，并让所有阈值取最低者（最先到达者）触发 compact：
 *
 * - percentThreshold：已用上下文达到模型上下文窗口的百分之多少
 * - usedTokensThreshold：已用上下文超过固定值（如 110000）
 *
 * 内置阈值由 pi 自身处理；本扩展只在存在严格更低的阈值时接管，
 * 在与原生相同的两处检查点（每轮 turn 结束后、发送新消息前）检查用量
 * 并调用 ctx.compact()。
 */
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type BetterAutoCompactConfig, type ConfigIssue } from "./config.ts";
import { computeThresholds, isOverThreshold, type BuiltInCompactionSettings, type EffectiveThreshold } from "./thresholds.ts";

const EXTENSION_NAME = "better-auto-compact";

export default function (pi: ExtensionAPI) {
	let config: BetterAutoCompactConfig = { enabled: true };
	let issues: ConfigIssue[] = [];
	let configPaths = { global: "", project: "" };
	let builtInSettings: BuiltInCompactionSettings = { enabled: true, reserveTokens: 16384 };
	/** compact 进行中标志，防止在回调到来前重复触发。 */
	let inFlight = false;

	const formatTokens = (n: number): string => n.toLocaleString("en-US");

	/** 读取 pi 内置 compaction 设置（与 pi 相同的全局/项目 settings 合并逻辑）。 */
	const loadBuiltInSettings = (cwd: string): void => {
		try {
			const settings = SettingsManager.create(cwd);
			const compaction = settings.getCompactionSettings();
			builtInSettings = { enabled: compaction.enabled, reserveTokens: compaction.reserveTokens };
		} catch {
			// 读不到 settings 时退回 pi 默认值
			builtInSettings = { enabled: true, reserveTokens: 16384 };
		}
	};

	/** 计算当前生效阈值；用量或窗口未知时返回 null。tokens 是已窄化的当前已用 token 数。 */
	const evaluate = (
		ctx: ExtensionContext,
	): { tokens: number; contextWindow: number; percent: number | null; effective: EffectiveThreshold } | null => {
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) {
			return null;
		}
		return {
			tokens: usage.tokens,
			contextWindow: usage.contextWindow,
			percent: usage.percent,
			effective: computeThresholds(config, usage.contextWindow, builtInSettings),
		};
	};

	const triggerCompaction = (ctx: ExtensionContext, reason: string): void => {
		inFlight = true;
		if (ctx.hasUI) {
			ctx.ui.notify(`${EXTENSION_NAME}：${reason}，开始 compact`, "info");
		}
		ctx.compact({
			onComplete: () => {
				inFlight = false;
				if (ctx.hasUI) {
					ctx.ui.notify(`${EXTENSION_NAME}：compact 完成`, "info");
				}
			},
			onError: (error) => {
				inFlight = false;
				if (ctx.hasUI) {
					ctx.ui.notify(`${EXTENSION_NAME}：compact 失败：${error.message}`, "error");
				}
			},
		});
	};

	const checkAndTrigger = (ctx: ExtensionContext): void => {
		if (!config.enabled || inFlight) {
			return;
		}
		const evaluated = evaluate(ctx);
		if (!evaluated) {
			return;
		}
		const { tokens, effective } = evaluated;
		if (!effective.handleByExtension || effective.value === null) {
			return;
		}
		if (!isOverThreshold(tokens, effective.value)) {
			return;
		}
		const lowest = effective.candidates[0];
		triggerCompaction(ctx, `已用 ${formatTokens(tokens)} tokens，达到阈值 ${formatTokens(effective.value)}（${lowest?.describe ?? ""}）`);
	};

	pi.on("session_start", (_event, ctx) => {
		const loaded = loadConfig(ctx.cwd);
		config = loaded.config;
		issues = loaded.issues;
		configPaths = loaded.paths;
		loadBuiltInSettings(ctx.cwd);
		inFlight = false;
		// resume/fork 到一个已超限的会话时，首次测量即应触发
		checkAndTrigger(ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		checkAndTrigger(ctx);
	});

	// 对应 pi 原生"发送新消息前"的检查点：compact 失败遗留的超限状态在用户
	// 下一次发送消息时立即重试，而不是等这轮 turn 结束。
	pi.on("before_agent_start", (_event, ctx) => {
		checkAndTrigger(ctx);
	});

	// onComplete/onError 已复位标志；这里兜底防漏
	pi.on("session_compact_failed", () => {
		inFlight = false;
	});

	pi.registerCommand("compact-thresholds", {
		description: "查看 auto-compact 各阈值（取最低者生效）与当前上下文用量",
		handler: async (_args, ctx) => {
			const lines: string[] = [];

			if (!config.enabled) {
				lines.push(`${EXTENSION_NAME}：已通过 enabled: false 禁用，pi 内置 auto-compact 不受影响。`);
			}

			const evaluated = evaluate(ctx);
			if (!evaluated) {
				lines.push("当前上下文用量未知（尚无模型或尚无消息），无法计算阈值。");
			} else {
				const { tokens, contextWindow, percent, effective } = evaluated;
				lines.push(`模型上下文窗口：${formatTokens(contextWindow)} tokens`);
				lines.push("参与比较的阈值（已用 token 口径，取最低者）：");
				for (const candidate of effective.candidates) {
					const mark = candidate.source === effective.source ? " ← 最低" : "";
					const handler = candidate.source === "remaining" ? "（pi 内置触发）" : "（本扩展触发）";
					lines.push(`  · ${candidate.describe} → ${formatTokens(candidate.usedTokens)} tokens${mark}${handler}`);
				}
				if (effective.candidates.length === 0) {
					lines.push("  · 未配置任何阈值（percentThreshold / usedTokensThreshold），且 pi 内置 auto-compact 未启用。");
				}
				lines.push(
					`当前用量：${formatTokens(tokens)} / ${formatTokens(contextWindow)} tokens（${percent === null ? "未知" : `${percent.toFixed(1)}%`}）`,
				);
				if (effective.handleByExtension && effective.value !== null) {
					const remaining = effective.value - tokens;
					lines.push(remaining > 0 ? `距生效阈值还有 ${formatTokens(remaining)} tokens。` : "已达到生效阈值。");
				}
			}

			if (issues.length > 0) {
				lines.push("配置问题：");
				for (const issue of issues) {
					lines.push(`  · [${issue.path}] ${issue.message}`);
				}
			}
			lines.push(`配置文件：全局 ${configPaths.global}；项目 ${configPaths.project}（项目覆盖全局）`);

			ctx.ui.notify(lines.join("\n"), issues.length > 0 ? "warning" : "info");
		},
	});
}
