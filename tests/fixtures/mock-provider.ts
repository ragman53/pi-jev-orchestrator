// Test-only providers. This file is never included in the Pi package manifest.
import {
	type AssistantMessage,
	type ClassifierContext,
	type ClassifierResult,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const cost = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
function chat(id: string, deepseek = false): ProviderModelConfig {
	const levels = deepseek ? ["off", "low", "high", "max"] : ["low", "medium", "high", "xhigh", "max"];
	return {
		id,
		name: `Mock ${id}`,
		reasoning: true,
		input: ["text"],
		contextWindow: 272000,
		maxTokens: 16000,
		cost,
		thinkingLevelMap: Object.fromEntries(
			["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((x) => [
				x,
				levels.includes(x) ? x : null,
			]),
		),
	};
}
function usage() {
	return {
		input: 100,
		output: 50,
		cacheRead: 1000,
		cacheWrite: 0,
		totalTokens: 1150,
		cost: { input: 0.0002, output: 0.0005, cacheRead: 0.0002, cacheWrite: 0, total: 0.0009 },
	};
}
function classification(context: ClassifierContext): ClassifierResult {
	const text = String(context.state.request ?? "");
	const complex = /complex|architecture/i.test(text);
	const trivial = /trivial|spelling/i.test(text);
	const values: Record<string, string | boolean> = {
		category: complex ? "complex implementation" : trivial ? "other" : "standard implementation",
		complexity: complex ? "high" : trivial ? "trivial" : "medium",
		reasoning: complex ? "deep" : "moderate",
		uncertainty: complex ? "high" : "medium",
		risk: complex ? "high" : "medium",
		multiFile: !trivial,
		verification: !trivial,
		continuation: false,
	};
	const answers: ClassifierResult["answers"] = {};
	for (const [key, question] of Object.entries(context.questions)) {
		if (question.type === "choice") {
			const options = Object.keys(question.criteria);
			const selected = String(values[key]);
			answers[key] = {
				type: "choice",
				choice: selected,
				confidence: 0.95,
				probabilities: Object.fromEntries(
					options.map((x) => [x, x === selected ? 0.95 : 0.05 / (options.length - 1)]),
				),
			};
		} else if (question.type === "bool")
			answers[key] = { type: "bool", probability: values[key] ? 0.95 : 0.05 };
	}
	return {
		provider: "typesafe",
		model: "jev-latest",
		api: "test-classifier",
		answers,
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
export default function mocks(pi: ExtensionAPI): void {
	const scenario = process.env.JEV_TEST_SCENARIO ?? "success";
	let gptCalls = 0;
	let fallbackCalls = 0;
	let toolCalls = 0;
	pi.registerTool({
		name: "orchestrator_probe",
		label: "Probe",
		description: "A deterministic test operation.",
		parameters: Type.Object({}),
		async execute() {
			toolCalls++;
			return {
				content: [{ type: "text", text: `TOOL_EXECUTED_${toolCalls}` }],
				details: { executions: toolCalls },
			};
		},
	});
	pi.registerProvider("typesafe", {
		apiKey: "mock-not-a-real-credential",
		models: [
			{
				type: "classifier",
				id: "jev-latest",
				name: "Mock Jev",
				api: "test-classifier",
				input: ["text"],
				contextWindow: 32000,
				cost,
			},
		],
		classifiers: {
			"test-classifier": {
				async classify(_model, context) {
					process.stderr.write(
						`MOCK_CLASSIFY ${JSON.stringify({ keys: Object.keys(context.state), questions: Object.keys(context.questions) })}\n`,
					);
					if (scenario === "classifier-failure") throw new Error("mock classifier failure");
					return classification(context);
				},
			},
		},
	});
	for (const provider of ["openai-codex", "deepseek"]) {
		const isDeepseek = provider === "deepseek";
		pi.registerProvider(provider, {
			apiKey: "mock-not-a-real-credential",
			api: "test-chat",
			models: isDeepseek
				? [chat("deepseek-flash", true)]
				: [chat("gpt-6.1-terra"), chat("gpt-6.1-sol"), chat("gpt-6-astra")],
			streamSimple(model, context, options) {
				const stream = createAssistantMessageEventStream();
				void (async () => {
					if (isDeepseek) fallbackCalls++;
					else gptCalls++;
					const n = isDeepseek ? fallbackCalls : gptCalls;
					const results = context.messages.filter((m) => m.role === "toolResult");
					process.stderr.write(
						`MOCK_REQUEST ${JSON.stringify({
							provider,
							model: model.id,
							level: options?.reasoning ?? "off",
							calls: n,
							toolResults: results.map((m) => m.content),
							systemMessages: context.messages.filter((m) => m.role === "system").length,
						})}\n`,
					);
					await options?.onPayload?.({ mock: true }, model);
					let error: string | undefined;
					const quota = ["quota", "quota-after-tool", "quota-metadata", "fallback-fails"].includes(scenario);
					if (!isDeepseek && quota && (scenario !== "quota-after-tool" || results.length > 0))
						error = "usage_limit_reached";
					if (!isDeepseek && scenario === "quota-metadata") {
						error = "terminal provider limit";
						await options?.onProviderStreamEvent?.(
							{
								type: "response.failed",
								response: {
									error: { code: "usage_limit_reached", resets_at: Math.floor(Date.now() / 1000) + 3600 },
								},
							},
							model,
						);
					}
					if (!isDeepseek && scenario === "rate-limit" && n === 1) error = "429 rate_limit_exceeded";
					if (!isDeepseek && scenario === "ambiguous-codex")
						error = "You have hit your ChatGPT usage limit. Try again in ~5 min.";
					if (!isDeepseek && scenario === "auth-error") error = "401 invalid_api_key";
					if (isDeepseek && scenario === "fallback-fails") error = "503 temporarily unavailable";
					await options?.onResponse?.(
						{ status: error ? 429 : 200, headers: error && quota ? { "retry-after": "3600" } : {} },
						model,
					);
					const output: AssistantMessage = {
						role: "assistant",
						provider,
						model: model.id,
						api: model.api,
						content: [],
						usage: usage(),
						stopReason: error ? "error" : "stop",
						timestamp: Date.now(),
						errorMessage: error,
					};
					if (scenario === "quota-after-tool" && !isDeepseek && !error && results.length === 0) {
						output.stopReason = "toolUse";
						output.content = [
							{ type: "toolCall", id: "probe-once", name: "orchestrator_probe", arguments: {} },
						];
					} else if (!error)
						output.content = [
							{ type: "text", text: `MOCK_OK ${provider}/${model.id} tools=${results.length}` },
						];
					if (error) stream.push({ type: "error", reason: "error", error: output });
					else {
						stream.push({ type: "start", partial: output });
						stream.push({
							type: "done",
							reason: output.stopReason === "toolUse" ? "toolUse" : "stop",
							message: output,
						});
					}
					stream.end();
				})().catch(() => {
					const output: AssistantMessage = {
						role: "assistant",
						provider,
						model: model.id,
						api: model.api,
						content: [],
						usage: usage(),
						stopReason: "error",
						errorMessage: "mock fixture failed",
						timestamp: Date.now(),
					};
					stream.push({ type: "error", reason: "error", error: output });
					stream.end();
				});
				return stream;
			},
		});
	}
}
