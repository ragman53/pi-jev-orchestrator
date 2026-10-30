import { type Api, type AssistantMessage, calculateCost, type Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { considerSwitch, emptyUsage } from "../src/cache.ts";
import { deterministicClassification } from "../src/classifier.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { pairFor, policyChoice } from "../src/policy.ts";
import {
	type Category,
	type Classification,
	type Complexity,
	modelKey,
	type Pair,
	samePair,
} from "../src/state.ts";

type Strategy = "A: static Terra High" | "B: per-request switching" | "C: cache-aware sticky";
export const STRATEGIES: Strategy[] = [
	"A: static Terra High",
	"B: per-request switching",
	"C: cache-aware sticky",
];
interface Unit {
	category: Category;
	complexity: Complexity;
	requests: number;
	context: number;
	terraRetries: number;
	solOutputMultiplier: number;
}
export const WORKLOADS: Record<string, Unit[]> = {
	routine: [
		{
			category: "standard implementation",
			complexity: "medium",
			requests: 6,
			context: 40000,
			terraRetries: 0,
			solOutputMultiplier: 1,
		},
	],
	"hard debugging with corrections": [
		{
			category: "debugging",
			complexity: "high",
			requests: 8,
			context: 80000,
			terraRetries: 2,
			solOutputMultiplier: 1,
		},
	],
	"optimistic Terra, costly Sol reasoning": [
		{
			category: "debugging",
			complexity: "high",
			requests: 8,
			context: 60000,
			terraRetries: 0,
			solOutputMultiplier: 4,
		},
	],
};
function model(id: string, rates: Model<Api>["cost"]): Model<Api> {
	return {
		provider: "openai",
		id,
		name: id,
		api: "openai-responses",
		baseUrl: "https://benchmark.invalid",
		reasoning: true,
		thinkingLevelMap: {
			off: id === "gpt-5.6-terra" ? "none" : null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
		input: ["text"],
		contextWindow: 272000,
		maxTokens: 128000,
		cost: rates,
	};
}
// Audited list-price snapshot. Subscription use is not billed at these per-request amounts.
const terra = model("gpt-5.6-terra", { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 });
const sol = model("gpt-6.1-sol", { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
function physical(pair: Pair): Model<Api> {
	return pair.id === terra.id ? terra : sol;
}
export function simulate(strategy: Strategy, units: Unit[]) {
	const manager = SessionManager.inMemory();
	const config = structuredClone(DEFAULT_CONFIG);
	let current: Pair | undefined;
	let lastPair: Pair | undefined;
	let lastSwitchUnit = -100;
	let modelSwitches = 0;
	let pairChanges = 0;
	let simulatedRetries = 0;
	let reconstructionCost = 0;
	let totalCost = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let now = 1000000;
	const unitCosts: number[] = [];
	for (const [unitIndex, unit] of units.entries()) {
		const startCost = totalCost;
		const classification: Classification = {
			...deterministicClassification(),
			category: unit.category,
			complexity: unit.complexity,
			source: "jev",
			confidence: 0.95,
			reasoning: unit.complexity === "high" ? "deep" : "moderate",
			multiFile: true,
			verification: true,
		};
		if (strategy === "C: cache-aware sticky") {
			const rule = policyChoice(classification, config);
			const candidate = pairFor(rule.role === "terra" ? terra : sol, rule.thinking);
			if (!current) current = candidate;
			else if (
				considerSwitch({
					current,
					candidate,
					currentModel: physical(current),
					candidateModel: physical(candidate),
					classification,
					config,
					workGap: unitIndex - lastSwitchUnit,
					branch: manager.getBranch(),
					contextTokens: unit.context,
					now,
				}).switch
			) {
				current = candidate;
				lastSwitchUnit = unitIndex;
			}
		}
		for (let step = 0; step < unit.requests; step++) {
			const selected =
				strategy === "A: static Terra High"
					? pairFor(terra, "high")
					: strategy === "B: per-request switching"
						? pairFor(step % 2 === 0 ? sol : terra, step % 2 === 0 ? "high" : "medium")
						: (current as Pair);
			const m = physical(selected);
			const retries = m.id === terra.id && step === 2 ? unit.terraRetries : 0;
			simulatedRetries += retries;
			for (let attempt = 0; attempt <= retries; attempt++) {
				if (lastPair && modelKey(lastPair) !== modelKey(selected)) modelSwitches++;
				if (lastPair && !samePair(lastPair, selected)) pairChanges++;
				const warm = !!lastPair && samePair(lastPair, selected);
				const context = unit.context + step * 3000;
				const prefix = Math.floor(context * 0.8);
				const output = 2000 * (m.id === sol.id ? unit.solOutputMultiplier : 1);
				const usage = {
					...emptyUsage(),
					input: warm ? context - prefix : context,
					cacheRead: warm ? prefix : 0,
					output,
					totalTokens: context + output,
				};
				usage.cost = calculateCost(m, usage);
				if (!warm) {
					const hypotheticalWarm = {
						...usage,
						cost: { ...usage.cost },
						input: context - prefix,
						cacheRead: prefix,
					};
					reconstructionCost += usage.cost.total - calculateCost(m, hypotheticalWarm).total;
				}
				totalCost += usage.cost.total;
				inputTokens += context;
				outputTokens += output;
				const message: AssistantMessage = {
					role: "assistant",
					api: m.api,
					provider: m.provider,
					model: m.id,
					thinkingLevel: selected.thinkingLevel,
					content: [],
					usage,
					stopReason: "stop",
					timestamp: now,
				};
				manager.appendMessage(message);
				now += 1000;
				lastPair = selected;
			}
		}
		unitCosts.push(totalCost - startCost);
	}
	return {
		strategy,
		modelSwitches,
		pairChanges,
		reconstructionCost,
		totalCost,
		simulatedRetries,
		inputTokens,
		outputTokens,
		unitCosts,
	};
}
export function benchmark() {
	return {
		notice: "Synthetic estimates, not production results or subscription bills.",
		assumptions: [
			"Stable pairs reuse an 80% prompt prefix. Every pair change is cold. Requests finish within cache lifetime.",
			"Context grows 3000 tokens per request. Base output includes reasoning and is 2000 tokens.",
			"Terra retries and Sol output multipliers are explicit scenario inputs, not measured capability claims.",
			"Cold reconstruction is a component of total cost, not an extra amount to add again.",
			"No classifier-price estimate is fabricated. Work-unit classification latency and cost are excluded.",
		],
		workloads: Object.fromEntries(
			Object.entries(WORKLOADS).map(([name, units]) => [name, STRATEGIES.map((s) => simulate(s, units))]),
		),
	};
}
if (import.meta.main) console.log(JSON.stringify(benchmark(), null, 2));
