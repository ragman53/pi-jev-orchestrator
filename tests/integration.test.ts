import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { MODEL_ID, PROVIDER, readState } from "../src/state.ts";
import { COMPARISON_LEVELS, pairMetrics } from "../src/stats.ts";

interface MockRequest {
	provider: string;
	model: string;
	level: string;
	calls: number;
	toolResults: unknown[];
	systemMessages: number;
}
interface Event {
	type: string;
	message?: AssistantMessage;
	toolName?: string;
	entry?: { customType?: string; data?: unknown };
}

function environment(patch = {}) {
	const dir = join(process.cwd(), ".test-artifacts", `integration-${crypto.randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "settings.json"),
		JSON.stringify({
			cacheWarming: "off",
			enableInstallTelemetry: false,
			lastChangelogVersion: "1.4.0",
			retry: { enabled: true, maxRetries: 4, baseDelayMs: 0, maxAgentDelayMs: 0 },
		}),
	);
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify({ fallback: { sharedCooldownFile: null }, ...patch }),
	);
	return dir;
}
function sessionPath(dir: string, name: string): string {
	const project = `--${process
		.cwd()
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
	return join(dir, "sessions", project, `${name}.jsonl`);
}
function invoke(
	dir: string,
	scenario = "success",
	messages = ["Implement a feature."],
	options: {
		session?: string;
		fork?: string;
		flags?: string[];
	} = {},
) {
	if (options.session) mkdirSync(dirname(options.session), { recursive: true });
	const args = [
		"pi",
		"--offline",
		"--no-extensions",
		"-e",
		"./tests/fixtures/mock-provider.ts",
		"-e",
		"./index.ts",
		"--model",
		"orchestrator/auto",
		"--no-skills",
		"--no-themes",
		"--no-prompt-templates",
		"--no-context-files",
		"--tools",
		"orchestrator_probe",
		"--mode",
		"json",
		"--session-dir",
		dir,
		...(options.session
			? ["--session", options.session]
			: options.fork
				? ["--fork", options.fork]
				: ["--no-session"]),
		...(options.flags ?? []),
		...messages,
	];
	const child = Bun.spawnSync(args, {
		cwd: process.cwd(),
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: dir,
			PI_CODING_AGENT_SESSION_DIR: join(dir, "sessions"),
			JEV_ORCHESTRATOR_CONFIG: join(dir, "config.json"),
			JEV_TEST_SCENARIO: scenario,
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 20000,
		maxBuffer: 8 * 1024 * 1024,
	});
	const stdout = child.stdout.toString();
	const stderr = child.stderr.toString();
	const events: Event[] = stdout
		.split("\n")
		.filter((x) => x.startsWith("{"))
		.map((x) => JSON.parse(x));
	const requests: MockRequest[] = stderr
		.split("\n")
		.filter((x) => x.startsWith("MOCK_REQUEST "))
		.map((x) => JSON.parse(x.slice(13)));
	return {
		code: child.exitCode,
		stdout,
		stderr,
		events,
		requests,
		classifications: stderr.split("\n").filter((x) => x.startsWith("MOCK_CLASSIFY ")).length,
		assistants: events
			.filter((e) => e.type === "message_end" && e.message?.role === "assistant")
			.map((e) => e.message as AssistantMessage),
	};
}

const existingPackages = ["pi-web-access", "pi-polish", "pi-context-bar", "pi-feedback", "pi-model-pick"].map(
	(name) => join(homedir(), ".pi/agent/npm/node_modules", name),
);

describe("installed Pi CLI with -e (no network or real quotas)", () => {
	test.skipIf(existingPackages.some((path) => !existsSync(path)))(
		"installed global packages remain compatible in an isolated agent",
		() => {
			const run = invoke(environment(), "success", ["Implement a feature.", "/route status"], {
				flags: existingPackages.flatMap((path) => ["-e", path]),
			});
			expect(run.code).toBe(0);
			expect(run.classifications).toBe(1);
			expect(run.requests[0]?.model).toBe("gpt-6.1-terra");
			expect(run.stderr).not.toContain("Failed to load extension");
		},
	);
	test("orchestrator/auto is present in the native model selector catalog", () => {
		const run = invoke(environment(), "success", [], { flags: ["--list-models", "orchestrator"] });
		expect(run.code).toBe(0);
		expect(run.stdout + run.stderr).toContain(PROVIDER);
		expect(run.stdout + run.stderr).toContain(MODEL_ID);
		expect(run.classifications).toBe(0);
	});
	test.each([
		["Implement a feature.", "gpt-6.1-terra", "high"],
		["Implement a complex coordinated feature.", "gpt-6.1-sol", "xhigh"],
		["Make a trivial spelling fix.", "gpt-6.1-terra", "medium"],
	] as const)("physical assistant metadata is correct for %s", (prompt, model, level) => {
		const run = invoke(environment(), "success", [prompt]);
		expect(run.code).toBe(0);
		expect(run.classifications).toBe(1);
		expect(run.assistants.at(-1)?.model).toBe(model);
		expect(run.assistants.at(-1)?.thinkingLevel).toBe(level);
		expect(run.assistants.at(-1)?.provider).toBe("openai-codex");
	});
	test.each(
		Object.entries(COMPARISON_LEVELS).flatMap(([role, levels]) =>
			levels.map((level) => [role, level] as const),
		),
	)("native routing and measured comparison for %s / %s", (role, level) => {
		const dir = environment({
			policy: [{ role, thinking: level }],
			models: { astra: { preferred: "openai-codex/gpt-6-astra", compatible: [] } },
		});
		const session = sessionPath(dir, "comparison");
		const run = invoke(
			dir,
			"success",
			["Implement a feature.", "Continue the same feature.", "/route outcome pass", "/route stats"],
			{ session },
		);
		expect(run.code).toBe(0);
		expect(run.requests).toHaveLength(2);
		expect(
			run.requests.every(
				(r) => r.model === `gpt-${role === "astra" ? "6" : "6.1"}-${role}` && r.level === level,
			),
		).toBe(true);
		expect(run.classifications).toBe(1);
		const state = readState(SessionManager.open(session).getBranch());
		if (!state) throw new Error("Missing comparison routing state");
		const metrics = pairMetrics(SessionManager.open(session).getBranch(), state.selected);
		expect(metrics.completedWorkUnits).toBe(1);
		expect(metrics.userReportedPasses).toBe(1);
		expect(metrics.cacheHitRatio).toBeGreaterThan(0);
		expect(metrics.meanCompletedGenerationMs).toBeGreaterThanOrEqual(0);
		expect(metrics.costPerReportedSuccessUsd).toBeCloseTo(0.0018);
		expect(run.stderr).toContain("meanCompletedGenerationMs");
	});
	test("max quota failover preserves completed tools and the strongest supported fallback level", () => {
		const run = invoke(environment({ policy: [{ role: "terra", thinking: "max" }] }), "quota-after-tool");
		expect(run.code).toBe(0);
		expect(run.requests.map((r) => r.level)).toEqual(["max", "max", "max"]);
		expect(run.events.filter((e) => e.type === "tool_execution_end")).toHaveLength(1);
		expect(run.assistants.at(-1)?.provider).toBe("deepseek");
	});
	test("terminal quota failover resumes natively without replaying completed tools", () => {
		const run = invoke(environment(), "quota-after-tool");
		expect(run.code).toBe(0);
		expect(run.requests.map((r) => r.provider)).toEqual(["openai-codex", "openai-codex", "deepseek"]);
		expect(run.requests.map((r) => r.level)).toEqual(["high", "high", "high"]);
		expect(run.events.filter((e) => e.type === "tool_execution_end")).toHaveLength(1);
		expect(JSON.stringify(run.requests.at(-1)?.toolResults)).toContain("TOOL_EXECUTED_1");
		expect(run.assistants.at(-1)?.provider).toBe("deepseek");
		expect(run.assistants.at(-1)?.thinkingLevel).toBe("high");
		expect(run.classifications).toBe(1);
		expect(run.stderr.match(/Continuing on deepseek/g)).toHaveLength(1);
		expect(run.requests.every((r) => r.systemMessages === 1)).toBe(true);
		expect(
			run.events.filter(
				(e) => e.type === "entry_appended" && e.entry?.customType === "pi.virtual-model-state",
			),
		).toHaveLength(2);
	});
	test("transient 429 uses Pi's native retry with the same physical pair", () => {
		const run = invoke(environment(), "rate-limit");
		expect(run.code).toBe(0);
		expect(run.requests).toHaveLength(2);
		expect(run.requests.every((r) => r.provider === "openai-codex" && r.level === "high")).toBe(true);
		expect(run.events.some((e) => e.type === "auto_retry_start")).toBe(true);
		expect(run.classifications).toBe(1);
	});
	test.each(["auth-error", "ambiguous-codex"])("%s does not spend fallback usage", (scenario) => {
		const run = invoke(environment(), scenario);
		expect(run.requests).toHaveLength(1);
		expect(run.requests[0]?.provider).toBe("openai-codex");
		expect(run.assistants.at(-1)?.stopReason).toBe("error");
	});
	test("explicit stream metadata is enough when adapter error text is generic", () => {
		const dir = environment();
		const session = sessionPath(dir, "metadata");
		const run = invoke(dir, "quota-metadata", ["Implement a feature."], { session });
		expect(run.code).toBe(0);
		expect(run.requests.map((r) => r.provider)).toEqual(["openai-codex", "deepseek"]);
		const state = readState(SessionManager.open(session).getBranch());
		expect(state?.cooldowns["openai-codex"]?.notBefore).toBeGreaterThan(Date.now() + 3500000);
	});
	test("fallback failure terminates at the router retry cap without a GPT cycle", () => {
		const run = invoke(environment(), "fallback-fails");
		expect(run.requests.map((r) => r.provider)).toEqual(["openai-codex", "deepseek", "deepseek"]);
		expect(run.assistants.at(-1)?.stopReason).toBe("error");
		expect(run.assistants.at(-1)?.errorMessage).toContain("retry limit");
		expect(run.stderr.match(/Continuing on deepseek/g)).toHaveLength(1);
	});
	test("resume and fork preserve the selected work unit without another Jev call", () => {
		const dir = environment();
		const session = sessionPath(dir, "resume");
		const first = invoke(dir, "success", ["Implement a complex feature."], { session });
		expect(first.code).toBe(0);
		const state = readState(SessionManager.open(session).getBranch());
		expect(state).toBeDefined();
		const resume = invoke(dir, "success", ["Fix one small follow-up issue."], { session });
		expect(resume.code).toBe(0);
		expect(resume.classifications).toBe(0);
		expect(resume.requests[0]?.model).toBe("gpt-6.1-sol");
		expect(resume.requests[0]?.level).toBe("xhigh");
		expect(readState(SessionManager.open(session).getBranch())?.workUnitId).toBe(state?.workUnitId);
		const fork = invoke(dir, "success", ["Continue the implementation."], { fork: session });
		expect(fork.code).toBe(0);
		expect(fork.classifications).toBe(0);
		expect(fork.requests[0]?.model).toBe("gpt-6.1-sol");
	});
	test("fallback remains selected after restart even with a functioning GPT mock", () => {
		const dir = environment();
		const session = sessionPath(dir, "fallback");
		expect(invoke(dir, "quota", ["Implement a feature."], { session }).code).toBe(0);
		const resumed = invoke(dir, "success", ["Continue."], { session });
		expect(resumed.requests.map((r) => r.provider)).toEqual(["deepseek"]);
		expect(resumed.classifications).toBe(0);
	});
	test("commands are native, inspectable, branch-local, and do not trigger model calls", () => {
		const run = invoke(environment(), "success", [
			"Implement a feature.",
			"/route status",
			"/route why",
			"/route stats",
			"/route lock",
			"Fix a small follow-up.",
			"/route unlock",
			"/route use sol xhigh",
			"Continue.",
			"/route new",
			"Implement a complex subsystem.",
			"/route reset",
			"Make a trivial edit.",
		]);
		expect(run.code).toBe(0);
		expect(run.requests).toHaveLength(5);
		expect(run.requests[0]?.model).toBe("gpt-6.1-terra");
		expect(run.requests[1]?.level).toBe("high");
		expect(run.requests[2]?.model).toBe("gpt-6.1-sol");
		expect(run.requests[2]?.level).toBe("xhigh");
		expect(run.classifications).toBe(3);
		expect(run.stderr).toContain("subscription");
		expect(run.stderr).toContain("workUnit");
	});
	test("configured fallback cap blocks another native generation rather than silently overspending", () => {
		const run = invoke(environment({ fallback: { sharedCooldownFile: null, maxTokens: 1 } }), "quota", [
			"Implement a feature.",
			"Continue.",
		]);
		expect(run.requests.map((r) => r.provider)).toEqual(["openai-codex", "deepseek"]);
		expect(run.assistants.at(-1)?.errorMessage).toContain("token cap");
	});
	test("invalid configuration fails before a provider request and does not echo secret-like input", () => {
		const dir = environment({ classifier: { timeoutMs: "secret-never-echo" } });
		const run = invoke(dir);
		expect(run.code).not.toBe(0);
		expect(run.requests).toHaveLength(0);
		expect(run.stderr).toContain("Invalid orchestrator configuration");
		expect(run.stderr).not.toContain("secret-never-echo");
		expect(readFileSync(join(dir, "config.json"), "utf8")).toContain("secret-never-echo");
	});
});
