import type { AssistantMessage, ClassifierResult, Message } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { considerSwitch } from "./cache.ts";
import { classifyWork, currentUser, deterministicClassification, explicitBoundary } from "./classifier.ts";
import type { Config } from "./config.ts";
import {
	assertFallbackBudget,
	detectFailure,
	mergeCooldowns,
	nextCooldown,
	readCooldowns,
	saveCooldown,
} from "./fallback.ts";
import {
	availableModel,
	chooseTarget,
	modelFor,
	onCooldown,
	pairFor,
	resolveTarget,
	roleOf,
} from "./policy.ts";
import {
	checkedState,
	latestPhysical,
	latestRecovery,
	modelKey,
	type Pair,
	type RouteState,
	readControl,
	readState,
	samePair,
} from "./state.ts";

import {
	assertVerifiedThinkingChange,
	considerThinkingEscalation,
	verifiedThinkingChange,
} from "./thinking.ts";

export type Request = ModelRouteRequest<RouteState>;
export interface RouterServices {
	now?: () => number;
	recordClassification?: (result: ClassifierResult) => void;
	notify?: (message: string, ctx: ExtensionContext) => void;
}

function generationKey(messages: readonly Message[]): string {
	const success = messages.findLast(
		(m) => m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted",
	);
	return `${currentUser(messages).key}:${success?.timestamp ?? "initial"}`;
}
function routed(pair: Pair, ctx: ExtensionContext, state?: RouteState): ModelRoute<RouteState> {
	const model = modelFor(pair, ctx.modelRegistry);
	return { model, thinkingLevel: pair.thinkingLevel, state };
}
function change(state: RouteState, pair: Pair, why: string, now: number, estimate?: number): RouteState {
	const switched = !samePair(state.selected, pair);
	const next = {
		...state,
		selected: pair,
		why,
		switches: state.switches + Number(switched),
		lastSwitchWorkIndex: switched ? state.workIndex : state.lastSwitchWorkIndex,
	};
	return {
		...next,
		history: [
			...state.history,
			{
				at: now,
				workUnitId: state.workUnitId,
				selected: pair,
				reason: why,
				category: state.classification.category,
				complexity: state.classification.complexity,
				confidence: state.classification.confidence,
				estimatedCacheLossUsd: estimate,
			},
		].slice(-20),
	};
}
function initial(pair: Pair, now: number): RouteState {
	return {
		version: 1,
		workUnitId: crypto.randomUUID(),
		workIndex: 0,
		selected: pair,
		classification: deterministicClassification(),
		sticky: true,
		fallback: false,
		why: "",
		boundaryToken: "",
		requestKey: "",
		lastSwitchWorkIndex: -100,
		switches: 0,
		fallbacks: 0,
		classifierCalls: 0,
		classifierErrors: 0,
		classifierUnavailableUntil: 0,
		retryKey: "",
		retryCount: 0,
		totalRetries: 0,
		cooldowns: {},
		history: [],
		startedAt: now,
	};
}
export function eligibleGpt(
	message: Pick<AssistantMessage, "provider" | "model">,
	ctx: ExtensionContext,
): boolean {
	if (message.provider === "openai-codex") return true;
	const model = ctx.modelRegistry.find(message.provider, message.model);
	return message.provider === "openai" && !!model && ctx.modelRegistry.isUsingOAuth(model);
}
export async function route(
	request: Request,
	ctx: ExtensionContext,
	config: Config,
	services: RouterServices = {},
): Promise<ModelRoute<RouteState>> {
	if (request.signal?.aborted) throw new Error("Routing cancelled.");
	const now = services.now?.() ?? Date.now();
	const branch = ctx.sessionManager.getBranch();
	// Direct calls never classify, consume commands, or write persistent routing state.
	if (request.reason === "direct") {
		const branchState = readState(branch);
		const previous = request.previous
			? pairFor(request.previous.model, request.previous.thinkingLevel ?? request.thinkingLevel)
			: undefined;
		const pair = branchState?.selected ?? previous ?? latestPhysical(branch);
		if (pair) {
			if (branchState && onCooldown(pair.provider, branchState.cooldowns, now)) {
				const fallback = resolveTarget("fallback", config, ctx.modelRegistry);
				if (!config.fallback.enabled || !fallback)
					throw new Error("The active provider is on cooldown; no direct-operation fallback is available.");
				assertFallbackBudget(config, ctx.sessionManager.getEntries());
				return routed(pairFor(fallback, pair.thinkingLevel), ctx);
			}
			if (branchState?.fallback) assertFallbackBudget(config, ctx.sessionManager.getEntries());
			return routed(pair, ctx);
		}
		const selected = chooseTarget(deterministicClassification(), config, ctx.modelRegistry, {}, now);
		return routed(selected.pair, ctx);
	}

	const control = readControl(branch, config.enabled);
	const resetting = control.resetToken !== undefined && control.resetToken !== request.state?.resetToken;
	let baseline: RouteState | undefined;
	if (resetting) {
		try {
			baseline = checkedState(request.state);
		} catch {
			/* An explicit reset also repairs older schemas. */
		}
	} else baseline = checkedState(request.state);
	const state = resetting ? undefined : baseline;
	const user = currentUser(request.messages);
	const old = state;
	const recovery = latestRecovery(branch);
	const pending = !resetting && recovery && recovery.id !== state?.handledRecoveryId ? recovery : undefined;
	const failure =
		request.reason === "retry" && request.failed
			? detectFailure(request.failed.message, eligibleGpt(request.failed.message, ctx))
			: undefined;
	const quota =
		pending?.data ??
		(failure?.kind === "quota" && request.failed
			? {
					provider: request.failed.model.provider,
					model: request.failed.model.id,
					thinkingLevel:
						request.failed.thinkingLevel ?? state?.selected.thinkingLevel ?? request.thinkingLevel,
					notBefore: failure.notBefore,
				}
			: undefined);
	const retryKey = generationKey(request.messages);
	if (quota) {
		if (!config.fallback.enabled)
			throw new Error("GPT usage is exhausted and orchestrator fallback is disabled.");
		if (state?.fallback)
			throw new Error(
				"Fallback recovery was already attempted for this work unit. Select a model or start a new work unit.",
			);
		const failedPair: Pair = {
			provider: quota.provider,
			id: quota.model,
			thinkingLevel: quota.thinkingLevel,
		};
		let next = state ?? initial(failedPair, now);
		const count = next.retryKey === retryKey ? next.retryCount + 1 : 1;
		if (count > config.fallback.maxRetries) throw new Error("The orchestrator retry limit was reached.");
		const cooldowns = mergeCooldowns(next.cooldowns, readCooldowns(config));
		const cooldown = nextCooldown(cooldowns[quota.provider], config, now, quota.notBefore);
		const saved = saveCooldown(config, quota.provider, cooldown);
		const fallback = resolveTarget("fallback", config, ctx.modelRegistry);
		if (!fallback)
			throw new Error(
				"GPT usage is exhausted. The configured DeepSeek fallback is not authenticated or available.",
			);
		assertFallbackBudget(config, ctx.sessionManager.getEntries());
		const pair = pairFor(fallback, quota.thinkingLevel);
		next = {
			...next,
			fallback: true,
			fallbacks: next.fallbacks + 1,
			cooldowns: { ...cooldowns, [quota.provider]: cooldown },
			retryKey,
			retryCount: count,
			totalRetries: next.totalRetries + 1,
			handledRecoveryId: pending?.id ?? next.handledRecoveryId,
		};
		next = change(
			next,
			pair,
			"Confirmed GPT subscription exhaustion; continue this work unit on the fallback.",
			now,
		);
		services.notify?.(
			`GPT usage limit reached. Continuing on ${modelKey(pair)} / ${pair.thinkingLevel} for this work unit.${saved ? "" : " Shared cooldown could not be saved; branch cooldown remains active."}`,
			ctx,
		);
		return routed(pair, ctx, next);
	}

	if (request.reason === "retry") {
		if (!state && !request.failed)
			throw new Error("The prior routing request failed. No safe physical retry target is known.");
		const pair = request.failed
			? pairFor(
					request.failed.model,
					request.failed.thinkingLevel ?? state?.selected.thinkingLevel ?? request.thinkingLevel,
				)
			: state?.selected;
		if (!pair) throw new Error("No physical retry target is available.");
		let next = state ?? initial(pair, now);
		const count = next.retryKey === retryKey ? next.retryCount + 1 : 1;
		if (count > config.fallback.maxRetries)
			throw new Error("The orchestrator retry limit was reached. No further model request was sent.");
		if (next.fallback) assertFallbackBudget(config, ctx.sessionManager.getEntries());
		next = { ...next, retryKey, retryCount: count, totalRetries: next.totalRetries + 1 };
		if (!samePair(next.selected, pair))
			next = change(next, pair, "Preserve the failed physical pair for a native retry.", now);
		return routed(pair, ctx, next);
	}

	if (request.reason === "continuation") {
		const previous = request.previous;
		const pair = previous
			? pairFor(
					previous.model,
					previous.thinkingLevel ?? state?.selected.thinkingLevel ?? request.thinkingLevel,
				)
			: state?.selected;
		if (!pair) {
			// A custom message can start a run before any user request. Do not classify it.
			return routed(
				chooseTarget(deterministicClassification(), config, ctx.modelRegistry, {}, now).pair,
				ctx,
			);
		}
		if (state?.fallback) assertFallbackBudget(config, ctx.sessionManager.getEntries());
		return routed(
			pair,
			ctx,
			state && !samePair(pair, state.selected)
				? change(state, pair, "Preserve the latest successful physical pair for a continuation.", now)
				: state,
		);
	}

	const manualBoundary = control.boundaryToken !== (state?.boundaryToken ?? "");
	const newUnit = !state || manualBoundary || (user.key !== state.requestKey && explicitBoundary(user.text));
	if (state && !newUnit && !control.overrideToken && control.mode === "auto") {
		if (state.fallback) assertFallbackBudget(config, ctx.sessionManager.getEntries());
		return routed(state.selected, ctx, state);
	}
	const overridePending = control.override && control.overrideToken !== state?.overrideToken;
	if (
		state &&
		!newUnit &&
		!overridePending &&
		(control.mode !== "lock" || (control.locked && samePair(control.locked, state.selected)))
	) {
		if (state.fallback) assertFallbackBudget(config, ctx.sessionManager.getEntries());
		return routed(state.selected, ctx, state);
	}
	const cooldowns = newUnit
		? mergeCooldowns(baseline?.cooldowns ?? {}, readCooldowns(config))
		: (state?.cooldowns ?? {});
	const prior =
		state?.selected ??
		(request.previous
			? pairFor(request.previous.model, request.previous.thinkingLevel ?? request.thinkingLevel)
			: latestPhysical(branch));
	let selected = overridePending ? control.override : control.mode === "lock" ? control.locked : undefined;
	let why = selected ? "Explicit user model/thinking override." : "";
	let classification = newUnit
		? deterministicClassification()
		: (state?.classification ?? deterministicClassification());
	let calls = 0;
	let errors = 0;
	if (newUnit && control.mode === "auto" && !selected && now >= (state?.classifierUnavailableUntil ?? 0)) {
		const attempt = await classifyWork(
			ctx.modelRegistry,
			config,
			user.text,
			state?.classification,
			request.signal,
			services.recordClassification,
		);
		classification = attempt.classification;
		calls = Number(attempt.called);
		errors = Number(attempt.failed);
	}
	if (control.mode === "off" && !selected) {
		selected =
			prior ?? chooseTarget(deterministicClassification(), config, ctx.modelRegistry, cooldowns, now).pair;
		why = "Automatic selection is disabled; retain the physical pair.";
	}
	let fallback = state?.fallback && !newUnit;
	let estimate: number | undefined;
	if (!selected) {
		try {
			const uncertain =
				classification.source !== "jev" || classification.confidence < config.classifier.minConfidence;
			const candidate = chooseTarget(
				uncertain ? deterministicClassification() : classification,
				config,
				ctx.modelRegistry,
				cooldowns,
				now,
			);
			selected = candidate.pair;
			why = uncertain
				? `Uncertain or unavailable classification; use the conservative policy. ${candidate.reason}`
				: candidate.reason;
		} catch (error) {
			const blockedPrimary = ["terra", "sol"].some((role) => {
				const m = resolveTarget(role as "terra" | "sol", config, ctx.modelRegistry);
				return m && onCooldown(m.provider, cooldowns, now);
			});
			if (!blockedPrimary || !config.fallback.enabled) throw error;
			const m = resolveTarget("fallback", config, ctx.modelRegistry);
			if (!m) throw new Error("GPT remains on cooldown and the DeepSeek fallback is unavailable.");
			selected = pairFor(m, prior?.thinkingLevel ?? "high");
			why = "Provider cooldown is active; keep the fallback at this safe boundary.";
			fallback = true;
		}
		// Only an active routed unit owns sticky cache protection. Physical history alone
		// must not pin first activation or an explicit reset to a previously selected model.
		if (!state && prior && !fallback)
			why +=
				" No active routed work unit; select a fresh policy pair instead of inheriting physical history.";
		const priorRole = prior ? roleOf(prior, config) : undefined;
		const currentModel = prior ? availableModel(ctx.modelRegistry, modelKey(prior)) : undefined;
		if (
			state &&
			prior &&
			currentModel &&
			priorRole &&
			priorRole !== "fallback" &&
			!onCooldown(prior.provider, cooldowns, now) &&
			!fallback &&
			!state?.fallback
		) {
			const assessment = samePair(prior, selected)
				? { verified: false, reason: "No thinking change requested." }
				: await verifiedThinkingChange(prior, currentModel, ctx.modelRegistry, branch);
			const decision = considerSwitch({
				current: prior,
				candidate: selected,
				currentModel,
				candidateModel: modelFor(selected, ctx.modelRegistry),
				classification,
				config,
				workGap: state ? state.workIndex + 1 - state.lastSwitchWorkIndex : 100,
				branch,
				contextTokens: ctx.getContextUsage()?.tokens ?? null,
				now,
				thinkingCacheVerified: assessment.verified,
			});
			estimate = decision.estimatedCacheLossUsd;
			if (!decision.switch) selected = prior;
			const policyReason = why;
			why = `${why} ${decision.reason}`;
			if (decision.switch && modelKey(prior) !== modelKey(selected)) {
				const escalation = considerThinkingEscalation({
					current: prior,
					currentModel,
					candidate: selected,
					classification,
					config,
					branch,
					assessment,
				});
				if (escalation.pair) {
					selected = escalation.pair;
					estimate = 0;
					why = `${policyReason} ${escalation.reason}`;
				} else why = `${why} ${escalation.reason}`;
			}
		}
	}
	if (!selected) throw new Error("No safe model selection is available.");
	if (state && !newUnit)
		await assertVerifiedThinkingChange(
			state.selected,
			selected,
			modelFor(selected, ctx.modelRegistry),
			ctx.modelRegistry,
			branch,
		);
	if (onCooldown(selected.provider, cooldowns, now))
		throw new Error("The explicitly selected provider remains on cooldown.");
	if (state?.fallback && !newUnit && roleOf(selected, config) !== "fallback")
		throw new Error("Start a new work unit before leaving the active fallback.");
	fallback = fallback || roleOf(selected, config) === "fallback";
	if (fallback) assertFallbackBudget(config, ctx.sessionManager.getEntries());
	let next = state ?? initial(prior ?? selected, now);
	next = {
		...next,
		workUnitId: newUnit ? crypto.randomUUID() : next.workUnitId,
		measurementVersion: newUnit ? 1 : next.measurementVersion,
		workIndex: next.workIndex + Number(newUnit),
		classification,
		boundaryToken: control.boundaryToken,
		requestKey: newUnit ? user.key : next.requestKey,
		fallback: !!fallback,
		cooldowns,
		classifierCalls: next.classifierCalls + calls,
		classifierErrors: next.classifierErrors + errors,
		classifierUnavailableUntil: errors
			? now + config.classifier.failureCooldownMs
			: next.classifierUnavailableUntil,
		retryCount: newUnit ? 0 : next.retryCount,
		retryKey: newUnit ? "" : next.retryKey,
	};
	if (control.overrideToken) next.overrideToken = control.overrideToken;
	if (control.resetToken) next.resetToken = control.resetToken;
	if (resetting) next.handledRecoveryId = recovery?.id;
	next = change(next, selected, why || "Preserve the locked physical pair.", now, estimate);
	if (!old && fallback)
		services.notify?.("GPT is on cooldown. Starting this work unit on the configured fallback.", ctx);
	return routed(selected, ctx, next);
}
