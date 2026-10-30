import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	CATEGORIES,
	type Category,
	COMPLEXITIES,
	type Complexity,
	LEVELS,
	type Role,
	type Severity,
} from "./state.ts";

export interface Target {
	preferred: string;
	compatible: string[];
}
export interface Rule {
	category?: Category[];
	complexity?: Complexity[];
	reasoning?: ClassificationReasoning[];
	risk?: Severity[];
	multiFile?: boolean;
	verification?: boolean;
	role: Exclude<Role, "fallback">;
	thinking: ModelThinkingLevel;
}
type ClassificationReasoning = "shallow" | "moderate" | "deep";

export interface Config {
	version: 1;
	enabled: boolean;
	allowProjectOverrides: boolean;
	models: { terra: Target; sol: Target; astra: Target | null; fallback: Target };
	classifier: {
		model: string;
		minConfidence: number;
		timeoutMs: number;
		maxRequestChars: number;
		failureCooldownMs: number;
	};
	policy: Rule[];
	sticky: { minWorkUnitsBetweenSwitches: number };
	thinking: {
		preferCurrentModel: boolean;
		minCompletedWorkUnits: number;
		minSuccessRate: number;
		maxLatencyRatio: number;
	};
	cache: {
		minSavingsRatio: number;
		minSavingsUsd: number;
		minSamples: number;
		expectedRemainingRequests: number | null;
		maxRetryRiskIncrease: number;
	};
	fallback: {
		enabled: boolean;
		cooldownMs: number;
		maxCooldownMs: number;
		maxRetries: number;
		maxTokens: number | null;
		sharedCooldownFile: string | null;
	};
	diagnostics: "quiet" | "normal" | "verbose";
}

export const DEFAULT_CONFIG: Config = {
	version: 1,
	enabled: true,
	allowProjectOverrides: false,
	models: {
		terra: {
			preferred: "openai-codex/gpt-6.1-terra",
			compatible: ["openai/gpt-6.1-terra", "openai-codex/gpt-5.6-terra", "openai/gpt-5.6-terra"],
		},
		sol: {
			preferred: "openai-codex/gpt-6.1-sol",
			compatible: ["openai/gpt-6.1-sol", "openai-codex/gpt-5.6-sol", "openai/gpt-5.6-sol"],
		},
		astra: null,
		fallback: { preferred: "deepseek/deepseek-flash", compatible: [] },
	},
	classifier: {
		model: "typesafe/jev-latest",
		minConfidence: 0.75,
		timeoutMs: 10000,
		maxRequestChars: 8000,
		failureCooldownMs: 300000,
	},
	// Ordered policy data. Routing code contains no category-to-model table.
	policy: [
		{ complexity: ["exceptional"], role: "astra", thinking: "max" },
		{ category: ["architecture"], role: "sol", thinking: "xhigh" },
		{ category: ["code review"], risk: ["high"], role: "sol", thinking: "xhigh" },
		{ complexity: ["high"], role: "sol", thinking: "xhigh" },
		{ complexity: ["trivial"], role: "terra", thinking: "medium" },
		{ category: ["small code modification", "documentation"], role: "terra", thinking: "medium" },
		{ category: ["debugging"], complexity: ["low"], role: "terra", thinking: "medium" },
		{ complexity: ["low"], role: "terra", thinking: "medium" },
		{ role: "terra", thinking: "high" },
	],
	sticky: { minWorkUnitsBetweenSwitches: 2 },
	thinking: {
		preferCurrentModel: true,
		minCompletedWorkUnits: 3,
		minSuccessRate: 0.8,
		maxLatencyRatio: 1.25,
	},
	cache: {
		minSavingsRatio: 0.2,
		minSavingsUsd: 0.05,
		minSamples: 3,
		expectedRemainingRequests: null,
		maxRetryRiskIncrease: 0.1,
	},
	fallback: {
		enabled: true,
		cooldownMs: 900000,
		maxCooldownMs: 86400000,
		maxRetries: 2,
		maxTokens: null,
		sharedCooldownFile: "jev-orchestrator-cooldown.json",
	},
	diagnostics: "normal",
};

function fail(path: string): never {
	throw new Error(`Invalid orchestrator configuration at ${path}.`);
}
function record(v: unknown, path: string): Record<string, unknown> {
	if (!v || typeof v !== "object" || Array.isArray(v)) fail(path);
	return v as Record<string, unknown>;
}
function known(v: Record<string, unknown>, keys: string[], path: string): void {
	for (const k of Object.keys(v)) if (!keys.includes(k)) fail(`${path}.${k}`);
}
function merge(base: unknown, input: unknown, path: string): unknown {
	if (base !== null && typeof base === "object" && !Array.isArray(base)) {
		const b = record(base, path);
		const p = record(input, path);
		known(p, Object.keys(b), path);
		return Object.fromEntries(
			Object.entries(b).map(([k, v]) => [
				k,
				Object.hasOwn(p, k) ? merge(v, p[k], `${path}.${k}`) : structuredClone(v),
			]),
		);
	}
	if (base !== null && input !== null && typeof input !== typeof base) fail(path);
	return structuredClone(input);
}
function number(v: unknown, path: string, min: number, max: number, integer = false): void {
	if (
		typeof v !== "number" ||
		!Number.isFinite(v) ||
		v < min ||
		v > max ||
		(integer && !Number.isSafeInteger(v))
	)
		fail(path);
}
function members(v: unknown, choices: readonly string[], path: string): void {
	if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string" || !choices.includes(x)))
		fail(path);
}
export function splitModel(key: string): [string, string] {
	const i = key.indexOf("/");
	if (i <= 0 || i === key.length - 1 || /\s/.test(key)) fail("model identity");
	return [key.slice(0, i), key.slice(i + 1)];
}
export function parseConfig(input: unknown, base: Config = DEFAULT_CONFIG): Config {
	const c = merge(base, input, "root") as Config;
	if (c.version !== 1) fail("version");
	for (const k of ["enabled", "allowProjectOverrides"] as const) if (typeof c[k] !== "boolean") fail(k);
	for (const [role, t] of Object.entries(c.models)) {
		if (role === "astra" && t === null) continue;
		const r = record(t, `models.${role}`);
		known(r, ["preferred", "compatible"], `models.${role}`);
		if (
			typeof r.preferred !== "string" ||
			!Array.isArray(r.compatible) ||
			r.compatible.some((x) => typeof x !== "string")
		)
			fail(`models.${role}`);
		for (const key of [r.preferred, ...r.compatible] as string[]) splitModel(key);
	}
	if (typeof c.classifier.model !== "string") fail("classifier.model");
	splitModel(c.classifier.model);
	number(c.classifier.minConfidence, "classifier.minConfidence", 0, 1);
	number(c.classifier.timeoutMs, "classifier.timeoutMs", 1, 60000, true);
	number(c.classifier.maxRequestChars, "classifier.maxRequestChars", 256, 32000, true);
	number(c.classifier.failureCooldownMs, "classifier.failureCooldownMs", 0, 86400000, true);
	if (!Array.isArray(c.policy) || c.policy.length === 0 || c.policy.length > 100) fail("policy");
	for (const rule of c.policy) {
		const r = record(rule, "policy rule");
		known(
			r,
			["category", "complexity", "reasoning", "risk", "multiFile", "verification", "role", "thinking"],
			"policy rule",
		);
		if (!["terra", "sol", "astra"].includes(rule.role) || !LEVELS.includes(rule.thinking))
			fail("policy target");
		if (rule.category !== undefined) members(rule.category, CATEGORIES, "policy.category");
		if (rule.complexity !== undefined) members(rule.complexity, COMPLEXITIES, "policy.complexity");
		if (rule.reasoning !== undefined)
			members(rule.reasoning, ["shallow", "moderate", "deep"], "policy.reasoning");
		if (rule.risk !== undefined) members(rule.risk, ["low", "medium", "high"], "policy.risk");
		for (const k of ["multiFile", "verification"] as const)
			if (rule[k] !== undefined && typeof rule[k] !== "boolean") fail(`policy.${k}`);
	}
	if (c.policy.at(-1) && Object.keys(c.policy.at(-1) ?? {}).some((k) => !["role", "thinking"].includes(k)))
		fail("policy final catch-all");
	number(c.sticky.minWorkUnitsBetweenSwitches, "sticky.minWorkUnitsBetweenSwitches", 1, 100, true);
	if (typeof c.thinking.preferCurrentModel !== "boolean") fail("thinking.preferCurrentModel");
	number(c.thinking.minCompletedWorkUnits, "thinking.minCompletedWorkUnits", 2, 1000, true);
	number(c.thinking.minSuccessRate, "thinking.minSuccessRate", 0.5, 1);
	number(c.thinking.maxLatencyRatio, "thinking.maxLatencyRatio", 1, 10);
	number(c.cache.minSavingsRatio, "cache.minSavingsRatio", 0, 1);
	number(c.cache.minSavingsUsd, "cache.minSavingsUsd", 0, 1000);
	number(c.cache.minSamples, "cache.minSamples", 2, 1000, true);
	number(c.cache.maxRetryRiskIncrease, "cache.maxRetryRiskIncrease", 0, 1);
	if (c.cache.expectedRemainingRequests !== null)
		number(c.cache.expectedRemainingRequests, "cache.expectedRemainingRequests", 2, 1000, true);
	if (typeof c.fallback.enabled !== "boolean") fail("fallback.enabled");
	number(c.fallback.cooldownMs, "fallback.cooldownMs", 1000, 86400000, true);
	number(c.fallback.maxCooldownMs, "fallback.maxCooldownMs", c.fallback.cooldownMs, 604800000, true);
	number(c.fallback.maxRetries, "fallback.maxRetries", 1, 5, true);
	if (c.fallback.maxTokens !== null)
		number(c.fallback.maxTokens, "fallback.maxTokens", 1, Number.MAX_SAFE_INTEGER, true);
	if (
		c.fallback.sharedCooldownFile !== null &&
		(typeof c.fallback.sharedCooldownFile !== "string" || !c.fallback.sharedCooldownFile.trim())
	)
		fail("fallback.sharedCooldownFile");
	if (!["quiet", "normal", "verbose"].includes(c.diagnostics)) fail("diagnostics");
	return c;
}
function readOptional(path: string): unknown | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error("Cannot read orchestrator configuration.");
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("Orchestrator configuration is not valid JSON.");
	}
}
export function loadConfig(cwd?: string, trusted = false): Config {
	const path = process.env.JEV_ORCHESTRATOR_CONFIG ?? join(getAgentDir(), "jev-orchestrator.json");
	const input = readOptional(path);
	if (input === undefined && process.env.JEV_ORCHESTRATOR_CONFIG)
		throw new Error("Orchestrator configuration file was not found.");
	let config = input === undefined ? structuredClone(DEFAULT_CONFIG) : parseConfig(input);
	if (config.allowProjectOverrides && cwd && trusted) {
		const project = readOptional(join(cwd, ".pi", "jev-orchestrator.json"));
		if (project !== undefined) config = parseConfig(project, config);
	}
	return config;
}
export function cooldownPath(config: Config): string | undefined {
	const path = config.fallback.sharedCooldownFile;
	return path === null ? undefined : isAbsolute(path) ? path : resolve(getAgentDir(), path);
}
