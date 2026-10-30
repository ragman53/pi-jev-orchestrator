import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { display, registerCommands } from "./src/commands.ts";
import { loadConfig } from "./src/config.ts";
import { detectFailure, type Evidence, retryAfter, streamEvidence } from "./src/fallback.ts";
import { eligibleGpt, route } from "./src/router.ts";
import {
	CLASSIFIER_ENTRY,
	latestRecovery,
	MODEL_ID,
	PERFORMANCE_ENTRY,
	PROVIDER,
	RECOVERY_ATTEMPT_ENTRY,
	RECOVERY_ENTRY,
	type RouteState,
	readState,
} from "./src/state.ts";
import { performanceRecord } from "./src/stats.ts";

function recoveryAttempted(ctx: ExtensionContext, id: string): boolean {
	return ctx.sessionManager
		.getBranch()
		.some(
			(e) =>
				e.type === "custom" &&
				e.customType === RECOVERY_ATTEMPT_ENTRY &&
				(e.data as { recoveryId?: string } | undefined)?.recoveryId === id,
		);
}

export default function orchestrator(pi: ExtensionAPI): void {
	loadConfig();
	// Transport evidence is request-local, not routing state. Keys are session manager instances.
	const evidence = new WeakMap<object, Evidence>();
	const turnStarted = new WeakMap<object, number>();
	pi.registerVirtualModel<RouteState>({
		provider: PROVIDER,
		id: MODEL_ID,
		name: "Auto (cache-aware Jev)",
		thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
		// Limits are intentionally unknown until a real physical model is selected.
		async route(request, ctx) {
			const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
			const result = await route(request, ctx, config, {
				recordClassification: (result) => {
					const [provider, ...parts] = config.classifier.model.split("/");
					const classifier = ctx.modelRegistry.findOfType("classifier", provider ?? "", parts.join("/"));
					const cost = classifier?.cost;
					pi.appendEntry(CLASSIFIER_ENTRY, {
						provider: result.provider,
						model: result.model,
						timestamp: result.timestamp,
						stopReason: result.stopReason,
						usage: result.usage,
						priceKnown:
							!!cost && [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].some((x) => x > 0),
					});
				},
				notify: (message, context) => display(context, message, "warning"),
			}).catch((error) => {
				const recovery = latestRecovery(ctx.sessionManager.getBranch());
				if (
					request.reason !== "direct" &&
					recovery &&
					recovery.id !== request.state?.handledRecoveryId &&
					!recoveryAttempted(ctx, recovery.id)
				) {
					pi.appendEntry(RECOVERY_ATTEMPT_ENTRY, { recoveryId: recovery.id });
				}
				throw error;
			});
			if (config.diagnostics === "verbose" && result.state && result.state !== request.state)
				display(ctx, result.state.why);
			return result;
		},
	});
	registerCommands(pi);

	const active = (ctx: ExtensionContext) => ctx.model?.provider === PROVIDER && ctx.model.id === MODEL_ID;
	pi.on("turn_start", (_event, ctx) => {
		evidence.delete(ctx.sessionManager);
		if (active(ctx)) turnStarted.set(ctx.sessionManager, performance.now());
	});
	pi.on("message_end", (event, ctx) => {
		if (!active(ctx) || event.message.role !== "assistant") return;
		const start = turnStarted.get(ctx.sessionManager);
		if (start === undefined) return;
		const record = performanceRecord(ctx, event.message, Math.max(0, performance.now() - start));
		if (record) pi.appendEntry(PERFORMANCE_ENTRY, record);
	});
	pi.on("after_provider_response", (event, ctx) => {
		if (!active(ctx)) return;
		const notBefore = retryAfter(event.headers["retry-after"], Date.now());
		if (notBefore) evidence.set(ctx.sessionManager, { ...evidence.get(ctx.sessionManager), notBefore });
	});
	pi.on("provider_stream_event", (event, ctx) => {
		if (!active(ctx) || !["openai", "openai-codex"].includes(event.provider)) return;
		const found = streamEvidence(event.data, Date.now());
		if (found)
			evidence.set(ctx.sessionManager, {
				...found,
				notBefore: Math.max(found.notBefore, evidence.get(ctx.sessionManager)?.notBefore ?? 0),
			});
	});
	pi.on("turn_end", (event, ctx) => {
		if (!active(ctx) || event.message.role !== "assistant") return;
		const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		const message = event.message;
		const failure = detectFailure(message, eligibleGpt(message, ctx), evidence.get(ctx.sessionManager));
		evidence.delete(ctx.sessionManager);
		if (!config.fallback.enabled || failure.kind !== "quota" || ctx.signal?.aborted) return;
		// Do not resume a partially executed batch. Earlier successful turns remain untouched.
		if (event.toolResults.length || message.content.some((b) => b.type === "toolCall")) {
			display(
				ctx,
				"GPT usage ended during a partial tool turn. Automatic failover stopped to avoid replaying tool operations.",
				"error",
			);
			return;
		}
		const marker = {
			type: "custom" as const,
			customType: RECOVERY_ENTRY,
			data: {
				provider: message.provider,
				model: message.model,
				thinkingLevel: message.thinkingLevel ?? "medium",
				notBefore: failure.notBefore,
			},
		};
		if (isRetryableAssistantError(message)) return { entries: [marker] };
		// The low-level loop ends on errors even when turn_end requests continuation in Pi 1.4.
		// Omit only the failed generation here, then resume at the documented pre-settlement boundary.
		return {
			entries: [marker, { type: "context_edit" as const, targetId: event.messageEntryId, replacement: null }],
		};
	});
	pi.on("agent_before_settle", (event, ctx) => {
		if (!active(ctx) || event.outcome === "aborted" || ctx.signal?.aborted) return;
		const branch = ctx.sessionManager.getBranch();
		const recovery = latestRecovery(branch);
		if (
			!recovery ||
			recovery.id === readState(branch)?.handledRecoveryId ||
			recoveryAttempted(ctx, recovery.id) ||
			!event.context.canContinue
		)
			return;
		return {
			entries: [{ type: "custom", customType: RECOVERY_ATTEMPT_ENTRY, data: { recoveryId: recovery.id } }],
			continue: true,
		};
	});
}
