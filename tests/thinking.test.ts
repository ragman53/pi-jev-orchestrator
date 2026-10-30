import { describe, expect, test } from "bun:test";
import { getSupportedThinkingLevels, type Model, normalizeContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { considerSwitch, emptyUsage } from "../src/cache.ts";
import { deterministicClassification } from "../src/classifier.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { CONTROL_ENTRY, type Control, OUTCOME_ENTRY, PERFORMANCE_ENTRY } from "../src/state.ts";
import { type PerformanceRecord, pairMetrics } from "../src/stats.ts";
import {
	considerThinkingEscalation,
	thinkingCacheAssessment,
	verifiedThinkingChange,
} from "../src/thinking.ts";
import { assistant, deepseek, fixture, model, pair } from "./helpers.ts";

function nativeModel(id = "gpt-6.1-terra"): Model<"openai-responses"> {
	return {
		...model("openai", id),
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		compat: { supportsMidConvoEffort: true },
	};
}
function nativeFixture() {
	const terra = nativeModel();
	const sol = nativeModel("gpt-6.1-sol");
	const f = fixture({}, [terra, sol, deepseek]);
	f.registry.isUsingOAuth = () => false;
	f.registry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "sk-fake-offline-test" });
	return { ...f, terra, sol };
}
const cohort = { category: "debugging", complexity: "high", risk: "medium" } as const;
function records(
	manager: SessionManager,
	p: ReturnType<typeof pair>,
	options: {
		count?: number;
		latencyMs?: number;
		cost?: number;
		passes?: number;
		costKnown?: boolean;
		cohort?: PerformanceRecord["cohort"];
		cacheRead?: number;
	} = {},
) {
	for (let i = 0; i < (options.count ?? 3); i++) {
		const id = crypto.randomUUID();
		manager.appendCustomEntry(PERFORMANCE_ENTRY, {
			workUnitId: id,
			pair: p,
			cohort: options.cohort ?? cohort,
			latencyMs: options.latencyMs ?? 800,
			usage: {
				...emptyUsage(),
				input: 100,
				cacheRead: options.cacheRead ?? 1000,
				totalTokens: 1100,
				cost: { ...emptyUsage().cost, total: options.cost ?? 1 },
			},
			costKnown: options.costKnown ?? true,
			completeWorkUnit: true,
		} satisfies PerformanceRecord);
		manager.appendCustomEntry(OUTCOME_ENTRY, {
			workUnitId: id,
			outcome: i < (options.passes ?? 3) ? "pass" : "fail",
			source: "user",
		});
	}
}

describe("max and scoped cache verification", () => {
	test.each(["terra", "sol", "astra"] as const)(
		"%s can start at max when authenticated and supported",
		async (role) => {
			const f = fixture({ complexity: "exceptional" });
			f.config.models.astra = { preferred: "openai-codex/gpt-6-astra", compatible: [] };
			f.config.policy = [{ role, thinking: "max" }];
			const routed = await f.run();
			expect(routed.thinkingLevel).toBe("max");
			expect(getSupportedThinkingLevels(routed.model)).toContain("max");
		},
	);
	test("max clamps to the registry's actual highest supported level", async () => {
		const limited = model("openai-codex", "gpt-6.1-terra", ["medium", "high"]);
		const f = fixture({}, [limited]);
		f.config.policy = [{ role: "terra", thinking: "max" }];
		expect((await f.run()).thinkingLevel).toBe("high");
		expect(getSupportedThinkingLevels(limited)).not.toContain("max");
	});
	test("exceptional work retains max when optional Astra is disabled", async () => {
		const f = fixture({ complexity: "exceptional" });
		expect((await f.run()).thinkingLevel).toBe("max");
		expect(f.state().selected.id).toBe("gpt-6.1-sol");
	});
	test("OAuth never inherits API-key cache verification from model metadata", async () => {
		const f = nativeFixture();
		f.registry.isUsingOAuth = () => true;
		f.registry.getApiKeyAndHeaders = async () => {
			throw new Error("must not resolve or print credentials");
		};
		const result = await thinkingCacheAssessment(f.terra, f.registry);
		expect(result.verified).toBe(false);
		expect(result.reason).toContain("ChatGPT OAuth");
	});
	test("unverified endpoints, transports, and missing flags cannot enable escalation", async () => {
		const f = nativeFixture();
		f.terra.compat = {};
		expect((await thinkingCacheAssessment(f.terra, f.registry)).verified).toBe(false);
		f.terra.compat = { supportsMidConvoEffort: true };
		f.terra.baseUrl = "https://other.invalid";
		expect((await thinkingCacheAssessment(f.terra, f.registry)).verified).toBe(false);
		f.terra.baseUrl = "https://api.openai.com/v1";
		f.registry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "not-an-api-key" });
		expect((await thinkingCacheAssessment(f.terra, f.registry)).verified).toBe(false);
	});
	test("the prior prefix must also carry native append-only effort provenance", async () => {
		const f = nativeFixture();
		expect((await thinkingCacheAssessment(f.terra, f.registry)).verified).toBe(true);
		f.manager.appendMessage(assistant(f.terra, "high"));
		expect(
			(await verifiedThinkingChange(pair(f.terra), f.terra, f.registry, f.manager.getBranch())).verified,
		).toBe(false);
		f.manager.appendMessage({ ...assistant(f.terra), providerThinkingLevel: "high" });
		expect(
			(await verifiedThinkingChange(pair(f.terra), f.terra, f.registry, f.manager.getBranch())).verified,
		).toBe(true);
	});
	test("automatic same-model policy escalation is blocked without cache verification", async () => {
		const f = nativeFixture();
		f.registry.isUsingOAuth = () => true;
		await f.run();
		f.config.policy = [{ role: "terra", thinking: "max" }];
		f.setAnswer({ category: "debugging", complexity: "high", reasoning: "deep" });
		await f.run({ messages: [{ role: "user", content: "New task: difficult debugging.", timestamp: 2 }] });
		expect(f.state().selected.thinkingLevel).toBe("high");
		expect(f.state().why).toContain("unverified");
	});
	test("explicit same-model changes within a work unit require verification", async () => {
		const f = nativeFixture();
		f.registry.isUsingOAuth = () => true;
		await f.run();
		f.manager.appendCustomEntry(CONTROL_ENTRY, {
			mode: "auto",
			boundaryToken: "",
			override: pair(f.terra, "max"),
			overrideToken: "max",
		} satisfies Control);
		await expect(f.run()).rejects.toThrow("not verified");
		f.manager.appendCustomEntry(CONTROL_ENTRY, {
			mode: "auto",
			boundaryToken: "fresh",
			override: pair(f.terra, "max"),
			overrideToken: "max",
		} satisfies Control);
		expect((await f.run()).thinkingLevel).toBe("max");
	});
	test("an explicitly requested intra-model max is allowed only on the verified prefix", async () => {
		const f = nativeFixture();
		await f.run();
		f.manager.appendMessage({ ...assistant(f.terra), providerThinkingLevel: "high" });
		f.manager.appendCustomEntry(CONTROL_ENTRY, {
			mode: "auto",
			boundaryToken: "",
			override: pair(f.terra, "max"),
			overrideToken: "verified-max",
		} satisfies Control);
		const next = await f.run();
		expect(next.thinkingLevel).toBe("max");
		expect((await f.run()).state).toBe(next.state);
		expect(f.classify).toHaveBeenCalledTimes(1);
	});
	test("max thinking remains sticky through tools, follow-ups, native retries, and quota fallback", async () => {
		const f = fixture();
		f.config.policy = [{ role: "terra", thinking: "max" }];
		const first = await f.run();
		expect(
			(await f.run({ reason: "continuation", previous: { model: first.model, thinkingLevel: "max" } })).state,
		).toBe(first.state);
		expect(
			(await f.run({ messages: [{ role: "user", content: "Fix the test failure.", timestamp: 2 }] }))
				.thinkingLevel,
		).toBe("max");
		expect(
			(
				await f.run({
					reason: "retry",
					failed: {
						model: first.model,
						thinkingLevel: "max",
						message: assistant(first.model, "max", "429 rate_limit_exceeded"),
					},
				})
			).thinkingLevel,
		).toBe("max");
		expect(
			(
				await f.run({
					reason: "retry",
					failed: {
						model: first.model,
						thinkingLevel: "max",
						message: assistant(first.model, "max", "usage_limit_reached"),
					},
				})
			).thinkingLevel,
		).toBe("max");
		expect(f.state().fallback).toBe(true);
		expect((await f.run()).model.id).toBe(deepseek.id);
		expect(f.classify).toHaveBeenCalledTimes(1);
	});
});

describe("native Pi wire behavior (injected HTTP, no credentials or network)", () => {
	test.each([false, true])("append-only effort path with OAuth=%s", async (oauth) => {
		const m = nativeModel("gpt-6.1-sol");
		const context = { messages: [{ role: "user" as const, content: "Synthetic cache test.", timestamp: 1 }] };
		const payloads: Array<{ reasoning: { effort: string }; input: unknown[]; prompt_cache_key: string }> = [];
		const complete = (
			reasoning: "high" | "max",
			messages = context.messages as Parameters<typeof streamSimple>[1]["messages"],
		) =>
			streamSimple(m, normalizeContext({ messages }), {
				reasoning,
				apiKey: oauth ? "offline-fake-subscription-token" : "sk-offline-fake",
				sessionId: "stable-session",
				maxRetries: 0,
				onPayload(payload) {
					payloads.push(payload as (typeof payloads)[number]);
				},
				fetch: Object.assign(
					async () =>
						new Response(
							`event: response.completed\ndata: ${JSON.stringify({
								type: "response.completed",
								response: {
									id: "offline-response",
									status: "completed",
									output: [],
									usage: {
										input_tokens: 2048,
										output_tokens: 16,
										input_tokens_details: { cached_tokens: 0 },
									},
								},
							})}\n\n`,
							{ headers: { "content-type": "text/event-stream" } },
						),
					{ preconnect() {} },
				),
			}).result();
		const first = await complete("high");
		expect(first.stopReason).toBe("stop");
		// A visible assistant item lets Pi replay the prior effort marker in its original position.
		first.content = [{ type: "text", text: "Synthetic response." }];
		await complete("max", [...context.messages, first, { role: "user", content: "Continue.", timestamp: 2 }]);
		expect(payloads).toHaveLength(2);
		expect(payloads[0]?.prompt_cache_key).toBe(payloads[1]?.prompt_cache_key);
		if (oauth) {
			expect(payloads.map((p) => p.reasoning.effort)).toEqual(["high", "max"]);
			expect(JSON.stringify(payloads)).not.toContain("configuration_update");
			expect(first.providerThinkingLevel).toBeUndefined();
		} else {
			expect(payloads.map((p) => p.reasoning.effort)).toEqual(["medium", "medium"]);
			expect(payloads[1]?.input.slice(0, payloads[0]?.input.length)).toEqual(payloads[0]?.input);
			expect(payloads[1]?.input.at(-1)).toEqual({
				type: "configuration_update",
				reasoning: { effort: "max" },
			});
			expect(first.providerThinkingLevel).toBe("high");
		}
	});
});

describe("completion-aware thinking comparison", () => {
	test("failed work contributes cost and the latest user outcome replaces earlier annotations", () => {
		const f = nativeFixture();
		records(f.manager, pair(f.terra, "max"), { count: 4, passes: 3, cost: 2 });
		const before = pairMetrics(f.manager.getBranch(), pair(f.terra, "max"), cohort);
		expect(before.userReportedSuccessRate).toBe(0.75);
		expect(before.costPerReportedSuccessUsd).toBe(8 / 3);
		const last = f.manager
			.getEntries()
			.findLast((e) => e.type === "custom" && e.customType === OUTCOME_ENTRY);
		if (last?.type !== "custom") throw new Error("Missing fixture outcome");
		f.manager.appendCustomEntry(OUTCOME_ENTRY, { ...(last.data as object), outcome: "pass" });
		expect(pairMetrics(f.manager.getBranch(), pair(f.terra, "max"), cohort).completedWorkUnits).toBe(4);
	});
	test("additional work invalidates an earlier reported completion", () => {
		const f = nativeFixture();
		records(f.manager, pair(f.terra), { count: 1 });
		const entry = f.manager
			.getEntries()
			.findLast((e) => e.type === "custom" && e.customType === PERFORMANCE_ENTRY);
		if (entry?.type !== "custom") throw new Error("Missing fixture performance");
		f.manager.appendCustomEntry(PERFORMANCE_ENTRY, entry.data);
		const metrics = pairMetrics(f.manager.getBranch(), pair(f.terra));
		expect(metrics.observedResponses).toBe(2);
		expect(metrics.userReportedSuccessRate).toBeNull();
		expect(metrics.unreportedWorkUnits).toBe(1);
	});
	test("mixed thinking and partial legacy work units cannot supply pair-specific completion evidence", () => {
		const f = nativeFixture();
		records(f.manager, pair(f.terra), { count: 1 });
		const entry = f.manager
			.getEntries()
			.findLast((e) => e.type === "custom" && e.customType === PERFORMANCE_ENTRY);
		if (entry?.type !== "custom") throw new Error("Missing fixture performance");
		const p = entry.data as PerformanceRecord;
		f.manager.appendCustomEntry(PERFORMANCE_ENTRY, { ...p, pair: pair(f.terra, "max") });
		f.manager.appendCustomEntry(OUTCOME_ENTRY, { workUnitId: p.workUnitId, source: "user", outcome: "pass" });
		expect(pairMetrics(f.manager.getBranch(), pair(f.terra)).excludedMixedPairWorkUnits).toBe(1);
		f.manager.appendCustomEntry(PERFORMANCE_ENTRY, { ...p, workUnitId: "legacy", completeWorkUnit: false });
		f.manager.appendCustomEntry(OUTCOME_ENTRY, { workUnitId: "legacy", source: "user", outcome: "pass" });
		const metrics = pairMetrics(f.manager.getBranch(), pair(f.terra));
		expect(metrics.excludedPartialWorkUnits).toBe(1);
		expect(metrics.costPerReportedSuccessUsd).toBeNull();
		expect(metrics.observedNativeCostUsd).toBeGreaterThan(0);
	});
	test("higher levels including max precede a physical switch only with verified comparable evidence", async () => {
		const f = nativeFixture();
		await f.run();
		records(f.manager, pair(f.terra, "max"), { cost: 1, latencyMs: 800 });
		records(f.manager, pair(f.sol, "xhigh"), { cost: 2, latencyMs: 1000, cacheRead: 500 });
		f.manager.appendMessage({ ...assistant(f.terra), providerThinkingLevel: "high" });
		f.setAnswer({ ...cohort, reasoning: "deep" });
		const routed = await f.run({
			messages: [{ role: "user", content: "New task: debug a difficult subsystem.", timestamp: 2 }],
		});
		expect(routed.model.id).toBe(f.terra.id);
		expect(routed.thinkingLevel).toBe("max");
		expect(f.state().why).toContain("Prefer max");
		expect(f.state().history.at(-1)?.estimatedCacheLossUsd).toBe(0);
		expect((await f.run()).state).toBe(routed.state);
	});
	test.each([
		"unverified",
		"too-slow",
		"too-expensive",
		"insufficient",
		"wrong-cohort",
		"unknown-cost",
		"lower-success",
		"poor-cache",
	])("%s evidence cannot justify preferring a higher current-model level", (scenario) => {
		const f = nativeFixture();
		records(f.manager, pair(f.terra, "max"), {
			latencyMs: scenario === "too-slow" ? 10000 : 800,
			cost: scenario === "too-expensive" ? 10 : 1,
			count: scenario === "insufficient" ? 1 : 3,
			passes: scenario === "lower-success" ? 1 : 3,
			costKnown: scenario !== "unknown-cost",
			cacheRead: scenario === "poor-cache" ? 0 : 1000,
			cohort: scenario === "wrong-cohort" ? { ...cohort, complexity: "low" } : cohort,
		});
		records(f.manager, pair(f.sol, "xhigh"), { cost: 2, latencyMs: 1000, cacheRead: 500 });
		const result = considerThinkingEscalation({
			current: pair(f.terra),
			currentModel: f.terra,
			candidate: pair(f.sol, "xhigh"),
			classification: { ...deterministicClassification(), ...cohort },
			config: DEFAULT_CONFIG,
			branch: f.manager.getBranch(),
			assessment: { verified: scenario !== "unverified", reason: "offline test" },
		});
		expect(result.pair).toBeUndefined();
		expect(result.reason).toContain("max");
	});
	test("verified same-model escalation estimates no cold reconstruction", () => {
		const f = nativeFixture();
		const decision = considerSwitch({
			current: pair(f.terra),
			candidate: pair(f.terra, "max"),
			currentModel: f.terra,
			candidateModel: f.terra,
			classification: {
				...deterministicClassification(),
				...cohort,
				reasoning: "deep",
				confidence: 0.95,
				source: "jev",
			},
			config: DEFAULT_CONFIG,
			workGap: 10,
			branch: [],
			contextTokens: 100000,
			now: 1000,
			thinkingCacheVerified: true,
		});
		expect(decision.switch).toBe(true);
		expect(decision.estimatedCacheLossUsd).toBe(0);
	});
});
