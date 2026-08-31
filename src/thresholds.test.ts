import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyThresholdToggle, applyThresholdValue, mergeConfigs, type ConfigIssue } from "./config.ts";
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

	it("percentEnabled: false 时百分比阈值不参与比较", () => {
		const result = computeThresholds(
			{ enabled: true, percentThreshold: 50, percentEnabled: false, usedTokensThreshold: 110_000 },
			WINDOW,
			BUILT_IN,
		);
		assert.equal(result.value, 110_000);
		assert.equal(result.source, "used");
	});

	it("usedTokensEnabled: false 时已用阈值不参与比较", () => {
		const result = computeThresholds(
			{ enabled: true, percentThreshold: 50, usedTokensThreshold: 110_000, usedTokensEnabled: false },
			WINDOW,
			BUILT_IN,
		);
		assert.equal(result.value, 100_000);
		assert.equal(result.source, "percent");
	});

	it("两个扩展阈值都被开关禁用时只剩内置阈值", () => {
		const result = computeThresholds(
			{
				enabled: true,
				percentThreshold: 50,
				percentEnabled: false,
				usedTokensThreshold: 110_000,
				usedTokensEnabled: false,
			},
			WINDOW,
			BUILT_IN,
		);
		assert.equal(result.value, 183_616);
		assert.equal(result.source, "remaining");
		assert.equal(result.handleByExtension, false);
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

	it("项目配置的开关字段覆盖全局", () => {
		const config = mergeConfigs({ percentThreshold: 80, percentEnabled: true }, { percentEnabled: false, usedTokensEnabled: false }, []);
		assert.deepEqual(config, {
			enabled: true,
			percentThreshold: 80,
			percentEnabled: false,
			usedTokensEnabled: false,
		});
	});

	it("开关字段必须是布尔值", () => {
		const issues: ConfigIssue[] = [];
		const config = mergeConfigs({ percentThreshold: 80, percentEnabled: "yes" }, { usedTokensEnabled: 1 }, issues);
		assert.deepEqual(config, { enabled: true, percentThreshold: 80 });
		assert.equal(issues.length, 2);
	});
});

describe("applyThresholdToggle", () => {
	const format = (obj: Record<string, unknown>) => `${JSON.stringify(obj, null, 2)}\n`;

	it("关闭全局配置的阈值：开关字段写入全局，项目文件不动", () => {
		const result = applyThresholdToggle(format({ percentThreshold: 80 }), null, "percent", false);
		assert.equal(result.error, undefined);
		assert.ok(result.global !== null);
		assert.deepEqual(JSON.parse(result.global), { percentThreshold: 80, percentEnabled: false });
		assert.equal(result.project, null);
	});

	it("关闭项目配置的阈值：开关字段写入项目文件，全局不动", () => {
		const result = applyThresholdToggle(format({ percentThreshold: 80 }), format({ percentThreshold: 90 }), "percent", false);
		assert.equal(result.error, undefined);
		assert.equal(result.global, null);
		assert.ok(result.project !== null);
		assert.deepEqual(JSON.parse(result.project), { percentThreshold: 90, percentEnabled: false });
	});

	it("重新开启：删除开关字段，并清理另一份文件中的残留开关", () => {
		const result = applyThresholdToggle(
			format({ percentEnabled: false }),
			format({ percentThreshold: 90, percentEnabled: false }),
			"percent",
			true,
		);
		assert.equal(result.error, undefined);
		assert.ok(result.global !== null);
		assert.deepEqual(JSON.parse(result.global), {});
		assert.ok(result.project !== null);
		assert.deepEqual(JSON.parse(result.project), { percentThreshold: 90 });
	});

	it("已是关闭状态时不写文件", () => {
		const result = applyThresholdToggle(format({ percentThreshold: 80, percentEnabled: false }), null, "percent", false);
		assert.equal(result.error, undefined);
		assert.equal(result.global, null);
	});

	it("已开启且无残留开关时不写文件", () => {
		const result = applyThresholdToggle(format({ percentThreshold: 80 }), null, "percent", true);
		assert.equal(result.error, undefined);
		assert.equal(result.global, null);
	});

	it("阈值未配置数值时报错", () => {
		const result = applyThresholdToggle(format({ other: 1 }), null, "percent", true);
		assert.ok(result.error?.includes("未配置数值"));
	});

	it("JSON 损坏时报错", () => {
		const result = applyThresholdToggle("not json", null, "percent", true);
		assert.ok(result.error?.includes("JSON 解析失败"));
	});

	it("全局根不是对象时跳过全局，只改提供数值的项目", () => {
		const result = applyThresholdToggle("[1, 2]", format({ percentThreshold: 90 }), "percent", false);
		assert.equal(result.error, undefined);
		assert.equal(result.global, null);
		assert.ok(result.project !== null);
		assert.deepEqual(JSON.parse(result.project), { percentThreshold: 90, percentEnabled: false });
	});

	it("usedTokensThreshold 同样支持开关", () => {
		const result = applyThresholdToggle(format({ usedTokensThreshold: 110_000 }), null, "used", false);
		assert.equal(result.error, undefined);
		assert.ok(result.global !== null);
		assert.deepEqual(JSON.parse(result.global), { usedTokensThreshold: 110_000, usedTokensEnabled: false });
	});
});

describe("applyThresholdValue", () => {
	const format = (obj: Record<string, unknown>) => `${JSON.stringify(obj, null, 2)}\n`;

	it("项目已配置数值时更新项目文件，并清除其中的开关字段", () => {
		const result = applyThresholdValue(format({ percentThreshold: 80 }), format({ percentThreshold: 90, percentEnabled: false }), "percent", 70);
		assert.equal(result.error, undefined);
		assert.equal(result.global, null);
		assert.ok(result.project !== null);
		assert.deepEqual(JSON.parse(result.project), { percentThreshold: 70 });
	});

	it("仅全局配置数值时更新全局文件", () => {
		const result = applyThresholdValue(format({ usedTokensThreshold: 110_000 }), null, "used", 240_000);
		assert.equal(result.error, undefined);
		assert.ok(result.global !== null);
		assert.deepEqual(JSON.parse(result.global), { usedTokensThreshold: 240_000 });
		assert.equal(result.project, null);
	});

	it("两份文件均未配置时写入项目配置（新建），全局开关字段被清理", () => {
		const result = applyThresholdValue(format({ percentEnabled: false }), null, "percent", 90);
		assert.equal(result.error, undefined);
		assert.ok(result.global !== null);
		assert.deepEqual(JSON.parse(result.global), {});
		assert.ok(result.project !== null);
		assert.deepEqual(JSON.parse(result.project), { percentThreshold: 90 });
	});

	it("值相同且无开关字段残留时不写文件", () => {
		const result = applyThresholdValue(format({ percentThreshold: 90 }), null, "percent", 90);
		assert.equal(result.error, undefined);
		assert.equal(result.global, null);
		assert.equal(result.project, null);
	});

	it("JSON 损坏时报错", () => {
		const result = applyThresholdValue("not json", null, "percent", 90);
		assert.ok(result.error?.includes("JSON 解析失败"));
	});

	it("项目文件存在但根不是对象时报错，不覆盖原内容", () => {
		for (const broken of ["[1, 2]", "null", '"foo"']) {
			const result = applyThresholdValue(null, broken, "percent", 90);
			assert.ok(result.error?.includes("必须是 JSON 对象"), `broken=${broken}`);
			assert.equal(result.project, null);
		}
	});

	it("项目文件根不是对象但全局有值时只更新全局，不碰项目文件", () => {
		const result = applyThresholdValue(format({ usedTokensThreshold: 110_000 }), "[1, 2]", "used", 240_000);
		assert.equal(result.error, undefined);
		assert.ok(result.global !== null);
		assert.deepEqual(JSON.parse(result.global), { usedTokensThreshold: 240_000 });
		assert.equal(result.project, null);
	});
});
