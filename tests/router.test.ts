import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { currentUser, parseClassification } from "../src/classifier.ts";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";
import { CONTROL_ENTRY, type Control, readState } from "../src/state.ts";
import { assistant, astra, classified, deepseek, fixture, model, pair, sol, terra } from "./helpers.ts";

describe("policy and classifier", () => {
	test.each([
		["trivial", "other", terra.id, "medium"],
		["low", "small code modification", terra.id, "medium"],
		["medium", "documentation", terra.id, "medium"],
		["medium", "standard implementation", terra.id, "high"],
		["high", "complex implementation", sol.id, "xhigh"],
		["high", "debugging", sol.id, "xhigh"],
		["medium", "architecture", sol.id, "xhigh"],
	] as const)("%s %s routes to the configured physical pair", async (complexity, category, id, thinking) => {
		const f = fixture({ complexity, category });
		const r = await f.run();
		expect(r.model.id).toBe(id);
		expect(r.thinkingLevel).toBe(thinking);
		expect(f.classify).toHaveBeenCalledTimes(1);
	});
	test("Astra is opt-in and never selected solely for long input", async () => {
		const f = fixture({ complexity: "exceptional", reasoning: "deep" });
		expect((await f.run()).model.id).toBe(sol.id);
		const g = fixture({ complexity: "low", category: "documentation" });
		g.config.models.astra = { preferred: "openai-codex/gpt-6-astra", compatible: [] };
		expect(
			(await g.run({ messages: [{ role: "user", content: "text ".repeat(100000), timestamp: 1 }] })).model.id,
		).toBe(terra.id);
		expect(JSON.stringify(g.calls[0]?.state).length).toBeLessThan(8500);
	});
	test("explicitly enabled Astra serves exceptional work", async () => {
		const f = fixture({ complexity: "exceptional", reasoning: "deep" });
		f.config.models.astra = { preferred: "openai-codex/gpt-6-astra", compatible: [] };
		expect((await f.run()).model.id).toBe(astra.id);
	});
	test("unavailable Sol retains the requested budget on compatible Terra; missing primaries fail closed", async () => {
		const f = fixture({ complexity: "high" }, [terra, deepseek]);
		const result = await f.run();
		expect(result.model.id).toBe(terra.id);
		expect(result.thinkingLevel).toBe("xhigh");
		await expect(fixture({}, [deepseek]).run()).rejects.toThrow("No authenticated Terra or Sol");
	});
	test("audited openai targets are explicit compatible aliases", async () => {
		const oldTerra = model("openai", "gpt-5.6-terra");
		const actualSol = model("openai", "gpt-6.1-sol");
		const f = fixture({}, [oldTerra, actualSol, deepseek]);
		expect((await f.run()).model).toEqual(oldTerra);
	});
	test("automatic routing never silently inherits an unrelated prior physical model", async () => {
		const unrelated = model("other-provider", "other-model");
		for (const prior of [unrelated, deepseek]) {
			const f = fixture({}, [terra, sol, deepseek, unrelated]);
			f.manager.appendMessage(assistant(prior));
			expect((await f.run()).model.id).toBe(terra.id);
		}
	});
	test("a new boundary can leave an unavailable prior target for an explicit compatible target", async () => {
		const f = fixture({}, [sol, deepseek]);
		f.manager.appendMessage(assistant(terra));
		expect((await f.run()).model.id).toBe(sol.id);
	});
	test("thinking is mapped with Pi's actual clamp function", async () => {
		const limited = model("openai-codex", terra.id, ["low", "high"]);
		const f = fixture({ complexity: "low" }, [limited, sol, deepseek]);
		expect((await f.run()).thinkingLevel).toBe(clampThinkingLevel(limited, "medium"));
	});
	test("Jev failure is deterministic and not retried during continuations", async () => {
		const f = fixture();
		f.classify.mockRejectedValue(new Error("provider error with secret-api-key"));
		const first = await f.run();
		expect(first.model.id).toBe(terra.id);
		expect(first.thinkingLevel).toBe("high");
		expect(f.state().classification.source).toBe("deterministic");
		await f.run({
			reason: "continuation",
			previous: { model: first.model, thinkingLevel: first.thinkingLevel },
		});
		await f.run({ messages: [{ role: "user", content: "Continue.", timestamp: 2 }] });
		expect(f.classify).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(f.manager.getEntries())).not.toContain("secret-api-key");
		expect(f.notifications.join()).not.toContain("secret-api-key");
	});
	test("classifier circuit breaker applies at repeated explicit boundaries", async () => {
		const f = fixture();
		f.classify.mockRejectedValue(new Error("unavailable"));
		await f.run();
		f.manager.appendCustomEntry(CONTROL_ENTRY, { mode: "auto", boundaryToken: "new" } satisfies Control);
		await f.run();
		expect(f.classify).toHaveBeenCalledTimes(1);
	});
	test("only the current user request and compact task facts go to Jev", async () => {
		const f = fixture();
		await f.run({
			messages: [
				{ role: "system", content: "system-secret", timestamp: 1 },
				{ role: "user", content: "old-secret", timestamp: 2 },
				{ role: "user", content: "Update the docs.", timestamp: 3 },
			],
		});
		const sent = JSON.stringify(f.calls);
		expect(sent).toContain("Update the docs.");
		expect(sent).not.toContain("system-secret");
		expect(sent).not.toContain("old-secret");
		expect(JSON.stringify(f.state())).not.toContain("Update the docs.");
	});
	test("cancellation is not converted into a routing fallback", async () => {
		const f = fixture();
		await expect(f.run({ signal: AbortSignal.abort() })).rejects.toThrow("cancelled");
		expect(f.classify).not.toHaveBeenCalled();
	});
	test("uncertain risk and reasoning probabilities cannot hide behind a confident category", () => {
		const result = classified({ category: "code review", complexity: "high", risk: "high" });
		result.answers.risk = {
			type: "choice",
			choice: "high",
			confidence: 1,
			probabilities: { low: 0.32, medium: 0.33, high: 0.35 },
		};
		expect(parseClassification(result).confidence).toBe(0.35);
	});
	test("an uncertain initial classification uses the conservative policy without enabling Astra", async () => {
		const f = fixture({ complexity: "exceptional", confidence: 0.55 });
		f.config.models.astra = { preferred: "openai-codex/gpt-6-astra", compatible: [] };
		const result = await f.run();
		expect(result.model.id).toBe(terra.id);
		expect(result.thinkingLevel).toBe("high");
		expect(f.state().classification.confidence).toBe(0.55);
	});
	test("malformed probabilities and incomplete responses fail conservatively", async () => {
		const f = fixture();
		f.classify.mockResolvedValue({ stopReason: "stop", answers: {} } as never);
		expect((await f.run()).thinkingLevel).toBe("high");
		expect(f.state().classifierErrors).toBe(1);
	});
});

describe("sticky cache and work units", () => {
	test("tool continuations and phase changes preserve model, level, and state identity", async () => {
		const f = fixture({ category: "debugging", complexity: "high" });
		const first = await f.run();
		const state = first.state;
		const before = f.manager.getEntries().length;
		const messages = f.request().messages;
		for (const toolName of ["read", "edit", "write", "bash"]) {
			const next = await f.run({
				reason: "continuation",
				previous: { model: sol, thinkingLevel: first.thinkingLevel },
				messages: [
					...messages,
					assistant(sol, first.thinkingLevel),
					{
						role: "toolResult",
						toolName,
						toolCallId: toolName,
						content: [{ type: "text", text: "success" }],
						isError: false,
						timestamp: 20,
					},
				],
			});
			expect(next.model.id).toBe(sol.id);
			expect(next.thinkingLevel).toBe(first.thinkingLevel);
			expect(next.state).toBe(state);
		}
		expect(f.manager.getEntries()).toHaveLength(before);
		expect(f.classify).toHaveBeenCalledTimes(1);
	});
	test("small and long follow-ups do not automatically reclassify", async () => {
		const f = fixture({ complexity: "high" });
		await f.run();
		const state = f.state();
		for (const text of [
			"Fix the failing tests.",
			"Continue implementation.",
			"Review feedback ".repeat(500),
		]) {
			expect((await f.run({ messages: [{ role: "user", content: text, timestamp: 9 }] })).state).toBe(state);
		}
		expect(f.classify).toHaveBeenCalledTimes(1);
	});
	test("a clear boundary or /route new classifies exactly once", async () => {
		const f = fixture();
		await f.run();
		const first = f.state().workUnitId;
		await f.run({
			messages: [{ role: "user", content: "New task: inspect an independent subsystem.", timestamp: 2 }],
		});
		expect(f.state().workUnitId).not.toBe(first);
		expect(f.classify).toHaveBeenCalledTimes(2);
		f.manager.appendCustomEntry(CONTROL_ENTRY, { mode: "auto", boundaryToken: "manual" } satisfies Control);
		await f.run();
		expect(f.classify).toHaveBeenCalledTimes(3);
	});
	test("low confidence preserves the prior pair at a new boundary", async () => {
		const f = fixture();
		await f.run();
		f.setAnswer({ complexity: "high", reasoning: "deep", confidence: 0.55 });
		await f.run({ messages: [{ role: "user", content: "New task: complex system.", timestamp: 2 }] });
		expect(f.state().selected).toEqual(pair(terra));
		expect(f.state().why).toContain("Uncertain");
	});
	test("hysteresis prevents oscillation across adjacent boundaries", async () => {
		const f = fixture();
		await f.run();
		f.setAnswer({ complexity: "high", reasoning: "deep" });
		await f.run({ messages: [{ role: "user", content: "New task: harder.", timestamp: 2 }] });
		expect(f.state().selected.id).toBe(sol.id);
		f.setAnswer({ complexity: "low", multiFile: false });
		await f.run({ messages: [{ role: "user", content: "New task: a small edit.", timestamp: 3 }] });
		expect(f.state().selected.id).toBe(sol.id);
		expect(f.state().why).toContain("hysteresis");
	});
	test("direct compaction work neither classifies nor mutates branch state", async () => {
		const f = fixture();
		await f.run();
		const before = f.manager.getEntries().length;
		const result = await f.run({
			reason: "direct",
			state: undefined,
			previous: { model: terra, thinkingLevel: "high" },
		});
		expect(result.state).toBeUndefined();
		expect(result.thinkingLevel).toBe("high");
		expect(f.manager.getEntries()).toHaveLength(before);
		expect(f.classify).toHaveBeenCalledTimes(1);
	});
	test("continuation honors the previous native physical pair rather than reclassifying", async () => {
		const f = fixture();
		await f.run();
		const next = await f.run({ reason: "continuation", previous: { model: sol, thinkingLevel: "xhigh" } });
		expect(next.model).toEqual(sol);
		expect(next.thinkingLevel).toBe("xhigh");
		expect(f.classify).toHaveBeenCalledTimes(1);
	});
	test("manual lock persists without redundant state writes", async () => {
		const f = fixture({ complexity: "high" });
		await f.run();
		f.manager.appendCustomEntry(CONTROL_ENTRY, {
			mode: "lock",
			boundaryToken: "",
			locked: pair(terra, "medium"),
		} satisfies Control);
		await f.run();
		const locked = f.state();
		expect(locked.selected).toEqual(pair(terra, "medium"));
		expect((await f.run()).state).toBe(locked);
		expect(f.classify).toHaveBeenCalledTimes(1);
	});
	test("manual override is consumed once and stays fixed within the work unit", async () => {
		const f = fixture();
		await f.run();
		f.manager.appendCustomEntry(CONTROL_ENTRY, {
			mode: "auto",
			boundaryToken: "",
			override: pair(sol, "xhigh"),
			overrideToken: "explicit",
		} satisfies Control);
		await f.run();
		expect(f.state().selected).toEqual(pair(sol, "xhigh"));
		const state = f.state();
		expect((await f.run()).state).toBe(state);
		expect(f.classify).toHaveBeenCalledTimes(1);
	});
	test("reset clears work state but retains cooldowns and native history", async () => {
		const f = fixture();
		await f.run();
		const old = f.state();
		old.cooldowns = { unrelated: { until: 2000000, notBefore: 0, failures: 1 } };
		f.manager.appendCustomEntry(CONTROL_ENTRY, {
			mode: "auto",
			boundaryToken: "reset",
			resetToken: "reset",
		} satisfies Control);
		await f.run();
		expect(f.state().workUnitId).not.toBe(old.workUnitId);
		expect(f.state().cooldowns).toEqual(old.cooldowns);
		const reset = f.state();
		expect((await f.run()).state).toBe(reset);
		expect(f.manager.getEntries().length).toBeGreaterThan(1);
	});
	test("JSON resume, compaction, and branching restore branch-specific routing", async () => {
		const f = fixture();
		await f.run();
		const root = f.manager.getLeafId() as string;
		const firstState = JSON.parse(JSON.stringify(f.state()));
		f.manager.appendCompaction("Summary", root, 10000);
		expect(readState(f.manager.getBranch())).toEqual(firstState);
		f.setAnswer({ complexity: "high", reasoning: "deep" });
		f.manager.appendCustomEntry(CONTROL_ENTRY, { mode: "auto", boundaryToken: "branch-b" } satisfies Control);
		await f.run({ state: firstState });
		expect(f.state().selected.id).toBe(sol.id);
		const secondLeaf = f.manager.getLeafId() as string;
		f.manager.branch(root);
		expect(f.state().selected.id).toBe(terra.id);
		f.manager.branch(secondLeaf);
		expect(f.state().selected.id).toBe(sol.id);
	});
	test("no routing phase logic, cache warmer, or request-prefix hooks are registered", () => {
		const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
		for (const hook of [
			"cache_warming_decision",
			"before_agent_start",
			"context_with_system",
			"before_provider_request",
		])
			expect(source).not.toContain(`pi.on("${hook}"`);
		expect(source).not.toContain("setInterval");
	});
	test("invalid state is rejected, but an explicit reset repairs it", async () => {
		const f = fixture();
		await expect(f.run({ state: { version: 999 } as never })).rejects.toThrow(
			"Unsupported orchestrator state",
		);
		f.manager.appendCustomEntry(CONTROL_ENTRY, {
			mode: "auto",
			boundaryToken: "r",
			resetToken: "r",
		} satisfies Control);
		expect((await f.run({ state: { version: 999 } as never })).model.id).toBe(terra.id);
	});
});

describe("configuration", () => {
	test("repository configuration examples validate and the full example matches defaults", () => {
		const full = parseConfig(
			JSON.parse(readFileSync(new URL("../examples/jev-orchestrator.json", import.meta.url), "utf8")),
		);
		expect(full).toEqual(DEFAULT_CONFIG);
		const audited = parseConfig(
			JSON.parse(readFileSync(new URL("../examples/audited-openai.json", import.meta.url), "utf8")),
		);
		expect(audited.models.terra.preferred).toBe("openai/gpt-6.1-terra");
		const optional = parseConfig(
			JSON.parse(readFileSync(new URL("../examples/astra-enabled.json", import.meta.url), "utf8")),
		);
		expect(optional.models.astra?.preferred).toBe("openai/gpt-6-astra");
		expect(audited.models.astra).toBeNull();
	});
	test("policy is data and can be replaced without changing routing logic", async () => {
		const f = fixture({ complexity: "low" });
		f.config = Object.assign(f.config, parseConfig({ policy: [{ role: "sol", thinking: "high" }] }));
		expect((await f.run()).model.id).toBe(sol.id);
	});
	test.each([
		{ enabled: "yes" },
		{ unexpected: true },
		{ version: 2 },
		{ classifier: { minConfidence: 2 } },
		{ fallback: { maxRetries: -1 } },
		{ thinking: { preferCurrentModel: "yes" } },
		{ thinking: { minCompletedWorkUnits: 0 } },
		{ thinking: { minSuccessRate: 2 } },
		{ thinking: { maxLatencyRatio: 0 } },
		{ cache: { expectedRemainingRequests: 1 } },
		{ models: { terra: { preferred: "invalid" } } },
		{ policy: [{ role: "other", thinking: "high" }] },
		{ policy: [{ role: "terra", thinking: "high", category: ["unknown"] }] },
	])("invalid configuration is rejected without echoing values: %j", (value) => {
		expect(() => parseConfig(value)).toThrow("Invalid orchestrator configuration");
	});
	test("configuration defaults remain unchanged", () => {
		const changed = parseConfig({ enabled: false });
		expect(changed.enabled).toBe(false);
		expect(DEFAULT_CONFIG.enabled).toBe(true);
		expect(currentUser([{ role: "user", content: "private", timestamp: 1 }]).key).not.toContain("private");
	});
});
