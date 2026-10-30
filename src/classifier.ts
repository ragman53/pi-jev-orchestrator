import { createHash } from "node:crypto";
import type { ClassifierAnswer, ClassifierContext, ClassifierResult, Message } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";
import { splitModel } from "./config.ts";
import { CATEGORIES, type Classification, COMPLEXITIES } from "./state.ts";

const choice = (instructions: string, criteria: Record<string, string>) => ({
	type: "choice" as const,
	instructions,
	criteria,
});
const bool = (instructions: string, yes: string, no: string) => ({
	type: "bool" as const,
	instructions,
	criteria: { true: yes, false: no },
});
const severity = {
	low: "A local, well-understood change",
	medium: "Several details need checking",
	high: "Subtle dependencies or costly mistakes are plausible",
};

export const QUESTIONS: ClassifierContext["questions"] = {
	category: choice(
		"What development activity does `request` primarily describe?",
		Object.fromEntries(CATEGORIES.map((x) => [x, x])),
	),
	complexity: choice("How difficult is the development work in `request`?", {
		trivial: "A spelling fix, factual answer, or similarly mechanical action",
		low: "A small local change with an established solution",
		medium: "An ordinary feature, test suite, or subsystem refactor",
		high: "Subtle debugging, coordinated modules, or difficult design",
		exceptional: "An unusually hard reasoning problem beyond ordinary complex engineering",
	}),
	reasoning: choice("How much reasoning does the requested work require?", {
		shallow: "A direct action with little analysis",
		moderate: "Several steps with familiar tradeoffs",
		deep: "Dependent constraints need careful analysis",
	}),
	uncertainty: choice("How uncertain is the implementation approach in `request`?", severity),
	risk: choice("How serious is the risk of incorrect modifications in `request`?", {
		low: "A local mistake is easy to detect and undo",
		medium: "A mistake can affect several behaviors",
		high: "A mistake can harm data, security, or cross-module correctness",
	}),
	multiFile: bool(
		"Does the work require coordinated changes across modules?",
		"Several modules must agree",
		"One local change or no module changes",
	),
	verification: bool(
		"Does the result require independent verification?",
		"Tests or a separate correctness review are needed",
		"A direct answer or a mechanical text edit is sufficient",
	),
	continuation: bool(
		"Does `request` continue the work described in `activeWork`?",
		"The same goal is unfinished or receiving feedback",
		"A separate goal is requested, or no active work exists",
	),
};

export function currentUser(messages: readonly Message[]): { text: string; key: string } {
	const m = messages.findLast((m) => m.role === "user");
	const content = m?.content ?? "";
	const text =
		typeof content === "string"
			? content
			: content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
	return {
		text,
		key: createHash("sha256")
			.update(`${m?.timestamp ?? 0}:${text}`)
			.digest("hex"),
	};
}
export function explicitBoundary(text: string): boolean {
	return /^(?:new task|new topic|independent task|unrelated task)\s*:/i.test(text.trimStart());
}
export function deterministicClassification(): Classification {
	return {
		category: "standard implementation",
		complexity: "medium",
		reasoning: "moderate",
		uncertainty: "medium",
		risk: "medium",
		multiFile: false,
		verification: true,
		continuationProbability: 0,
		confidence: 0,
		probabilities: { category: 0, complexity: 0 },
		source: "deterministic",
	};
}
function probability(n: unknown): number {
	if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1)
		throw new Error("Invalid classifier probability.");
	return n;
}
function answerChoice<T extends string>(
	a: ClassifierAnswer | undefined,
	options: readonly T[],
): { value: T; p: number } {
	if (a?.type !== "choice" || !options.includes(a.choice as T)) throw new Error("Invalid classifier choice.");
	const probabilities = options.map((x) => probability(a.probabilities[x]));
	const p = probability(a.probabilities[a.choice]);
	if (p < Math.max(...probabilities) || Math.abs(probabilities.reduce((x, y) => x + y, 0) - 1) > 0.05)
		throw new Error("Invalid classifier distribution.");
	return { value: a.choice as T, p };
}
function answerBool(a: ClassifierAnswer | undefined): number {
	if (a?.type !== "bool") throw new Error("Invalid classifier boolean.");
	return probability(a.probability);
}
export function parseClassification(result: ClassifierResult): Classification {
	if (result.stopReason !== "stop") throw new Error("Classification did not complete.");
	const a = result.answers;
	const category = answerChoice(a.category, CATEGORIES);
	const complexity = answerChoice(a.complexity, COMPLEXITIES);
	const reasoning = answerChoice(a.reasoning, ["shallow", "moderate", "deep"] as const);
	const risk = answerChoice(a.risk, ["low", "medium", "high"] as const);
	const multiFile = answerBool(a.multiFile);
	const verification = answerBool(a.verification);
	const probabilities = {
		category: category.p,
		complexity: complexity.p,
		reasoning: reasoning.p,
		risk: risk.p,
		multiFile: multiFile >= 0.7 ? multiFile : 1 - multiFile,
		verification: verification >= 0.7 ? verification : 1 - verification,
	};
	return {
		category: category.value,
		complexity: complexity.value,
		reasoning: reasoning.value,
		uncertainty: answerChoice(a.uncertainty, ["low", "medium", "high"] as const).value,
		risk: risk.value,
		multiFile: multiFile >= 0.7,
		verification: verification >= 0.7,
		continuationProbability: answerBool(a.continuation),
		confidence: Math.min(...Object.values(probabilities)),
		probabilities,
		source: "jev",
	};
}
export interface ClassificationAttempt {
	classification: Classification;
	called: boolean;
	failed: boolean;
}
export async function classifyWork(
	registry: ModelRegistry,
	config: Config,
	text: string,
	active: Classification | undefined,
	signal?: AbortSignal,
	record?: (result: ClassifierResult) => void,
): Promise<ClassificationAttempt> {
	const [provider, id] = splitModel(config.classifier.model);
	const model = registry.findOfType("classifier", provider, id);
	if (!model || !registry.getProviderAuthStatus(provider).configured) {
		return { classification: deterministicClassification(), called: false, failed: true };
	}
	const limit = config.classifier.maxRequestChars;
	const request =
		text.length <= limit
			? text
			: `${text.slice(0, Math.floor(limit * 0.75))}\n[request truncated]\n${text.slice(-Math.floor(limit * 0.25))}`;
	const timeout = AbortSignal.timeout(config.classifier.timeoutMs);
	try {
		const result = await registry.classify(
			model,
			{
				state: {
					request,
					activeWork: active ? { category: active.category, complexity: active.complexity } : null,
				},
				questions: QUESTIONS,
			},
			{ signal: signal ? AbortSignal.any([signal, timeout]) : timeout, maxRetries: 0 },
		);
		record?.(result);
		if (signal?.aborted) throw new Error("Routing cancelled.");
		return { classification: parseClassification(result), called: true, failed: false };
	} catch {
		if (signal?.aborted) throw new Error("Routing cancelled.");
		return { classification: deterministicClassification(), called: true, failed: true };
	}
}
