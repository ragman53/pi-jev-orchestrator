import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";
import { cooldownPath } from "./config.ts";
import type { Cooldown, Cooldowns } from "./state.ts";

export interface Failure {
	kind:
		| "quota"
		| "rate-limit"
		| "authentication"
		| "context"
		| "network"
		| "overload"
		| "invalid"
		| "cancelled"
		| "other";
	notBefore: number;
}
export interface Evidence {
	code?: string;
	notBefore: number;
}
const QUOTA_CODES = [
	"usage_limit_reached",
	"subscription_sharing_usage_limit_exceeded",
	"subscription_sharing_workplace_individual_usage_limit_exceeded",
];
function object(v: unknown): Record<string, unknown> | undefined {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
export function retryAfter(value: string | undefined, now: number): number {
	if (!value) return 0;
	const seconds = Number(value);
	const date = Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000 : Date.parse(value);
	return Number.isFinite(date) && date > now ? date : 0;
}
/** Retain only a recognized code and reset time, never arbitrary stream payloads. */
export function streamEvidence(data: unknown, now: number): Evidence | undefined {
	const root = object(data);
	const error = object(root?.error) ?? object(object(root?.response)?.error);
	const code = error?.code ?? error?.type;
	if (typeof code !== "string" || !QUOTA_CODES.includes(code)) return undefined;
	const reset = error?.resets_at;
	return {
		code,
		notBefore: typeof reset === "number" && Number.isFinite(reset) && reset * 1000 > now ? reset * 1000 : 0,
	};
}
export function detectFailure(
	message: AssistantMessage,
	eligibleProvider: boolean,
	evidence?: Evidence,
): Failure {
	const text = message.errorMessage ?? "";
	const result = (kind: Failure["kind"]): Failure => ({ kind, notBefore: evidence?.notBefore ?? 0 });
	if (message.stopReason === "aborted") return result("cancelled");
	if (message.stopReason !== "error") return result("other");
	if (/context_length_exceeded|context window|maximum context|prompt is too long/i.test(text))
		return result("context");
	if (/invalid_api_key|unauthorized|authentication|token expired|\b401\b|\b403\b/i.test(text))
		return result("authentication");
	if (
		eligibleProvider &&
		(QUOTA_CODES.some((code) => new RegExp(`\\b${code}\\b`, "i").test(text)) ||
			(evidence?.code && QUOTA_CODES.includes(evidence.code)))
	)
		return result("quota");
	// The legacy Codex adapter uses this wording for *all* JSON 429s. It is not quota evidence.
	if (/You have hit your ChatGPT usage limit/i.test(text)) return result("rate-limit");
	if (/rate.?limit|too many requests|\b429\b/i.test(text)) return result("rate-limit");
	if (/overload|server_busy|\b50[0234]\b|temporarily unavailable/i.test(text)) return result("overload");
	if (/timeout|timed out|network|fetch failed|ECONNRESET|socket hang up/i.test(text))
		return result("network");
	if (/invalid.request|\b400\b|insufficient_quota|billing/i.test(text)) return result("invalid");
	return result("other");
}
export function nextCooldown(
	previous: Cooldown | undefined,
	config: Config,
	now: number,
	notBefore = 0,
): Cooldown {
	const failures = Math.min(32, (previous?.failures ?? 0) + 1);
	const delay = Math.min(config.fallback.maxCooldownMs, config.fallback.cooldownMs * 2 ** (failures - 1));
	return {
		until: Math.max(previous?.until ?? 0, now + delay),
		notBefore: Math.max(previous?.notBefore ?? 0, notBefore),
		failures,
	};
}
export function mergeCooldowns(a: Cooldowns, b: Cooldowns): Cooldowns {
	const result: Cooldowns = { ...a };
	for (const [provider, c] of Object.entries(b)) {
		const previous = result[provider];
		result[provider] = {
			until: Math.max(previous?.until ?? 0, c.until),
			notBefore: Math.max(previous?.notBefore ?? 0, c.notBefore),
			failures: Math.max(previous?.failures ?? 0, c.failures),
		};
	}
	return result;
}
export function readCooldowns(config: Config): Cooldowns {
	const path = cooldownPath(config);
	if (!path) return {};
	try {
		const data = JSON.parse(readFileSync(path, "utf8")) as { version?: number; providers?: unknown };
		const providers = object(data.providers);
		if (data.version !== 1 || !providers) throw new Error("Invalid cooldown state.");
		const result: Cooldowns = {};
		for (const [provider, value] of Object.entries(providers)) {
			const c = object(value);
			if (
				!["openai", "openai-codex"].includes(provider) ||
				!c ||
				!["until", "notBefore", "failures"].every(
					(k) => typeof c[k] === "number" && Number.isFinite(c[k]) && c[k] >= 0,
				)
			)
				throw new Error("Invalid cooldown state.");
			result[provider] = c as unknown as Cooldown;
		}
		return result;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error("Cannot read the shared orchestrator cooldown. Repair that state file before routing.");
	}
}
/** Atomic, locked, bounded state. A busy writer leaves the branch-local cooldown authoritative. */
export function saveCooldown(config: Config, provider: string, cooldown: Cooldown): boolean {
	const path = cooldownPath(config);
	if (!path) return true;
	let lock: number | undefined;
	const lockPath = `${path}.lock`;
	const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		lock = openSync(lockPath, "wx", 0o600);
		const providers = mergeCooldowns(readCooldowns(config), { [provider]: cooldown });
		writeFileSync(temp, JSON.stringify({ version: 1, providers }), { mode: 0o600, flag: "wx" });
		renameSync(temp, path);
		return true;
	} catch {
		return false;
	} finally {
		if (lock !== undefined) {
			closeSync(lock);
			try {
				unlinkSync(lockPath);
			} catch {
				/* Another cleanup cannot affect routing. */
			}
		}
		try {
			unlinkSync(temp);
		} catch {
			/* No temporary file on the normal path. */
		}
	}
}
export function assertFallbackBudget(config: Config, entries: readonly SessionEntry[]): void {
	const cap = config.fallback.maxTokens;
	if (cap === null) return;
	const target = config.models.fallback;
	const keys = [target.preferred, ...target.compatible];
	let tokens = 0;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const m = entry.message;
			if (!keys.includes(`${m.provider}/${m.model}`)) continue;
			if (m.stopReason !== "error" && m.stopReason !== "aborted" && m.usage.totalTokens <= 0) {
				throw new Error(
					"Fallback token accounting is unavailable. The configured usage cap blocks another request.",
				);
			}
			tokens += m.usage.totalTokens;
		} else if (entry.type === "usage" && keys.includes(`${entry.provider}/${entry.model}`)) {
			tokens += entry.usage.totalTokens;
		}
	}
	if (tokens >= cap)
		throw new Error("The fallback token cap was reached. No further fallback request was sent.");
}
