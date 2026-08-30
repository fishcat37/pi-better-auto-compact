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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applyThresholdToggle,
	loadConfig,
	THRESHOLD_TARGETS,
	type BetterAutoCompactConfig,
	type ConfigIssue,
	type ThresholdTarget,
} from "./config.ts";
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

	/** 读取并合并配置（session_start 与 /compact-toggle 写回后共用，保证立即生效）。 */
	const reloadConfig = (cwd: string): void => {
		const loaded = loadConfig(cwd);
		config = loaded.config;
		issues = loaded.issues;
		configPaths = loaded.paths;
	};

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
		// 压缩过程与结果由 pi 原生呈现（compaction 事件）；这里只提示触发原因
		// （哪个阈值生效），这是原生没有的信息。
		if (ctx.hasUI) {
			ctx.ui.notify(`${EXTENSION_NAME}：${reason}，开始 compact`, "info");
		}
		ctx.compact({
			onComplete: () => {
				inFlight = false;
			},
			onError: () => {
				inFlight = false;
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
		// 已越过 pi 内置阈值时交给原生处理（threshold/overflow 全套机制），
		// 避免与原生的检查点同时触发两条并行的压缩。
		if (effective.builtInValue !== null && tokens > effective.builtInValue) {
			return;
		}
		if (!isOverThreshold(tokens, effective.value)) {
			return;
		}
		const lowest = effective.candidates[0];
		triggerCompaction(ctx, `已用 ${formatTokens(tokens)} tokens，达到阈值 ${formatTokens(effective.value)}（${lowest?.describe ?? ""}）`);
	};

	pi.on("session_start", (_event, ctx) => {
		reloadConfig(ctx.cwd);
		loadBuiltInSettings(ctx.cwd);
		inFlight = false;
		// 不在此处检查阈值：pi 原生 resume 已超限会话也不会主动压缩，
		// 而是等发送新消息前的检查点触发，行为保持一致。
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

	// ---------- /compact-toggle：阈值开关 ----------

	const readTextIfExists = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf-8") : null);

	/** 阈值当前是否参与比较（有数值且开关未关闭）。 */
	const isTargetOn = (target: ThresholdTarget): boolean => {
		const meta = THRESHOLD_TARGETS[target];
		return config[meta.valueField] !== undefined && config[meta.flagField] !== false;
	};

	/** 阈值数值的展示文本；未配置时为 null。 */
	const describeThresholdValue = (target: ThresholdTarget): string | null => {
		const meta = THRESHOLD_TARGETS[target];
		const value = config[meta.valueField];
		if (value === undefined) {
			return null;
		}
		return target === "percent" ? `${value}%` : `${formatTokens(value)} tokens`;
	};

	/**
	 * 翻转阈值开关：写配置文件并重载内存配置，本次会话立即生效。
	 * 开关字段写在提供数值的文件里（项目优先），见 applyThresholdToggle。
	 */
	const applyToggle = (cwd: string, target: ThresholdTarget, next: boolean): { ok: boolean; message: string } => {
		const meta = THRESHOLD_TARGETS[target];
		const result = applyThresholdToggle(readTextIfExists(configPaths.global), readTextIfExists(configPaths.project), target, next);
		if (result.error) {
			return { ok: false, message: `${EXTENSION_NAME}：${result.error}` };
		}
		const written: string[] = [];
		if (result.global !== null) {
			writeFileSync(configPaths.global, result.global);
			written.push(`全局 ${configPaths.global}`);
		}
		if (result.project !== null) {
			writeFileSync(configPaths.project, result.project);
			written.push(`项目 ${configPaths.project}`);
		}
		if (written.length === 0) {
			return { ok: true, message: `${meta.label}已经是${next ? "开启" : "关闭"}状态，无需修改。` };
		}
		reloadConfig(cwd);
		const suffix = config.enabled ? "" : "（注意：总开关 enabled 当前为 false，阈值不会参与比较。）";
		return { ok: true, message: `${meta.label}已${next ? "开启" : "关闭"}，写入 ${written.join("、")}，本次会话立即生效。${suffix}` };
	};

	const parseToggleArgs = (args: string): { target: ThresholdTarget; next: boolean } | { error: string } => {
		const tokens = args.toLowerCase().split(/\s+/);
		const targetMap: Record<string, ThresholdTarget> = {
			percent: "percent",
			pct: "percent",
			百分比: "percent",
			used: "used",
			usedtokens: "used",
			已用: "used",
		};
		const target = targetMap[tokens[0] ?? ""];
		if (!target) {
			return { error: `无法识别阈值 "${tokens[0] ?? ""}"，可选 percent / used。` };
		}
		const state = tokens[1];
		if (state !== "on" && state !== "off") {
			return { error: `无法识别开关状态 "${state ?? ""}"，可选 on / off。` };
		}
		return { target, next: state === "on" };
	};

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
				// 已配置数值但被开关禁用的阈值，提示去向（可用 /compact-toggle 打开）
				if (config.enabled) {
					for (const target of ["percent", "used"] as const) {
						const meta = THRESHOLD_TARGETS[target];
						const value = config[meta.valueField];
						if (value !== undefined && config[meta.flagField] === false) {
							const valueText = target === "percent" ? `${value}%` : `${formatTokens(value)} tokens`;
							lines.push(`  · ${meta.label} = ${valueText} — 已禁用（${meta.flagField}: false），不参与比较，可用 /compact-toggle 打开`);
						}
					}
				}
				if (effective.candidates.length === 0) {
					lines.push("  · 未配置任何生效阈值，且 pi 内置 auto-compact 未启用。");
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

	pi.registerCommand("compact-toggle", {
		description: "开关 auto-compact 补充阈值（写入配置文件，本次会话立即生效，无需 /reload）",
		getArgumentCompletions: (argumentPrefix) => {
			const items = [
				{ value: "percent on", label: "percent on", description: "开启百分比阈值" },
				{ value: "percent off", label: "percent off", description: "关闭百分比阈值" },
				{ value: "used on", label: "used on", description: "开启已用 token 阈值" },
				{ value: "used off", label: "used off", description: "关闭已用 token 阈值" },
			];
			const prefix = argumentPrefix.trim().toLowerCase();
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : items;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed) {
				const parsed = parseToggleArgs(trimmed);
				if ("error" in parsed) {
					ctx.ui.notify(`${EXTENSION_NAME}：${parsed.error}\n用法：/compact-toggle percent|used on|off，无参数时打开交互菜单。`, "warning");
					return;
				}
				const outcome = applyToggle(ctx.cwd, parsed.target, parsed.next);
				ctx.ui.notify(outcome.message, outcome.ok ? "info" : "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(`${EXTENSION_NAME}：当前模式无交互界面，请使用参数形式 /compact-toggle percent|used on|off`, "warning");
				return;
			}
			for (;;) {
				const options: string[] = [];
				const actions = new Map<string, { target: ThresholdTarget; configured: boolean; on: boolean }>();
				for (const target of ["percent", "used"] as const) {
					const meta = THRESHOLD_TARGETS[target];
					const valueText = describeThresholdValue(target);
					const on = isTargetOn(target);
					const option =
						valueText === null
							? `${meta.label} — 未配置数值，请先在配置文件中设置 ${meta.valueField}`
							: `${meta.label} = ${valueText} — ${on ? "开" : "关"}（选择后${on ? "关闭" : "开启"}）`;
					options.push(option);
					actions.set(option, { target, configured: valueText !== null, on });
				}
				const choice = await ctx.ui.select("auto-compact 阈值开关（写入配置文件并立即生效）", options);
				if (choice === undefined) {
					break;
				}
				const action = actions.get(choice);
				if (!action) {
					break;
				}
				if (!action.configured) {
					const meta = THRESHOLD_TARGETS[action.target];
					ctx.ui.notify(
						`${EXTENSION_NAME}：${meta.label}未配置数值，请先在 ${configPaths.global} 或 ${configPaths.project} 中设置 ${meta.valueField}。`,
						"warning",
					);
					continue;
				}
				const outcome = applyToggle(ctx.cwd, action.target, !action.on);
				ctx.ui.notify(outcome.message, outcome.ok ? "info" : "warning");
			}
		},
	});
}
