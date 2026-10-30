import { type Api, calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";
import { roleOf } from "./policy.ts";
import { type Classification, LEVELS, modelKey, type Pair, samePair } from "./state.ts";

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
function cost(model: Model<Api>, input: number, output: number, cached: boolean): number {
	const u = { ...emptyUsage(), input: cached ? 0 : input, cacheRead: cached ? input : 0, output };
	return calculateCost(model, u).total;
}
export function knownPrices(model: Model<Api>): boolean {
	return (
		[model.cost.input, model.cost.output].every((x) => Number.isFinite(x) && x > 0) &&
		Number.isFinite(model.cost.cacheRead) &&
		model.cost.cacheRead >= 0
	);
}
function observations(branch: readonly SessionEntry[], pair: Pair) {
	let count = 0;
	let failures = 0;
	let output = 0;
	let latest = 0;
	for (const e of branch) {
		if (e.type !== "message" || e.message.role !== "assistant") continue;
		const m = e.message;
		if (
			m.provider !== pair.provider ||
			m.model !== pair.id ||
			m.thinkingLevel !== pair.thinkingLevel ||
			m.stopReason === "aborted"
		)
			continue;
		if (m.stopReason === "error") {
			failures++;
			continue;
		}
		if (m.usage.totalTokens <= 0) continue;
		count++;
		output += m.usage.output;
		latest = m.timestamp;
	}
	return {
		count,
		failureRate: failures / Math.max(1, failures + count),
		output: output / Math.max(1, count),
		latest,
	};
}
export interface SwitchDecision {
	switch: boolean;
	reason: string;
	estimatedCacheLossUsd?: number;
	estimatedSavingsUsd?: number;
}
export function considerSwitch(args: {
	current: Pair;
	candidate: Pair;
	currentModel: Model<Api>;
	candidateModel: Model<Api>;
	classification: Classification;
	config: Config;
	workGap: number;
	branch: readonly SessionEntry[];
	contextTokens: number | null;
	now: number;
	thinkingCacheVerified?: boolean;
}): SwitchDecision {
	const {
		current,
		candidate,
		currentModel,
		candidateModel,
		classification: c,
		config,
		workGap,
		branch,
		contextTokens,
		now,
	} = args;
	const stay = (reason: string): SwitchDecision => ({ switch: false, reason });
	if (samePair(current, candidate)) return stay("Policy agrees with the active physical pair.");
	const sameModel = modelKey(current) === modelKey(candidate);
	if (sameModel && !args.thinkingCacheVerified)
		return stay(
			"Thinking-level cache preservation is unverified for this authentication; keep the active level.",
		);
	if (c.confidence < config.classifier.minConfidence || c.source !== "jev")
		return stay("Uncertain classification; preserve the active cache and thinking level.");
	if (workGap < config.sticky.minWorkUnitsBetweenSwitches)
		return stay("Switch hysteresis: too few work units since the last change.");

	const old = observations(branch, current);
	const next = observations(branch, candidate);
	const tier = { terra: 0, sol: 1, astra: 2, fallback: -1 };
	const currentRole = roleOf(current, config);
	const candidateRole = roleOf(candidate, config);
	const stronger =
		currentRole !== undefined &&
		candidateRole !== undefined &&
		(tier[candidateRole] > tier[currentRole] ||
			(modelKey(current) === modelKey(candidate) &&
				LEVELS.indexOf(candidate.thinkingLevel) > LEVELS.indexOf(current.thinkingLevel)));
	const demanding =
		c.complexity === "high" || c.complexity === "exceptional" || c.category === "architecture";
	const capability =
		stronger &&
		demanding &&
		c.confidence >= Math.max(0.85, config.classifier.minConfidence) &&
		(c.reasoning === "deep" || c.risk === "high" || c.multiFile || c.category === "architecture");
	// A new, demonstrably harder work unit can justify a cold cache without invented dollar savings.
	if (capability) {
		const estimate = sameModel
			? 0
			: contextTokens === null || !knownPrices(currentModel) || !knownPrices(candidateModel)
				? undefined
				: Math.max(
						0,
						cost(candidateModel, contextTokens, 0, false) - cost(currentModel, contextTokens, 0, true),
					);
		return {
			switch: true,
			reason: sameModel
				? "New work requires more reasoning; the native append-only effort path preserves the prefix."
				: "New work requires stronger capability; accept a cold physical-model cache.",
			estimatedCacheLossUsd: estimate,
		};
	}
	if (!knownPrices(currentModel) || !knownPrices(candidateModel))
		return stay("Catalog pricing is incomplete; optional savings cannot be estimated.");
	const remaining = config.cache.expectedRemainingRequests;
	if (remaining === null || contextTokens === null)
		return stay(
			"Remaining work or context size is unknown; optional switching has no defensible cost estimate.",
		);
	if (old.count < config.cache.minSamples || next.count < config.cache.minSamples)
		return stay("Too few observed physical-pair samples to compare completion costs.");
	if (next.failureRate > old.failureRate + config.cache.maxRetryRiskIncrease)
		return stay("Observed candidate retry risk is too high.");
	const retention = process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
	const lifetime = currentModel.promptCache?.[retention];
	if (!lifetime) return stay("Cache lifetime is unknown; preserve the active pair.");
	const warm = now - old.latest < lifetime * 1000;
	const currentCost =
		(cost(currentModel, contextTokens, old.output, warm) * remaining) / Math.max(0.1, 1 - old.failureRate);
	const reconstruction = sameModel
		? 0
		: Math.max(
				0,
				cost(candidateModel, contextTokens, 0, false) - cost(candidateModel, contextTokens, 0, true),
			);
	const candidateCost =
		(cost(candidateModel, contextTokens, next.output, true) * remaining + reconstruction) /
		Math.max(0.1, 1 - next.failureRate);
	const savings = currentCost - candidateCost;
	const allow =
		savings >= config.cache.minSavingsUsd && savings >= currentCost * config.cache.minSavingsRatio;
	return {
		switch: allow,
		reason: allow
			? "Estimated remaining-work savings exceed cache reconstruction and switch hysteresis."
			: "Estimated savings do not justify reconstructing the physical-model cache.",
		estimatedCacheLossUsd: reconstruction,
		estimatedSavingsUsd: savings,
	};
}
