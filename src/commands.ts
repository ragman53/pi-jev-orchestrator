import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { availableModel, modelFor, pairFor, resolveTarget } from "./policy.ts";
import {
	CONTROL_ENTRY,
	type Control,
	LEVELS,
	latestPhysical,
	MODEL_ID,
	modelKey,
	OUTCOME_ENTRY,
	PROVIDER,
	type Role,
	readControl,
	readState,
} from "./state.ts";
import { stats } from "./stats.ts";
import { assertVerifiedThinkingChange, thinkingCacheAssessment } from "./thinking.ts";

export function display(
	ctx: ExtensionContext,
	message: string,
	level: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else process.stderr.write(`${message}\n`);
}
export function registerCommands(pi: ExtensionAPI): void {
	const subcommands = [
		"status",
		"why",
		"auto",
		"off",
		"lock",
		"unlock",
		"new",
		"stats",
		"reset",
		"use",
		"outcome",
	];
	pi.registerCommand("route", {
		description:
			"Inspect or control sticky routing: status, why, auto, off, lock, unlock, new, stats, reset, use, outcome",
		getArgumentCompletions: (prefix) => {
			const items = subcommands.filter((x) => x.startsWith(prefix)).map((value) => ({ value, label: value }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const [command = "status", role, level, ...extra] = args.trim().split(/\s+/).filter(Boolean);
			try {
				const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
				if (!subcommands.includes(command))
					throw new Error("Use /route status|why|auto|off|lock|unlock|new|stats|reset|use|outcome.");
				if (!["use", "outcome"].includes(command) && role)
					throw new Error("This route subcommand takes no arguments.");
				if (command === "stats") {
					display(ctx, JSON.stringify(stats(ctx, config), null, 2));
					return;
				}
				const branch = ctx.sessionManager.getBranch();
				if (command === "status" || command === "why") {
					const state = readState(branch);
					const control = readControl(branch, config.enabled);
					const actual = latestPhysical(branch);
					const physicalModel = actual ? availableModel(ctx.modelRegistry, modelKey(actual)) : undefined;
					if (command === "why") display(ctx, state?.why ?? "No work unit was routed yet.");
					else
						display(
							ctx,
							JSON.stringify(
								{
									selection: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
									physical: actual ? `${modelKey(actual)} / ${actual.thinkingLevel}` : null,
									routedPair: state?.selected ?? null,
									workUnit: state?.workUnitId ?? null,
									mode: control.mode,
									sticky: state?.sticky ?? true,
									fallback: state?.fallback ?? false,
									thinkingCache: physicalModel
										? await thinkingCacheAssessment(physicalModel, ctx.modelRegistry)
										: null,
									pendingNewWorkUnit: control.boundaryToken !== (state?.boundaryToken ?? ""),
									cooldowns: state?.cooldowns ?? {},
								},
								null,
								2,
							),
						);
					return;
				}
				if (!ctx.isIdle()) throw new Error("Wait until Pi is idle before changing routing controls.");
				if (command === "outcome") {
					if (!role || !["pass", "fail"].includes(role) || level || extra.length)
						throw new Error(
							"Use /route outcome pass|fail after checking the work. This records a user-reported outcome.",
						);
					const state = readState(branch);
					if (!state) throw new Error("No routed work unit is available to annotate.");
					pi.appendEntry(OUTCOME_ENTRY, { workUnitId: state.workUnitId, outcome: role, source: "user" });
					display(ctx, "Recorded the user-reported work-unit outcome. No model request was sent.");
					return;
				}
				const token = crypto.randomUUID();
				const control: Control =
					command === "reset"
						? { mode: "auto", boundaryToken: token, resetToken: token }
						: { ...readControl(branch, config.enabled) };
				if (command === "lock") {
					const physical =
						ctx.model?.api !== "pi-virtual" && ctx.model
							? pairFor(ctx.model, ctx.thinkingLevel ?? "medium")
							: latestPhysical(branch);
					if (!physical)
						throw new Error("No physical model answered yet. Select a physical model before locking it.");
					modelFor(physical, ctx.modelRegistry);
					control.mode = "lock";
					control.locked = physical;
					delete control.override;
					delete control.overrideToken;
				} else if (command === "off") {
					control.mode = "off";
				} else if (command === "new") {
					control.boundaryToken = token;
				} else if (command === "auto" || command === "unlock") {
					control.mode = "auto";
					delete control.locked;
					delete control.override;
					delete control.overrideToken;
				} else if (command === "use") {
					if (
						!role ||
						!["terra", "sol", "astra"].includes(role) ||
						!level ||
						!LEVELS.includes(level as (typeof LEVELS)[number]) ||
						extra.length
					)
						throw new Error("Use /route use terra|sol|astra low|medium|high|xhigh|max.");
					const state = readState(branch);
					if (state?.fallback && control.boundaryToken === state.boundaryToken)
						throw new Error("Run /route new before leaving the active fallback.");
					const model = resolveTarget(role as Role, config, ctx.modelRegistry);
					if (!model) throw new Error("That configured model is unavailable or disabled.");
					const selected = pairFor(model, level as (typeof LEVELS)[number]);
					if (state && control.boundaryToken === state.boundaryToken)
						await assertVerifiedThinkingChange(state.selected, selected, model, ctx.modelRegistry, branch);
					control.override = selected;
					control.overrideToken = token;
					control.mode = "auto";
				}
				if (["auto", "unlock", "lock", "reset", "use"].includes(command)) {
					const virtual = ctx.modelRegistry.find(PROVIDER, MODEL_ID);
					if (!virtual || !(await pi.setModel(virtual)))
						throw new Error("The orchestrator virtual model could not be selected.");
				}
				pi.appendEntry(CONTROL_ENTRY, control);
				display(
					ctx,
					command === "new" || command === "reset"
						? "A new work unit will start on the next user request. Provider cooldowns and usage accounting are retained."
						: `Routing control updated: ${command}.`,
				);
			} catch (error) {
				display(ctx, error instanceof Error ? error.message : "Routing command failed.", "error");
			}
		},
	});
}
