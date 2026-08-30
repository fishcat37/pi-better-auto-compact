import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeConfigs, type ConfigIssue } from "./config.ts";
import { computeThresholds, isOverThreshold } from "./thresholds.ts";

const WINDOW = 200_000;
const BUILT_IN = { enabled: true, reserveTokens: 16_384 };

describe("computeThresholds", () => {
	it("三种阈值取最低值（已用阈值最低时由扩展触发）", () => {
		const result = computeThresholds(
			{ enabled: true, percentThreshold: 80, usedTokensThreshold: 110_000 },
			WINDOW,
			BUILT_IN,
		);
		// percent 80% = 160k，used = 110k，remaining = 200k - 16384 = 183616
		assert.equal(result.value, 110_000);
		assert.equal(result.source, "used");
		assert.equal(result.handleByExtension, true);
		assert.deepEqual(
			result.candidates.map((c) => c.source),
			["used", "percent", "remaining"],
		);
	});

	it("百分比阈值最低时生效", () => {
		const result = computeThresholds(
			{ enabled: true, percentThreshold: 50, usedTokensThreshold: 110_000 },
			WINDOW,
			BUILT_IN,
		);
		assert.equal(result.value, 100_000);
		assert.equal(result.source, "percent");
		assert.equal(result.handleByExtension, true);
	});

	it("内置阈值最低时交给 pi 原生处理，扩展不接管", () => {
		const result = computeThresholds(
			{ enabled: true, percentThreshold: 95 },
			WINDOW,
			BUILT_IN,
		);
		// 95% = 190k > 内置 183616
		assert.equal(result.value, 183_616);
		assert.equal(result.source, "remaining");
		assert.equal(result.handleByExtension, false);
	});

	it("百分比阈值与内置阈值相等时不重复接管", () => {
		// 200000 * p / 100 = 183616 → p = 91.808
		const result = computeThresholds({ enabled: true, percentThreshold: 91.808 }, WINDOW, BUILT_IN);
		assert.equal(result.value, 183_616);
		assert.equal(result.handleByExtension, false);
	});

	it("内置禁用时只比较扩展阈值，由扩展触发", () => {
		const result = computeThresholds(
			{ enabled: true, percentThreshold: 80, usedTokensThreshold: 110_000 },
			WINDOW,
			{ enabled: false, reserveTokens: 16_384 },
		);
		assert.equal(result.value, 110_000);
		assert.equal(result.source, "used");
		assert.equal(result.builtInParticipates, false);
		assert.equal(result.handleByExtension, true);
	});

	it("未配置扩展阈值时不接管", () => {
		const result = computeThresholds({ enabled: true }, WINDOW, BUILT_IN);
		assert.equal(result.value, 183_616);
		assert.equal(result.source, "remaining");
		assert.equal(result.handleByExtension, false);
	});

	it("扩展总开关关闭时视同未配置", () => {
		const result = computeThresholds(
			{ enabled: false, percentThreshold: 50, usedTokensThreshold: 110_000 },
			WINDOW,
			BUILT_IN,
		);
		assert.equal(result.value, 183_616);
		assert.equal(result.handleByExtension, false);
	});

	it("百分比阈值向下取整", () => {
		const result = computeThresholds({ enabled: true, percentThreshold: 55 }, 100_003, { enabled: false, reserveTokens: 0 });
		assert.equal(result.value, Math.floor(100_003 * 0.55));
	});
});

describe("isOverThreshold", () => {
	it("未达到阈值为 false，达到为 true（严格大于）", () => {
		assert.equal(isOverThreshold(110_000, 110_000), false);
		assert.equal(isOverThreshold(110_001, 110_000), true);
	});
});

describe("mergeConfigs", () => {
	it("项目配置覆盖全局配置，enabled 默认 true", () => {
		const config = mergeConfigs({ percentThreshold: 80 }, { usedTokensThreshold: 110_000 }, []);
		assert.deepEqual(config, { enabled: true, percentThreshold: 80, usedTokensThreshold: 110_000 });
	});

	it("非法字段报 issue 且被忽略，不影响其他字段", () => {
		const issues: ConfigIssue[] = [];
		const config = mergeConfigs(
			{ percentThreshold: 150, usedTokensThreshold: 110_000 },
			{ percentThreshold: "80", enabled: "no" },
			issues,
		);
		assert.deepEqual(config, { enabled: true, usedTokensThreshold: 110_000 });
		assert.equal(issues.length, 3);
	});

	it("根不是对象时报 issue", () => {
		const issues: ConfigIssue[] = [];
		mergeConfigs([1, 2], undefined, issues);
		assert.equal(issues.length, 1);
		assert.ok(issues[0]);
		assert.equal(issues[0].path, "global");
	});

	it("usedTokensThreshold 必须是正整数", () => {
		const issues: ConfigIssue[] = [];
		const config = mergeConfigs({ usedTokensThreshold: 110.5 }, { usedTokensThreshold: -1 }, issues);
		assert.deepEqual(config, { enabled: true });
		assert.equal(issues.length, 2);
	});
});
