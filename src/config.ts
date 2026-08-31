/**
 * better-auto-compact 配置读取与校验。
 *
 * 配置文件为 JSON，全局与项目两处，项目配置浅合并覆盖全局：
 * - 全局：~/.pi/agent/better-auto-compact.json
 * - 项目：<cwd>/.pi/better-auto-compact.json
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface BetterAutoCompactConfig {
	/** 总开关，默认 true。设为 false 时扩展完全不动作（pi 内置 auto-compact 不受影响）。 */
	enabled: boolean;
	/**
	 * 百分比阈值：已用上下文达到模型上下文窗口的百分之多少时 compact。
	 * 取值 (0, 100]，未配置表示不启用该阈值。
	 */
	percentThreshold?: number;
	/** 百分比阈值开关，默认 true。false 时该阈值不参与比较（数值仍保留在配置中）。 */
	percentEnabled?: boolean;
	/**
	 * 已用上下文阈值：已用 token 超过该值时 compact（如 240000 表示 240k）。
	 * 未配置表示不启用该阈值。
	 */
	usedTokensThreshold?: number;
	/** 已用上下文阈值开关，默认 true。false 时该阈值不参与比较（数值仍保留在配置中）。 */
	usedTokensEnabled?: boolean;
}

/** 配置解析错误，逐条列出以便用户定位写错的字段。 */
export interface ConfigIssue {
	path: "global" | "project";
	message: string;
}

export interface LoadConfigResult {
	config: BetterAutoCompactConfig;
	/** 全局与项目配置文件的路径（用于 /compact-thresholds 展示与文档提示）。 */
	paths: { global: string; project: string };
	issues: ConfigIssue[];
}

export function globalConfigPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "better-auto-compact.json");
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "better-auto-compact.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 校验并规范化单个配置文件的内容。非法字段报 issue 并忽略，
 * 保证一个写错的字段不会让整个扩展失效。
 */
function parseConfigFile(raw: unknown, path: ConfigIssue["path"], issues: ConfigIssue[]): Partial<BetterAutoCompactConfig> {
	if (raw === undefined) {
		return {};
	}
	if (!isPlainObject(raw)) {
		issues.push({ path, message: "配置文件内容必须是 JSON 对象，已忽略该文件" });
		return {};
	}
	const parsed: Partial<BetterAutoCompactConfig> = {};
	if (raw.enabled !== undefined) {
		if (typeof raw.enabled === "boolean") {
			parsed.enabled = raw.enabled;
		} else {
			issues.push({ path, message: `enabled 必须是布尔值，收到 ${JSON.stringify(raw.enabled)}，已忽略` });
		}
	}
	if (raw.percentThreshold !== undefined) {
		const value = raw.percentThreshold;
		if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100) {
			parsed.percentThreshold = value;
		} else {
			issues.push({ path, message: `percentThreshold 必须是 (0, 100] 内的数字，收到 ${JSON.stringify(value)}，已忽略` });
		}
	}
	if (raw.usedTokensThreshold !== undefined) {
		const value = raw.usedTokensThreshold;
		if (typeof value === "number" && Number.isInteger(value) && value > 0) {
			parsed.usedTokensThreshold = value;
		} else {
			issues.push({ path, message: `usedTokensThreshold 必须是正整数，收到 ${JSON.stringify(value)}，已忽略` });
		}
	}
	for (const [field, key] of [
		["percentEnabled", "percentThreshold"],
		["usedTokensEnabled", "usedTokensThreshold"],
	] as const) {
		if (raw[field] !== undefined) {
			if (typeof raw[field] === "boolean") {
				parsed[field] = raw[field];
			} else {
				issues.push({ path, message: `${field} 必须是布尔值，收到 ${JSON.stringify(raw[field])}，已忽略` });
			}
		}
	}
	return parsed;
}

/** 合并全局与项目配置（项目优先），并校验字段。 */
export function mergeConfigs(global: unknown, project: unknown, issues: ConfigIssue[]): BetterAutoCompactConfig {
	const merged: BetterAutoCompactConfig = {
		enabled: true,
		...parseConfigFile(global, "global", issues),
		...parseConfigFile(project, "project", issues),
	};
	return merged;
}

/** /compact-toggle 可操作的阈值。 */
export type ThresholdTarget = "percent" | "used";

export interface ThresholdTargetMeta {
	/** 阈值数值字段。 */
	valueField: "percentThreshold" | "usedTokensThreshold";
	/** 阈值开关字段。 */
	flagField: "percentEnabled" | "usedTokensEnabled";
	/** 展示用名称（含字段名，便于用户在配置文件中定位）。 */
	label: string;
}

export const THRESHOLD_TARGETS: Record<ThresholdTarget, ThresholdTargetMeta> = {
	percent: { valueField: "percentThreshold", flagField: "percentEnabled", label: "百分比阈值 percentThreshold" },
	used: { valueField: "usedTokensThreshold", flagField: "usedTokensEnabled", label: "已用 token 阈值 usedTokensThreshold" },
};

export interface ThresholdToggleResult {
	/** 要写入的新文本；null 表示该文件无需改动（含不存在且无需创建的情况）。 */
	global: string | null;
	project: string | null;
	/** 非空表示无法完成操作（JSON 损坏，或开关时阈值未配置数值）。 */
	error?: string;
}

/** 解析配置文件文本为 JSON 对象；文本 null 表示文件不存在，根不是对象视同不存在。 */
function parseConfigText(text: string | null, name: string): { value: Record<string, unknown> | null; error?: string } {
	if (text === null) {
		return { value: null };
	}
	try {
		const parsed: unknown = JSON.parse(text);
		return { value: isPlainObject(parsed) ? parsed : null };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { value: null, error: `${name}配置 JSON 解析失败（${reason}），请先手动修复后再用命令操作。` };
	}
}

/** 序列化为配置文件文本；与原文相同时返回 null，由调用方跳过写入。 */
function serializeConfigText(obj: Record<string, unknown>, original: string | null): string | null {
	const newText = `${JSON.stringify(obj, null, 2)}\n`;
	return newText === original ? null : newText;
}

/** 与加载时同一套校验，判断对象是否提供某阈值的数值。 */
function providesThresholdValue(
	obj: Record<string, unknown> | null,
	valueField: "percentThreshold" | "usedTokensThreshold",
): boolean {
	return obj !== null && parseConfigFile(obj, "global", [])[valueField] !== undefined;
}

/**
 * 计算"开关某个阈值"后的两份配置文件文本。
 *
 * 开关字段只保留在提供该阈值数值的文件中（项目优先），另一份文件删除该
 * 字段，保证浅合并的结果可预测：next=true 时删除开关字段（恢复默认开启），
 * next=false 时在来源文件写入 false。文本无变化或文件不存在时返回 null，
 * 由调用方跳过写入。
 *
 * 参数为文件原始文本，null 表示文件不存在。
 */
export function applyThresholdToggle(
	globalText: string | null,
	projectText: string | null,
	target: ThresholdTarget,
	next: boolean,
): ThresholdToggleResult {
	const meta = THRESHOLD_TARGETS[target];

	const global = parseConfigText(globalText, "全局");
	if (global.error) {
		return { global: null, project: null, error: global.error };
	}
	const project = parseConfigText(projectText, "项目");
	if (project.error) {
		return { global: null, project: null, error: project.error };
	}

	const source: "global" | "project" | null = providesThresholdValue(project.value, meta.valueField)
		? "project"
		: providesThresholdValue(global.value, meta.valueField)
			? "global"
			: null;
	if (!source) {
		return {
			global: null,
			project: null,
			error: `${meta.label}未配置数值，可先用 /compact-toggle ${target} <数值> 设置，或直接编辑配置文件。`,
		};
	}

	const build = (text: string | null, obj: Record<string, unknown> | null, isSource: boolean): string | null => {
		if (!obj) {
			return null;
		}
		const clone = { ...obj };
		delete clone[meta.flagField];
		if (!next && isSource) {
			clone[meta.flagField] = false;
		}
		return serializeConfigText(clone, text);
	};

	return {
		global: build(globalText, global.value, source === "global"),
		project: build(projectText, project.value, source === "project"),
	};
}

/**
 * 计算"设置某个阈值数值"后的两份配置文件文本。
 *
 * 数值写入提供该阈值数值的文件（项目优先）；两份文件均未配置时写入项目
 * 配置（文件不存在则由调用方创建）。同时删除两份文件中的开关字段（恢复
 * 默认开启），保证新设置的数值立即参与比较。文本无变化时返回 null。
 *
 * 参数为文件原始文本，null 表示文件不存在。
 */
export function applyThresholdValue(
	globalText: string | null,
	projectText: string | null,
	target: ThresholdTarget,
	value: number,
): ThresholdToggleResult {
	const meta = THRESHOLD_TARGETS[target];

	const global = parseConfigText(globalText, "全局");
	if (global.error) {
		return { global: null, project: null, error: global.error };
	}
	const project = parseConfigText(projectText, "项目");
	if (project.error) {
		return { global: null, project: null, error: project.error };
	}

	// 未配置过数值时落到项目配置：项目优先原则下保证至少本项目生效。
	const source: "global" | "project" = providesThresholdValue(project.value, meta.valueField)
		? "project"
		: providesThresholdValue(global.value, meta.valueField)
			? "global"
			: "project";

	const build = (text: string | null, obj: Record<string, unknown> | null, isSource: boolean): string | null => {
		// 非来源文件不存在时不创建；来源文件不存在仅在项目侧发生（新建配置）。
		if (!obj && !isSource) {
			return null;
		}
		const clone = { ...(obj ?? {}) };
		delete clone[meta.flagField];
		if (isSource) {
			clone[meta.valueField] = value;
		}
		return serializeConfigText(clone, text);
	};

	return {
		global: build(globalText, global.value, source === "global"),
		project: build(projectText, project.value, source === "project"),
	};
}

function readConfigFile(filePath: string): unknown {
	if (!existsSync(filePath)) {
		return undefined;
	}
	try {
		return JSON.parse(readFileSync(filePath, "utf-8"));
	} catch (error) {
		return { __parseError: error instanceof Error ? error.message : String(error) };
	}
}

/** 读取全局与项目配置文件并合并。 */
export function loadConfig(cwd: string, agentDir: string = getAgentDir()): LoadConfigResult {
	const paths = { global: globalConfigPath(agentDir), project: projectConfigPath(cwd) };
	const issues: ConfigIssue[] = [];

	const globalRaw = readConfigFile(paths.global);
	if (isPlainObject(globalRaw) && typeof globalRaw.__parseError === "string") {
		issues.push({ path: "global", message: `JSON 解析失败：${globalRaw.__parseError}，已忽略全局配置` });
	}
	const projectRaw = readConfigFile(paths.project);
	if (isPlainObject(projectRaw) && typeof projectRaw.__parseError === "string") {
		issues.push({ path: "project", message: `JSON 解析失败：${projectRaw.__parseError}，已忽略项目配置` });
	}

	const config = mergeConfigs(
		isPlainObject(globalRaw) && !("__parseError" in globalRaw) ? globalRaw : undefined,
		isPlainObject(projectRaw) && !("__parseError" in projectRaw) ? projectRaw : undefined,
		issues,
	);
	return { config, paths, issues };
}
