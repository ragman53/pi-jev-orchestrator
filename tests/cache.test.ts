import { expect, test } from "bun:test";
import { calculateCost } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { considerSwitch, emptyUsage } from "../src/cache.ts";
import { deterministicClassification } from "../src/classifier.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { usageStats } from "../src/stats.ts";
import { assistant, pair, sol, terra } from "./helpers.ts";

function setup() {
	const currentModel = structuredClone(sol);
	const candidateModel = structuredClone(terra);
	currentModel.cost = { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 };
	candidateModel.cost = { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 };
	currentModel.promptCache = { short: 300 };
	candidateModel.promptCache = { short: 300 };
	const manager = SessionManager.inMemory();
	const now = 1000000;
	for (const m of [currentModel, candidateModel]) {
		for (let i = 0; i < 3; i++) {
			const message = assistant(m, "high");
			message.timestamp = now - 1000;
			message.usage = { ...emptyUsage(), cacheRead: 100000, output: 1000, totalTokens: 101000 };
			message.usage.cost = calculateCost(m, message.usage);
			manager.appendMessage(message);
		}
	}
	const config = structuredClone(DEFAULT_CONFIG);
	config.cache.expectedRemainingRequests = 20;
	return {
		current: pair(currentModel),
		candidate: pair(candidateModel),
		currentModel,
		candidateModel,
		classification: { ...deterministicClassification(), source: "jev" as const, confidence: 0.95 },
		config,
		workGap: 10,
		branch: manager.getBranch(),
		contextTokens: 100000,
		now,
	};
}
test("optional switching includes cold reconstruction and output/reasoning cost", () => {
	const args = setup();
	args.contextTokens = 10000000;
	args.config.cache.expectedRemainingRequests = 2;
	const decision = considerSwitch(args);
	expect(decision.switch).toBe(false);
	expect(decision.estimatedCacheLossUsd).toBeGreaterThan(0);
	expect(decision.estimatedSavingsUsd).toBeLessThan(0);
});
test("measured, sufficiently large remaining-work savings can permit a boundary switch", () => {
	const decision = considerSwitch(setup());
	expect(decision.switch).toBe(true);
	expect(decision.estimatedSavingsUsd).toBeGreaterThan(0);
	expect(decision.estimatedCacheLossUsd).toBeGreaterThan(0);
});
test("unknown remaining work, cache lifetime, or sparse samples prevents optional switching", () => {
	const unknown = setup();
	unknown.config.cache.expectedRemainingRequests = null;
	expect(considerSwitch(unknown).switch).toBe(false);
	const cache = setup();
	delete cache.currentModel.promptCache;
	expect(considerSwitch(cache).reason).toContain("unknown");
	const sparse = setup();
	sparse.branch = [];
	expect(considerSwitch(sparse).reason).toContain("Too few");
});
test("zero catalog prices mean unknown cost rather than a free optional target", () => {
	const args = setup();
	args.candidateModel.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	expect(considerSwitch(args).switch).toBe(false);
	expect(considerSwitch(args).reason).toContain("incomplete");
});
test("switch hysteresis and retry-risk protection take precedence over small price differences", () => {
	const args = setup();
	args.workGap = 0;
	expect(considerSwitch(args).switch).toBe(false);
	args.workGap = 10;
	args.config.cache.minSavingsUsd = 100;
	expect(considerSwitch(args).switch).toBe(false);
});
test("usage reporting uses raw native entries without inferring task completion", () => {
	const args = setup();
	const stats = usageStats(args.branch);
	expect(stats.tokens.cacheRead).toBe(600000);
	expect(stats.cacheHitRatio).toBe(1);
	expect(stats.taskOutcomes).toContain("Not independently verified");
	expect(Object.keys(stats.physical)).toHaveLength(2);
});
