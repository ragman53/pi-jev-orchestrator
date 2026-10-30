import { type AssistantMessage, getSupportedThinkingLevels, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { emptyUsage, knownPrices } from "./cache.ts";
import type { Config } from "./config.ts";
import { resolveTarget } from "./policy.ts";
import {
	CATEGORIES,
	CLASSIFIER_ENTRY,
	type Classification,
	COMPLEXITIES,
	isPair,
	OUTCOME_ENTRY,
	type Pair,
	PERFORMANCE_ENTRY,
	type Role,
	readState,
	samePair,
} from "./state.ts";

export interface ClassifierRecord {
	provider: string;
	model: string;
	stopReason: "stop" | "error" | "aborted";
	timestamp: number;
	usage?: Usage;
	priceKnown: boolean;
}
function add(a: Usage, b: Usage): void {
	for (const k of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) a[k] += b[k];
	for (const k of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) a.cost[k] += b.cost[k];
}
export function usageStats(entries: readonly SessionEntry[]) {
	const physical = new Map<string, { usage: Usage; responses: number; errors: number }>();
	const total = emptyUsage();
	const classifier = emptyUsage();
	let classifierCalls = 0;
	let unknownClassifierPrice = false;
	let warmingTokens = 0;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === CLASSIFIER_ENTRY) {
			const data = entry.data as ClassifierRecord;
			classifierCalls++;
			if (data.usage) add(classifier, data.usage);
			unknownClassifierPrice ||= !data.priceKnown;
			continue;
		}
		let usage: Usage | undefined;
		let key: string | undefined;
		let error = false;
		if (entry.type === "message" && entry.message.role === "assistant") {
			const m = entry.message;
			usage = m.usage;
			key = `${m.provider}/${m.model} / ${m.thinkingLevel ?? "unknown"}`;
			error = m.stopReason === "error";
		} else if (entry.type === "usage") {
			usage = entry.usage;
			key = `${entry.provider}/${entry.model} / ${entry.kind}`;
			if (entry.kind === "cache_warm") warmingTokens += usage.totalTokens;
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			usage = entry.message.usage;
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			usage = entry.usage;
		}
		if (!usage) continue;
		add(total, usage);
		if (!key) continue;
		const row = physical.get(key) ?? { usage: emptyUsage(), responses: 0, errors: 0 };
		add(row.usage, usage);
		row.responses++;
		row.errors += Number(error);
		physical.set(key, row);
	}
	const inputTotal = total.input + total.cacheRead + total.cacheWrite;
	return {
		scope: "All raw session entries, including abandoned branches and compacted history.",
		physical: Object.fromEntries(physical),
		tokens: total,
		cacheHitRatio: inputTotal ? total.cacheRead / inputTotal : null,
		nativeWarmingTokens: warmingTokens,
		classifier: { calls: classifierCalls, usage: classifier, unknownPrice: unknownClassifierPrice },
		taskOutcomes: "Not independently verified. A successful response does not prove task completion.",
	};
}
export interface PerformanceRecord {
	workUnitId: string;
	pair: Pair;
	cohort: Pick<Classification, "category" | "complexity" | "risk">;
	latencyMs: number;
	usage: Usage;
	costKnown: boolean;
	completeWorkUnit?: boolean;
}
export interface OutcomeRecord {
	workUnitId: string;
	outcome: "pass" | "fail";
	source: "user";
}
export function performanceRecord(
	ctx: ExtensionContext,
	message: AssistantMessage,
	latencyMs: number,
): PerformanceRecord | undefined {
	const state = readState(ctx.sessionManager.getBranch());
	const model = ctx.modelRegistry.find(message.provider, message.model);
	if (!state || !model || !message.thinkingLevel) return undefined;
	return {
		workUnitId: state.workUnitId,
		pair: { provider: message.provider, id: message.model, thinkingLevel: message.thinkingLevel },
		cohort: {
			category: state.classification.category,
			complexity: state.classification.complexity,
			risk: state.classification.risk,
		},
		latencyMs,
		usage: message.usage,
		costKnown: knownPrices(model) && message.usage.totalTokens > 0,
		completeWorkUnit: state.measurementVersion === 1,
	};
}
function performance(value: unknown): PerformanceRecord | undefined {
	const r = value as Partial<PerformanceRecord> | undefined;
	if (
		!r ||
		typeof r.workUnitId !== "string" ||
		!isPair(r.pair) ||
		typeof r.costKnown !== "boolean" ||
		!r.cohort ||
		!CATEGORIES.includes(r.cohort.category) ||
		!COMPLEXITIES.includes(r.cohort.complexity) ||
		!["low", "medium", "high"].includes(r.cohort.risk) ||
		typeof r.latencyMs !== "number" ||
		!Number.isFinite(r.latencyMs) ||
		r.latencyMs < 0 ||
		!r.usage ||
		![
			r.usage.input,
			r.usage.output,
			r.usage.cacheRead,
			r.usage.cacheWrite,
			r.usage.totalTokens,
			r.usage.cost?.input,
			r.usage.cost?.output,
			r.usage.cost?.cacheRead,
			r.usage.cost?.cacheWrite,
			r.usage.cost?.total,
		].every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0)
	)
		return undefined;
	return r as PerformanceRecord;
}
export function pairMetrics(
	entries: readonly SessionEntry[],
	pair: Pair,
	cohort?: PerformanceRecord["cohort"],
) {
	const outcomes = new Map<string, OutcomeRecord["outcome"]>();
	const units = new Map<string, PerformanceRecord[]>();
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === PERFORMANCE_ENTRY) {
			const p = performance(entry.data);
			if (p) {
				const records = units.get(p.workUnitId) ?? [];
				records.push(p);
				units.set(p.workUnitId, records);
				// Further work invalidates an earlier completion annotation until the user checks it again.
				outcomes.delete(p.workUnitId);
			}
		} else if (entry.customType === OUTCOME_ENTRY) {
			const o = entry.data as OutcomeRecord | undefined;
			if (o?.source === "user" && typeof o.workUnitId === "string" && ["pass", "fail"].includes(o.outcome))
				outcomes.set(o.workUnitId, o.outcome);
		}
	}
	let completed = 0;
	let passed = 0;
	let pending = 0;
	let mixed = 0;
	let partial = 0;
	let latency = 0;
	let costKnown = true;
	let cost = 0;
	const usage = emptyUsage();
	const observed = emptyUsage();
	let observedResponses = 0;
	let observedLatency = 0;
	let observedCostKnown = true;
	for (const [id, records] of units) {
		if (!records.some((r) => samePair(r.pair, pair))) continue;
		if (
			cohort &&
			!records.every(
				(r) =>
					r.cohort.category === cohort.category &&
					r.cohort.complexity === cohort.complexity &&
					r.cohort.risk === cohort.risk,
			)
		)
			continue;
		for (const r of records.filter((r) => samePair(r.pair, pair))) {
			observedResponses++;
			observedLatency += r.latencyMs;
			observedCostKnown &&= r.costKnown;
			add(observed, r.usage);
		}
		if (!records.every((r) => samePair(r.pair, pair))) {
			mixed++;
			continue;
		}
		if (!records.every((r) => r.completeWorkUnit === true)) {
			partial++;
			continue;
		}
		const outcome = outcomes.get(id);
		if (!outcome) {
			pending++;
			continue;
		}
		completed++;
		passed += Number(outcome === "pass");
		for (const r of records) {
			latency += r.latencyMs;
			costKnown &&= r.costKnown;
			cost += r.usage.cost.total;
			add(usage, r.usage);
		}
	}
	const input = usage.input + usage.cacheRead + usage.cacheWrite;
	const observedInput = observed.input + observed.cacheRead + observed.cacheWrite;
	return {
		observedResponses,
		observedMeanTurnLatencyMs: observedResponses ? observedLatency / observedResponses : null,
		observedCacheHitRatio: observedInput ? observed.cacheRead / observedInput : null,
		observedNativeCostUsd: observedResponses && observedCostKnown ? observed.cost.total : null,
		completedWorkUnits: completed,
		userReportedPasses: passed,
		userReportedFailures: completed - passed,
		userReportedSuccessRate: completed ? passed / completed : null,
		unreportedWorkUnits: pending,
		excludedMixedPairWorkUnits: mixed,
		excludedPartialWorkUnits: partial,
		meanCompletedGenerationMs: completed ? latency / completed : null,
		cacheHitRatio: input ? usage.cacheRead / input : null,
		reportedWorkUnitCostUsd: completed && costKnown ? cost : null,
		costPerReportedSuccessUsd: passed && costKnown ? cost / passed : null,
	};
}
export const COMPARISON_LEVELS = {
	terra: ["high", "xhigh", "max"],
	sol: ["medium", "high", "xhigh", "max"],
	astra: ["high", "max"],
} as const;
function comparison(ctx: ExtensionContext, config: Config) {
	const branch = ctx.sessionManager.getBranch();
	return {
		scope:
			"Active branch; separate model/thinking cohorts. Outcomes are user-reported, not independently verified.",
		latencyNotice:
			"Sum of turn-start to assistant-end durations, including routing/classification and excluding tool execution and user wait time.",
		costNotice:
			"Native generation list-price estimates, including failed reported work units. Shared warming/compaction costs are not attributed to a work unit.",
		rows: Object.entries(COMPARISON_LEVELS).flatMap(([role, levels]) => {
			const model = resolveTarget(role as Exclude<Role, "fallback">, config, ctx.modelRegistry);
			return levels.map((thinkingLevel) => ({
				role,
				thinkingLevel,
				model: model ? `${model.provider}/${model.id}` : null,
				disabled: config.models[role as Exclude<Role, "fallback">] === null,
				available: !!model,
				supported: model ? getSupportedThinkingLevels(model).includes(thinkingLevel) : null,
				metrics: model
					? pairMetrics(branch, { provider: model.provider, id: model.id, thinkingLevel })
					: null,
			}));
		}),
	};
}
export function stats(ctx: ExtensionContext, config: Config) {
	const state = readState(ctx.sessionManager.getBranch());
	const subscriptions = ctx.modelRegistry
		.getAvailable()
		.filter((m) => ctx.modelRegistry.isUsingOAuth(m) && ["openai", "openai-codex"].includes(m.provider))
		.map((m) => m.provider);
	return {
		...usageStats(ctx.sessionManager.getEntries()),
		comparison: comparison(ctx, config),
		branchRouting: state
			? {
					physicalPairChanges: state.switches,
					fallbacks: state.fallbacks,
					retries: state.totalRetries,
					classifierCalls: state.classifierCalls,
					classifierFailures: state.classifierErrors,
					history: state.history,
				}
			: null,
		costNotice:
			"Native catalog estimates, not invoices. Subscription list prices are comparison proxies. Exact remaining quota is unknown.",
		subscriptionProviders: [...new Set(subscriptions)],
		classifierAccounting:
			"Classifier usage is separate from Pi native totals. Zero catalog prices do not establish free usage.",
	};
}
