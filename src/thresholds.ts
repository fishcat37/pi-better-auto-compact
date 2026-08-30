/**
 * 阈值计算：把三种阈值统一换算为"已用 token"口径，取最低者生效。
 *
 * - 剩余 token 阈值（pi 内置）：contextWindow - reserveTokens
 * - 百分比阈值：contextWindow * percentThreshold / 100
 * - 已用上下文阈值：usedTokensThreshold
 *
 * 内置阈值由 pi 自身在每次请求前检查并触发 compact；扩展只在"扩展阈值
 * 严格低于内置阈值"时接管触发，避免两条路径重复 compact。
 */
import type { BetterAutoCompactConfig } from "./config.ts";

export type ThresholdSource = "remaining" | "percent" | "used";

export interface ThresholdCandidate {
	source: ThresholdSource;
	/** 换算为已用 token 口径的阈值。 */
	usedTokens: number;
	/** 展示用的一句话说明。 */
	describe: string;
}

/** pi 内置 compaction 设置中扩展关心的部分（来自 SettingsManager.getCompactionSettings()）。 */
export interface BuiltInCompactionSettings {
	enabled: boolean;
	reserveTokens: number;
}

export interface EffectiveThreshold {
	/** 最低阈值（已用 token 口径）；null 表示没有任何阈值参与比较。 */
	value: number | null;
	/** 最低值来自哪个阈值。 */
	source: ThresholdSource | null;
	/** 参与比较的全部候选（按阈值升序）。 */
	candidates: ThresholdCandidate[];
	/** 内置阈值是否参与了比较。 */
	builtInParticipates: boolean;
	/** 内置阈值（已用 token 口径），不参与时为 null。 */
	builtInValue: number | null;
	/**
	 * 是否应由本扩展接管触发（存在扩展阈值且严格低于内置阈值，或内置已禁用）。
	 * false 时阈值最低的是内置项，交给 pi 原生 auto-compact 处理。
	 */
	handleByExtension: boolean;
}

export function computeThresholds(
	config: BetterAutoCompactConfig,
	contextWindow: number,
	builtIn: BuiltInCompactionSettings,
): EffectiveThreshold {
	const candidates: ThresholdCandidate[] = [];
	let builtInValue: number | null = null;
	let builtInParticipates = false;

	if (builtIn.enabled && Number.isFinite(contextWindow) && builtIn.reserveTokens >= 0) {
		builtInValue = Math.max(0, contextWindow - builtIn.reserveTokens);
		builtInParticipates = true;
		candidates.push({
			source: "remaining",
			usedTokens: builtInValue,
			describe: `剩余 ${builtIn.reserveTokens.toLocaleString()} tokens（pi 内置）`,
		});
	}

	let hasExtensionThreshold = false;
	if (config.enabled) {
		if (config.percentThreshold !== undefined) {
			hasExtensionThreshold = true;
			candidates.push({
				source: "percent",
				usedTokens: Math.floor((contextWindow * config.percentThreshold) / 100),
				describe: `${config.percentThreshold}% 上下文窗口`,
			});
		}
		if (config.usedTokensThreshold !== undefined) {
			hasExtensionThreshold = true;
			candidates.push({
				source: "used",
				usedTokens: config.usedTokensThreshold,
				describe: `已用 ${config.usedTokensThreshold.toLocaleString()} tokens`,
			});
		}
	}

	const sorted = [...candidates].sort((a, b) => a.usedTokens - b.usedTokens);
	const lowest = sorted[0];
	const handleByExtension =
		lowest !== undefined &&
		hasExtensionThreshold &&
		(!builtInParticipates || lowest.usedTokens < builtInValue!);

	return {
		value: lowest ? lowest.usedTokens : null,
		source: lowest ? lowest.source : null,
		candidates: sorted,
		builtInParticipates,
		builtInValue,
		handleByExtension,
	};
}

/** compact 失败后的重试缓冲：失败点之后需再增长这么多 token 才重试，避免每轮重复失败。 */
export const RETRY_BUFFER_TOKENS = 4096;

/**
 * 当前 token 数是否达到阈值需要触发 compact。
 * 上次触发失败时，需在失败点之上再增长 RETRY_BUFFER_TOKENS 才重试。
 */
export function isOverThreshold(
	currentTokens: number,
	threshold: number,
	lastFailureTokens: number | null,
	retryBufferTokens: number = RETRY_BUFFER_TOKENS,
): boolean {
	if (currentTokens <= threshold) {
		return false;
	}
	if (lastFailureTokens !== null && currentTokens <= lastFailureTokens + retryBufferTokens) {
		return false;
	}
	return true;
}
