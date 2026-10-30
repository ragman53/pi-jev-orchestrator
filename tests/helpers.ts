import { mock } from "bun:test";
import type {
	Api,
	AssistantMessage,
	ClassifierContext,
	ClassifierResult,
	Model,
	ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
	type ExtensionContext,
	type ModelRegistry,
	SessionManager,
	VIRTUAL_MODEL_STATE_ENTRY,
} from "@earendil-works/pi-coding-agent";
import { emptyUsage } from "../src/cache.ts";
import { QUESTIONS } from "../src/classifier.ts";
import { type Config, DEFAULT_CONFIG } from "../src/config.ts";
import { type Request, route } from "../src/router.ts";
import {
	type Classification,
	MODEL_ID,
	type Pair,
	PROVIDER,
	type RouteState,
	readState,
} from "../src/state.ts";

export function model(
	provider: string,
	id: string,
	levels: ModelThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"],
): Model<Api> {
	return {
		id,
		provider,
		name: id,
		api: "openai-responses",
		baseUrl: "https://mock.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
		contextWindow: 272000,
		maxTokens: 16000,
		thinkingLevelMap: Object.fromEntries(
			["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((x) => [
				x,
				levels.includes(x as ModelThinkingLevel) ? x : null,
			]),
		),
	};
}
export const terra = model("openai-codex", "gpt-6.1-terra");
export const sol = model("openai-codex", "gpt-6.1-sol");
export const astra = model("openai-codex", "gpt-6-astra");
export const deepseek = model("deepseek", "deepseek-flash", ["off", "low", "high", "max"]);
export const virtual = model(PROVIDER, MODEL_ID);
virtual.api = "pi-virtual";
export function classified(partial: Partial<Classification> = {}): ClassifierResult {
	const values: Classification = {
		category: "standard implementation",
		complexity: "medium",
		reasoning: "moderate",
		uncertainty: "medium",
		risk: "medium",
		multiFile: true,
		verification: true,
		continuationProbability: 0,
		confidence: 0.95,
		probabilities: { category: 0.95, complexity: 0.95 },
		source: "jev",
		...partial,
	};
	const answers: ClassifierResult["answers"] = {};
	for (const [key, question] of Object.entries(QUESTIONS)) {
		if (question.type === "choice") {
			const selected = values[key as keyof Classification] as string;
			const choices = Object.keys(question.criteria);
			const p = values.confidence;
			answers[key] = {
				type: "choice",
				choice: selected,
				confidence: p,
				probabilities: Object.fromEntries(
					choices.map((x) => [x, x === selected ? p : (1 - p) / (choices.length - 1)]),
				),
			};
		} else if (question.type === "bool") {
			answers[key] = {
				type: "bool",
				probability:
					key === "continuation"
						? values.continuationProbability
						: values[key as "multiFile" | "verification"]
							? 0.95
							: 0.05,
			};
		}
	}
	return {
		api: "typesafe",
		provider: "typesafe",
		model: "jev-latest",
		answers,
		stopReason: "stop",
		timestamp: 100,
		usage: { ...emptyUsage(), input: 100, output: 50, totalTokens: 150 },
	};
}
export function assistant(m = terra, level: ModelThinkingLevel = "high", error?: string): AssistantMessage {
	return {
		role: "assistant",
		provider: m.provider,
		model: m.id,
		api: m.api,
		content: [],
		thinkingLevel: level,
		stopReason: error ? "error" : "stop",
		errorMessage: error,
		usage: emptyUsage(),
		timestamp: 100,
	};
}
export function fixture(partial: Partial<Classification> = {}, models = [terra, sol, astra, deepseek]) {
	const manager = SessionManager.inMemory(process.cwd());
	let answer = classified(partial);
	const calls: ClassifierContext[] = [];
	const classify = mock(async (_m: unknown, context: ClassifierContext) => {
		calls.push(context);
		return answer;
	});
	const registry = {
		find: (p: string, id: string) =>
			p === PROVIDER && id === MODEL_ID ? virtual : models.find((m) => m.provider === p && m.id === id),
		hasConfiguredAuth: () => true,
		getProviderAuthStatus: () => ({ configured: true }),
		findOfType: () => ({ id: "jev-latest", provider: "typesafe", cost: emptyUsage().cost }),
		classify,
		getAvailable: () => models,
		isUsingOAuth: (m: Model<Api>) => ["openai", "openai-codex"].includes(m.provider),
	} as unknown as ModelRegistry;
	const ctx: ExtensionContext = {
		cwd: process.cwd(),
		mode: "print",
		hasUI: false,
		ui: {} as ExtensionContext["ui"],
		model: virtual,
		scopedModels: [],
		thinkingLevel: "medium",
		signal: undefined,
		sessionManager: manager,
		modelRegistry: registry,
		isIdle: () => true,
		isProjectTrusted: () => false,
		abort: () => {},
		shutdown: () => {},
		hasPendingMessages: () => false,
		getContextUsage: () => ({ tokens: 40000, contextWindow: 272000, percent: 15 }),
		getSystemPrompt: () => "unchanged",
		compact: () => {
			throw Error("Router must not compact.");
		},
	};
	const config: Config = structuredClone(DEFAULT_CONFIG);
	config.fallback.sharedCooldownFile = null;
	let clock = 1000000;
	const notifications: string[] = [];
	const records: ClassifierResult[] = [];
	const request = (overrides: Partial<Request> = {}): Request => ({
		model: virtual,
		thinkingLevel: "medium",
		reason: "user",
		state: readState(manager.getBranch()),
		messages: [{ role: "user", content: "Implement a feature.", timestamp: 1 }],
		...overrides,
	});
	const run = async (overrides: Partial<Request> = {}) => {
		const req = request(overrides);
		const result = await route(req, ctx, config, {
			now: () => clock,
			notify: (text) => notifications.push(text),
			recordClassification: (result) => records.push(result),
		});
		if (req.reason !== "direct" && result.state && result.state !== req.state) {
			manager.appendCustomEntry(VIRTUAL_MODEL_STATE_ENTRY, {
				provider: PROVIDER,
				modelId: MODEL_ID,
				state: result.state,
			});
		}
		return result;
	};
	return {
		manager,
		registry,
		ctx,
		config,
		classify,
		calls,
		run,
		request,
		notifications,
		records,
		setAnswer: (c: Partial<Classification>) => {
			answer = classified(c);
		},
		setTime: (now: number) => {
			clock = now;
		},
		state: () => readState(manager.getBranch()) as RouteState,
	};
}
export const pair = (m: Model<Api>, thinkingLevel: ModelThinkingLevel = "high"): Pair => ({
	provider: m.provider,
	id: m.id,
	thinkingLevel,
});
