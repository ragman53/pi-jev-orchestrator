import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { VIRTUAL_MODEL_STATE_ENTRY } from "@earendil-works/pi-coding-agent";

export const PROVIDER = "orchestrator";
export const MODEL_ID = "auto";
export const CONTROL_ENTRY = "jev-orchestrator.control";
export const CLASSIFIER_ENTRY = "jev-orchestrator.classification";
export const PERFORMANCE_ENTRY = "jev-orchestrator.performance";
export const OUTCOME_ENTRY = "jev-orchestrator.outcome";
export const RECOVERY_ENTRY = "jev-orchestrator.recovery";
export const RECOVERY_ATTEMPT_ENTRY = "jev-orchestrator.recovery-attempt";

export const CATEGORIES = [
	"exploration",
	"documentation",
	"small code modification",
	"standard implementation",
	"complex implementation",
	"debugging",
	"refactoring",
	"architecture",
	"testing",
	"code review",
	"research",
	"other",
] as const;
export const COMPLEXITIES = ["trivial", "low", "medium", "high", "exceptional"] as const;
export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Category = (typeof CATEGORIES)[number];
export type Complexity = (typeof COMPLEXITIES)[number];
export type Severity = "low" | "medium" | "high";
export type Role = "terra" | "sol" | "astra" | "fallback";

export interface Classification {
	category: Category;
	complexity: Complexity;
	reasoning: "shallow" | "moderate" | "deep";
	uncertainty: Severity;
	risk: Severity;
	multiFile: boolean;
	verification: boolean;
	continuationProbability: number;
	/** Minimum selected probability for routing factors, not normalized Jev confidence. */
	confidence: number;
	probabilities: {
		category: number;
		complexity: number;
		reasoning?: number;
		risk?: number;
		multiFile?: number;
		verification?: number;
	};
	source: "jev" | "deterministic";
}

export interface Pair {
	provider: string;
	id: string;
	thinkingLevel: ModelThinkingLevel;
}

export interface Cooldown {
	until: number;
	/** A provider-supplied reset can outlast the bounded local backoff. */
	notBefore: number;
	failures: number;
}
export type Cooldowns = Record<string, Cooldown>;

export interface Decision {
	at: number;
	workUnitId: string;
	selected: Pair;
	reason: string;
	category: Category;
	complexity: Complexity;
	confidence: number;
	estimatedCacheLossUsd?: number;
}

export interface RouteState {
	version: 1;
	workUnitId: string;
	workIndex: number;
	startedAt: number;
	/** Performance records cover this work unit from its first request. */
	measurementVersion?: 1;
	resetToken?: string;
	overrideToken?: string;
	selected: Pair;
	classification: Classification;
	sticky: true;
	fallback: boolean;
	why: string;
	boundaryToken: string;
	requestKey: string;
	lastSwitchWorkIndex: number;
	switches: number;
	fallbacks: number;
	classifierCalls: number;
	classifierErrors: number;
	classifierUnavailableUntil: number;
	retryKey: string;
	retryCount: number;
	totalRetries: number;
	cooldowns: Cooldowns;
	handledRecoveryId?: string;
	history: Decision[];
}

export interface Control {
	mode: "auto" | "lock" | "off";
	locked?: Pair;
	boundaryToken: string;
	resetToken?: string;
	/** Explicit user instructions, consumed once by the next routed request. */
	override?: Pair;
	overrideToken?: string;
}

export interface Recovery {
	provider: string;
	model: string;
	thinkingLevel: ModelThinkingLevel;
	notBefore: number;
}

export function modelKey(pair: Pick<Pair, "provider" | "id">): string {
	return `${pair.provider}/${pair.id}`;
}

export function samePair(a: Pair, b: Pair): boolean {
	return modelKey(a) === modelKey(b) && a.thinkingLevel === b.thinkingLevel;
}

export function isPair(value: unknown): value is Pair {
	if (!value || typeof value !== "object") return false;
	const p = value as Partial<Pair>;
	return (
		typeof p.provider === "string" &&
		typeof p.id === "string" &&
		LEVELS.includes(p.thinkingLevel as ModelThinkingLevel)
	);
}

export function readState(branch: readonly SessionEntry[]): RouteState | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "custom" || entry.customType !== VIRTUAL_MODEL_STATE_ENTRY) continue;
		const data = entry.data as { provider?: string; modelId?: string; state?: unknown } | undefined;
		if (data?.provider === PROVIDER && data.modelId === MODEL_ID) return checkedState(data.state);
	}
	return undefined;
}

export function checkedState(value: unknown): RouteState | undefined {
	if (value === undefined) return undefined;
	const s = value as Partial<RouteState> | null;
	if (
		s?.version !== 1 ||
		!isPair(s.selected) ||
		typeof s.workUnitId !== "string" ||
		!s.classification ||
		!CATEGORIES.includes(s.classification.category) ||
		!COMPLEXITIES.includes(s.classification.complexity) ||
		!Array.isArray(s.history) ||
		typeof s.cooldowns !== "object" ||
		s.cooldowns === null ||
		!Number.isFinite(s.workIndex) ||
		!Number.isFinite(s.retryCount)
	) {
		throw new Error("Unsupported orchestrator state. Run /route reset before continuing.");
	}
	return s as RouteState;
}

export function readControl(branch: readonly SessionEntry[], enabled: boolean): Control {
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e?.type !== "custom" || e.customType !== CONTROL_ENTRY) continue;
		const c = e.data as Control;
		if (
			!c ||
			!["auto", "lock", "off"].includes(c.mode) ||
			typeof c.boundaryToken !== "string" ||
			(c.locked !== undefined && !isPair(c.locked)) ||
			(c.override !== undefined && !isPair(c.override))
		) {
			throw new Error("Invalid orchestrator controls. Run /route reset.");
		}
		return c;
	}
	return { mode: enabled ? "auto" : "off", boundaryToken: "" };
}

export function latestRecovery(branch: readonly SessionEntry[]): { id: string; data: Recovery } | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e?.type === "custom" && e.customType === RECOVERY_ENTRY) {
			const r = e.data as Recovery;
			if (
				r &&
				isPair({ provider: r.provider, id: r.model, thinkingLevel: r.thinkingLevel }) &&
				Number.isFinite(r.notBefore)
			)
				return { id: e.id, data: r };
		}
	}
	return undefined;
}

export function latestPhysical(branch: readonly SessionEntry[]): Pair | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (
			e?.type === "message" &&
			e.message.role === "assistant" &&
			e.message.api !== "pi-virtual" &&
			e.message.stopReason !== "error" &&
			e.message.stopReason !== "aborted"
		) {
			return {
				provider: e.message.provider,
				id: e.message.model,
				thinkingLevel: e.message.thinkingLevel ?? "medium",
			};
		}
	}
	return undefined;
}
