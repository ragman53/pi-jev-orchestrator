import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";
import { pairFor } from "./policy.ts";
import { type Classification, LEVELS, modelKey, type Pair } from "./state.ts";
import { pairMetrics } from "./stats.ts";

export interface ThinkingCacheAssessment {
	verified: boolean;
	reason: string;
}
const unverified = (reason: string): ThinkingCacheAssessment => ({ verified: false, reason });
/** Verify the documented native wire path, not a guarantee that the remote cache is still warm. */
export async function thinkingCacheAssessment(
	model: Model<Api>,
	registry: ModelRegistry,
): Promise<ThinkingCacheAssessment> {
	if (
		model.provider !== "openai" ||
		model.api !== "openai-responses" ||
		model.baseUrl !== "https://api.openai.com/v1"
	)
		return unverified("No verified append-only effort path for this provider/API/endpoint.");
	if (registry.isUsingOAuth(model))
		return unverified(
			"ChatGPT OAuth rejects configuration_update; top-level effort changes can invalidate the prompt prefix.",
		);
	if (
		!model.compat ||
		!("supportsMidConvoEffort" in model.compat) ||
		model.compat.supportsMidConvoEffort !== true
	)
		return unverified(
			"The authenticated model registry does not declare native mid-conversation effort support.",
		);
	if (
		registry.getRegisteredProviderConfig?.(model.provider)?.streamSimple ||
		registry.getRegisteredNativeProvider?.(model.provider)
	)
		return unverified("A custom provider transport is not covered by the native cache verification.");
	try {
		const auth = await registry.getApiKeyAndHeaders(model);
		if (
			!auth.ok ||
			!auth.apiKey?.startsWith("sk-") ||
			(auth.baseUrl ?? model.baseUrl) !== "https://api.openai.com/v1" ||
			Object.keys(auth.headers ?? {}).some((k) => k.toLowerCase() === "authorization")
		)
			return unverified("The resolved authentication is not the verified direct OpenAI API-key path.");
	} catch {
		return unverified("Request authentication could not be verified without guessing cache behavior.");
	}
	return {
		verified: true,
		reason:
			"OpenAI documents append-only configuration_update; Pi's native API-key path keeps request-level effort fixed.",
	};
}
export async function verifiedThinkingChange(
	current: Pair,
	model: Model<Api>,
	registry: ModelRegistry,
	branch: readonly SessionEntry[],
): Promise<ThinkingCacheAssessment> {
	const assessment = await thinkingCacheAssessment(model, registry);
	if (!assessment.verified) return assessment;
	const previous = branch.findLast(
		(e) =>
			e.type === "message" &&
			e.message.role === "assistant" &&
			e.message.provider === current.provider &&
			e.message.model === current.id &&
			e.message.stopReason !== "error" &&
			e.message.stopReason !== "aborted",
	);
	const mapped = model.thinkingLevelMap?.[current.thinkingLevel];
	if (
		previous?.type !== "message" ||
		previous.message.role !== "assistant" ||
		previous.message.thinkingLevel !== current.thinkingLevel ||
		typeof mapped !== "string" ||
		previous.message.providerThinkingLevel !== mapped
	)
		return unverified(
			"The current prefix has no native append-only effort provenance; keep the existing level.",
		);
	return assessment;
}
export async function assertVerifiedThinkingChange(
	current: Pair,
	candidate: Pair,
	model: Model<Api>,
	registry: ModelRegistry,
	branch: readonly SessionEntry[],
): Promise<void> {
	if (modelKey(current) !== modelKey(candidate) || current.thinkingLevel === candidate.thinkingLevel) return;
	const assessment = await verifiedThinkingChange(current, model, registry, branch);
	if (!assessment.verified)
		throw new Error(
			`Thinking changes are not verified to preserve this active cache. ${assessment.reason} Run /route new to select a fresh pair.`,
		);
}
/** Consider supported higher levels through max before an otherwise justified physical switch. */
export function considerThinkingEscalation(args: {
	current: Pair;
	currentModel: Model<Api>;
	candidate: Pair;
	classification: Classification;
	config: Config;
	branch: readonly SessionEntry[];
	assessment: ThinkingCacheAssessment;
}): { pair?: Pair; reason: string } {
	const { current, currentModel, candidate, classification, config, branch, assessment } = args;
	const levels = getSupportedThinkingLevels(currentModel).filter(
		(level) => LEVELS.indexOf(level) > LEVELS.indexOf(current.thinkingLevel),
	);
	const considered = levels.length
		? levels.join(", ")
		: "none (already at the registry's highest supported level)";
	const prefix = `Current-model escalation considered: ${considered}.`;
	if (!config.thinking.preferCurrentModel) return { reason: `${prefix} Preference is disabled.` };
	if (!assessment.verified) return { reason: `${prefix} Not permitted: ${assessment.reason}` };
	const baseline = pairMetrics(branch, candidate, classification);
	const sufficient = (m: ReturnType<typeof pairMetrics>) =>
		m.completedWorkUnits >= config.thinking.minCompletedWorkUnits &&
		m.userReportedSuccessRate !== null &&
		m.userReportedSuccessRate >= config.thinking.minSuccessRate &&
		m.costPerReportedSuccessUsd !== null &&
		m.meanCompletedGenerationMs !== null &&
		m.cacheHitRatio !== null;
	if (!sufficient(baseline))
		return {
			reason: `${prefix} Insufficient comparable completion/latency/cache/cost evidence for the policy target.`,
		};
	const alternatives = levels
		.map((level) => {
			const pair = pairFor(currentModel, level);
			return { pair, metrics: pairMetrics(branch, pair, classification) };
		})
		.filter(
			({ metrics: m }) =>
				sufficient(m) &&
				(m.userReportedSuccessRate ?? 0) >= (baseline.userReportedSuccessRate ?? 1) &&
				(m.costPerReportedSuccessUsd ?? Infinity) <= (baseline.costPerReportedSuccessUsd ?? -1) &&
				(m.meanCompletedGenerationMs ?? Infinity) <=
					Math.max(1, baseline.meanCompletedGenerationMs ?? 0) * config.thinking.maxLatencyRatio &&
				(m.cacheHitRatio ?? 0) >= (baseline.cacheHitRatio ?? 1),
		)
		.sort(
			(a, b) =>
				(a.metrics.costPerReportedSuccessUsd ?? Infinity) -
					(b.metrics.costPerReportedSuccessUsd ?? Infinity) ||
				(a.metrics.meanCompletedGenerationMs ?? Infinity) - (b.metrics.meanCompletedGenerationMs ?? Infinity),
		);
	const best = alternatives[0];
	return best
		? {
				pair: best.pair,
				reason: `${prefix} Prefer ${best.pair.thinkingLevel}: comparable user-reported outcomes, bounded latency, cache reuse, and total generation cost support staying on the current model.`,
			}
		: {
				reason: `${prefix} No verified higher level has sufficient comparable completion, latency, cache, and cost evidence.`,
			};
}
