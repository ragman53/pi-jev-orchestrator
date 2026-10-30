import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import {
	assertFallbackBudget,
	detectFailure,
	nextCooldown,
	readCooldowns,
	retryAfter,
	saveCooldown,
	streamEvidence,
} from "../src/fallback.ts";
import { CONTROL_ENTRY, type Control } from "../src/state.ts";
import { assistant, deepseek, fixture, pair, terra } from "./helpers.ts";

describe("error discrimination", () => {
	test.each([
		["usage_limit_reached", "quota"],
		["subscription_sharing_usage_limit_exceeded", "quota"],
		["subscription_sharing_workplace_individual_usage_limit_exceeded", "quota"],
		["429 rate_limit_exceeded", "rate-limit"],
		["You have hit your ChatGPT usage limit. Try again in ~10 min.", "rate-limit"],
		["401 invalid_api_key", "authentication"],
		["503 temporarily unavailable", "overload"],
		["context_length_exceeded", "context"],
		["network timeout", "network"],
		["400 invalid_request", "invalid"],
		["insufficient_quota billing balance", "invalid"],
	] as const)("%s is %s", (text, kind) => {
		expect(detectFailure(assistant(terra, "high", text), true).kind).toBe(kind);
	});
	test("a non-GPT quota or user cancellation never triggers GPT failover", () => {
		expect(detectFailure(assistant(deepseek, "high", "usage_limit_reached"), false).kind).not.toBe("quota");
		const aborted = assistant(terra, "high", "usage_limit_reached");
		aborted.stopReason = "aborted";
		expect(detectFailure(aborted, true).kind).toBe("cancelled");
	});
	test("metadata extracts only recognized codes and provider reset times", () => {
		expect(
			streamEvidence({ error: { code: "rate_limit_exceeded", secret: "never-retain" } }, 1000),
		).toBeUndefined();
		const evidence = streamEvidence(
			{
				type: "response.failed",
				response: {
					error: {
						code: "usage_limit_reached",
						resets_at: 100,
						secret: "never-retain",
					},
				},
			},
			1000,
		);
		expect(evidence).toEqual({ code: "usage_limit_reached", notBefore: 100000 });
		expect(JSON.stringify(evidence)).not.toContain("never-retain");
		expect(detectFailure(assistant(terra, "high", "provider limit"), true, evidence).kind).toBe("quota");
	});
	test("Retry-After uses seconds or a valid HTTP date, not invented quota information", () => {
		expect(retryAfter("60", 1000)).toBe(61000);
		expect(retryAfter("Fri, 30 Oct 2026 12:00:00 GMT", 1000)).toBe(Date.parse("2026-10-30T12:00:00Z"));
		expect(retryAfter("invalid", 1000)).toBe(0);
	});
});

describe("native retry routing", () => {
	test("GPT exhaustion routes the failed generation to DeepSeek and clamps thinking", async () => {
		const f = fixture();
		await f.run();
		const result = await f.run({
			reason: "retry",
			failed: {
				model: terra,
				thinkingLevel: "medium",
				message: assistant(terra, "medium", "usage_limit_reached"),
			},
		});
		expect(result.model.id).toBe(deepseek.id);
		expect(result.thinkingLevel).toBe(clampThinkingLevel(deepseek, "medium"));
		expect(f.state().fallback).toBe(true);
		expect(f.state().fallbacks).toBe(1);
		expect(f.notifications).toHaveLength(1);
		expect(f.classify).toHaveBeenCalledTimes(1);
	});
	test("temporary rate limits, authentication errors, and overload preserve the failed pair", async () => {
		for (const text of ["429 rate_limit_exceeded", "401 invalid_api_key", "503 overloaded"]) {
			const f = fixture();
			await f.run();
			const result = await f.run({
				reason: "retry",
				failed: {
					model: terra,
					thinkingLevel: "high",
					message: assistant(terra, "high", text),
				},
			});
			expect(result.model.id).toBe(terra.id);
			expect(result.thinkingLevel).toBe("high");
			expect(f.state().fallback).toBe(false);
		}
	});
	test("cooldown expiry alone does not leave DeepSeek during an active work unit", async () => {
		const f = fixture();
		await f.run();
		await f.run({
			reason: "retry",
			failed: {
				model: terra,
				thinkingLevel: "high",
				message: assistant(terra, "high", "usage_limit_reached"),
			},
		});
		f.setTime(100000000);
		expect(
			(await f.run({ messages: [{ role: "user", content: "Fix a small issue.", timestamp: 2 }] })).model.id,
		).toBe(deepseek.id);
		expect(f.notifications).toHaveLength(1);
		f.manager.appendCustomEntry(CONTROL_ENTRY, {
			mode: "auto",
			boundaryToken: "safe-recovery",
		} satisfies Control);
		expect((await f.run()).model.id).toBe(terra.id);
		expect(f.state().fallback).toBe(false);
	});
	test("safe boundaries respect an active provider cooldown", async () => {
		const f = fixture();
		await f.run();
		await f.run({
			reason: "retry",
			failed: {
				model: terra,
				thinkingLevel: "high",
				message: assistant(terra, "high", "usage_limit_reached"),
			},
		});
		f.manager.appendCustomEntry(CONTROL_ENTRY, { mode: "auto", boundaryToken: "new" } satisfies Control);
		expect((await f.run()).model.id).toBe(deepseek.id);
		expect(f.state().why).toContain("cooldown");
	});
	test("missing fallback fails cleanly without selecting an unrelated provider", async () => {
		const f = fixture({}, [terra]);
		await f.run();
		await expect(
			f.run({
				reason: "retry",
				failed: {
					model: terra,
					thinkingLevel: "high",
					message: assistant(terra, "high", "usage_limit_reached"),
				},
			}),
		).rejects.toThrow("not authenticated or available");
		expect(f.notifications).toHaveLength(0);
	});
	test("fallback retries are strictly bounded and do not cycle back to GPT", async () => {
		const f = fixture();
		await f.run();
		await f.run({
			reason: "retry",
			failed: {
				model: terra,
				thinkingLevel: "high",
				message: assistant(terra, "high", "usage_limit_reached"),
			},
		});
		const retry = {
			reason: "retry" as const,
			failed: {
				model: deepseek,
				thinkingLevel: "high" as const,
				message: assistant(deepseek, "high", "503 unavailable"),
			},
		};
		expect((await f.run(retry)).model.id).toBe(deepseek.id);
		await expect(f.run(retry)).rejects.toThrow("retry limit");
		expect(f.notifications).toHaveLength(1);
	});
	test("manual override cannot bypass fallback stickiness in an active work unit", async () => {
		const f = fixture();
		await f.run();
		await f.run({
			reason: "retry",
			failed: {
				model: terra,
				thinkingLevel: "high",
				message: assistant(terra, "high", "usage_limit_reached"),
			},
		});
		f.manager.appendCustomEntry(CONTROL_ENTRY, {
			mode: "auto",
			boundaryToken: "",
			override: pair(terra),
			overrideToken: "override",
		} satisfies Control);
		await expect(f.run()).rejects.toThrow("cooldown");
	});
	test("usage cap includes observed input, output, and cache tokens", async () => {
		const f = fixture();
		const m = assistant(deepseek);
		m.usage = { ...m.usage, input: 100, output: 50, cacheRead: 1000, totalTokens: 1150 };
		f.manager.appendMessage(m);
		f.config.fallback.maxTokens = 1000;
		expect(() => assertFallbackBudget(f.config, f.manager.getEntries())).toThrow("token cap");
		f.config.fallback.maxTokens = 2000;
		expect(() => assertFallbackBudget(f.config, f.manager.getEntries())).not.toThrow();
		m.usage.totalTokens = 0;
		expect(() => assertFallbackBudget(f.config, f.manager.getEntries())).toThrow("accounting is unavailable");
	});
});

test("shared cooldown survives independent sessions, uses private atomic storage, and respects long reset times", () => {
	const directory = join(process.cwd(), ".test-artifacts", `cooldown-${crypto.randomUUID()}`);
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "cooldown.json");
	const f = fixture();
	f.config.fallback.sharedCooldownFile = path;
	const cooldown = nextCooldown(undefined, f.config, 1000, 999999999);
	expect(cooldown.until).toBe(901000);
	expect(cooldown.notBefore).toBe(999999999);
	try {
		expect(saveCooldown(f.config, "openai-codex", cooldown)).toBe(true);
		expect(readCooldowns(f.config)["openai-codex"]).toEqual(cooldown);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readFileSync(path, "utf8")).not.toContain("key");
		expect(saveCooldown(f.config, "openai-codex", { until: 1, notBefore: 0, failures: 0 })).toBe(true);
		expect(readCooldowns(f.config)["openai-codex"]).toEqual(cooldown);
		expect(nextCooldown({ until: 0, notBefore: 0, failures: 30 }, f.config, 1000).until).toBe(
			1000 + f.config.fallback.maxCooldownMs,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
