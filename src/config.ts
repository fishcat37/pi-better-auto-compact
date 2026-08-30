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
	/**
	 * 已用上下文阈值：已用 token 超过该值时 compact（如 110000 表示 110k）。
	 * 未配置表示不启用该阈值。
	 */
	usedTokensThreshold?: number;
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
