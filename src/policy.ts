import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Config, Rule } from "./config.ts";
import { splitModel } from "./config.ts";
import { type Classification, type Cooldowns, LEVELS, type Pair, type Role } from "./state.ts";

export function onCooldown(provider: string, cooldowns: Cooldowns, now: number): boolean {
	const c = cooldowns[provider];
	return !!c && now < Math.max(c.until, c.notBefore);
}
export function availableModel(registry: ModelRegistry, key: string): Model<Api> | undefined {
	const [provider, id] = splitModel(key);
	const model = registry.find(provider, id);
	return model && model.api !== "pi-virtual" && registry.hasConfiguredAuth(model) ? model : undefined;
}
export function resolveTarget(
	role: Role,
	config: Config,
	registry: ModelRegistry,
	cooldowns: Cooldowns = {},
	now = Date.now(),
): Model<Api> | undefined {
	const t = config.models[role];
	if (!t) return undefined;
	for (const key of [t.preferred, ...t.compatible]) {
		const m = availableModel(registry, key);
		if (m && !onCooldown(m.provider, cooldowns, now)) return m;
	}
	return undefined;
}
export function pairFor(model: Model<Api>, level: Pair["thinkingLevel"]): Pair {
	return { provider: model.provider, id: model.id, thinkingLevel: clampThinkingLevel(model, level) };
}
export function modelFor(pair: Pair, registry: ModelRegistry): Model<Api> {
	const m = availableModel(registry, `${pair.provider}/${pair.id}`);
	if (!m) throw new Error("The selected physical model is unavailable. Run /route new or select a model.");
	return m;
}
function matches(r: Rule, c: Classification): boolean {
	return (
		(!r.category || r.category.includes(c.category)) &&
		(!r.complexity || r.complexity.includes(c.complexity)) &&
		(!r.reasoning || r.reasoning.includes(c.reasoning)) &&
		(!r.risk || r.risk.includes(c.risk)) &&
		(r.multiFile === undefined || r.multiFile === c.multiFile) &&
		(r.verification === undefined || r.verification === c.verification)
	);
}
export function policyChoice(c: Classification, config: Config): Rule {
	const rule = config.policy.find((r) => matches(r, c));
	if (!rule) throw new Error("No routing policy matches this work.");
	return rule;
}
export function chooseTarget(
	c: Classification,
	config: Config,
	registry: ModelRegistry,
	cooldowns: Cooldowns,
	now: number,
): {
	model: Model<Api>;
	pair: Pair;
	reason: string;
	role: Role;
} {
	const rule = policyChoice(c, config);
	// These are the only compatible capability substitutions. Never scan unrelated models.
	const roles: Role[] =
		rule.role === "astra"
			? ["astra", "sol", "terra"]
			: rule.role === "sol"
				? ["sol", "terra"]
				: ["terra", "sol"];
	for (const role of roles) {
		const model = resolveTarget(role, config, registry, cooldowns, now);
		if (!model) continue;
		const level =
			role === "terra" && role !== rule.role && LEVELS.indexOf(rule.thinking) < LEVELS.indexOf("high")
				? "high"
				: rule.thinking;
		const pair = pairFor(model, level);
		return {
			model,
			pair,
			role,
			reason:
				role === rule.role
					? `Policy: ${c.category}, ${c.complexity}; ${role} / ${pair.thinkingLevel}.`
					: `Policy target ${rule.role} unavailable or disabled; compatible ${role} / ${pair.thinkingLevel}.`,
		};
	}
	throw new Error(
		"No authenticated Terra or Sol target is available. Configure an explicit compatible model.",
	);
}
export function roleOf(pair: Pair, config: Config): Role | undefined {
	for (const role of ["terra", "sol", "astra", "fallback"] as const) {
		const t = config.models[role];
		if (t && [t.preferred, ...t.compatible].includes(`${pair.provider}/${pair.id}`)) return role;
	}
	return undefined;
}
