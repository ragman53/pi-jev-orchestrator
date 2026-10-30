# Jev Orchestrator for Pi

A Pi extension that selects an authenticated coding model for a work unit.
A work unit is one continuous development task.
The extension keeps the physical model and thinking level fixed through tools, tests, corrections, and ordinary follow-ups.

The target is successful task completion at low total cost.
The extension does not optimize the next request in isolation.
It does not install another agent loop, provider account, or cache warmer.

## Requirements and defaults

This repository targets the installed Pi 1.4.0 API.
Development uses Bun and TypeScript.
Pi supplies the SDK packages at runtime.

The virtual model is `orchestrator/auto`.
Actual assistant messages retain their physical provider, model, and thinking level.
The latest audit selected `openai/gpt-6.1-terra` and `openai/gpt-6.1-sol` with the existing subscription sign-in.
Earlier Terra catalog versions remain explicit compatible choices.
Astra is disabled by default.

| Work                                           | Default target                  | Thinking |
| ---------------------------------------------- | ------------------------------- | -------- |
| Trivial work, documentation, local changes     | Terra                           | Medium   |
| Standard implementation, moderate refactoring  | Terra                           | High     |
| Complex implementation, debugging, refactoring | Sol                             | XHigh    |
| Architecture, critical review                  | Sol                             | XHigh    |
| Exceptional reasoning                          | Astra if enabled, otherwise Sol | Max      |

`max` is above `xhigh`.
Pi's model registry determines the supported levels.
Pi's native clamping selects a supported level when a requested level is unavailable.
Explicit configuration can still select Low, Sol Medium, Sol High, or Astra High.

These rules choose a candidate, not an unconditional switch.
Low confidence, active work, switch hysteresis, or missing cost evidence can preserve the current pair.
Hysteresis requires enough work-unit boundaries between changes.
See [the thinking amendment](docs/THINKING.md) for escalation rules and cache restrictions.

## Development and validation

Keep all implementation, examples, tests, and documentation here.
Do not copy extension code into the Pi agent directory.

```sh
bun install --ignore-scripts
bun run check
bun run benchmark
bun run audit
```

`check` runs type checking, Biome, unit tests, and native CLI integration tests.
Integration tests invoke the installed `pi` with `-e ./index.ts` and test-only providers.
They redirect Pi files into the ignored `.test-artifacts/` directory.
They do not use real provider quotas.

`audit` reads the installed catalog and existing credential metadata.
It uses an in-memory catalog and blocks credential writes and refreshes.
It sends no classification or coding request.
It does not print credentials.

For a one-process trial with your existing accounts:

```sh
pi -e /absolute/path/to/pi-jev-orchestrator --model orchestrator/auto
```

This trial can send normal requests to your authenticated models.
For offline tests instead, run `bun run test:integration`.
Do not load `tests/fixtures/mock-provider.ts` in normal work.

## Installation and removal

After all checks pass, install this repository as a supported local Pi package:

```sh
pi install /absolute/path/to/pi-jev-orchestrator
```

Pi records a local package reference in its configuration.
It can store that reference relative to the Pi agent directory.
It resolves the reference to this repository without copying the implementation.
The package manifest exposes only `index.ts`.
Installation does not change your default model, authentication, or cache-warming mode.

In Pi, use `/reload`, then select `orchestrator/auto` with `/model`.
Alternatively, use `/route auto`.
Existing explicit model-selection commands remain available.

To remove the extension:

```sh
pi remove /absolute/path/to/pi-jev-orchestrator
```

Reload Pi and select your previous physical model.
Native session history and usage entries remain intact.
Keep a backup of your previous Pi configuration before installation.

## Configuration

Defaults live in [src/config.ts](src/config.ts).
The optional global file is `~/.pi/agent/jev-orchestrator.json`.
`JEV_ORCHESTRATOR_CONFIG` selects a different JSON file.
A specified but missing file is an error.

Examples in this repository:

- [Complete default configuration](examples/jev-orchestrator.json).
- [Authenticated OpenAI aliases from the latest audit](examples/audited-openai.json).
- [Optional Astra enablement](examples/astra-enabled.json).

Configuration objects merge with defaults.
A policy array replaces the whole ordered policy.
The final policy rule must match all remaining requests.
Unknown fields and invalid values stop routing before dispatch.

`allowProjectOverrides` defaults to false.
If you explicitly enable it and trust the project, `.pi/jev-orchestrator.json` can override the global policy.
Untrusted projects cannot change routing policy through this file.

Model identities are exact `provider/id` values.
Each role has an ordered preferred identity and explicit compatible identities.
Unavailable Astra falls back to Sol, then Terra.
Unavailable Sol falls back to Terra.
Unavailable Terra falls back to Sol.
A substituted Terra retains the requested reasoning budget, with at least High and native clamping.
The router never scans for an unrelated cheap model.

## Work units and controls

The first request starts a work unit and normally calls Jev once.
Jev receives only the bounded current request and compact task facts.
It does not receive the transcript or system prompt.
A failed or uncertain classification uses a conservative policy or keeps the prior pair.

Use `/route new` for an independent task.
Prefixes such as `New task:` and `Independent task:` also mark clear boundaries.
Ordinary messages, long input, tool calls, and test failures do not start new work units.
An uncertain boundary continues the current work.

| Command                | Effect                                                                            |
| ---------------------- | --------------------------------------------------------------------------------- |
| `/route status`        | Show the selected and physical models, work unit, cooldowns, and cache assessment |
| `/route why`           | Explain the latest decision and any rejected thinking escalation                  |
| `/route auto`          | Select the virtual model and enable automatic selection                           |
| `/route off`           | Retain the physical pair without automatic selection                              |
| `/route lock`          | Lock the current physical model and level                                         |
| `/route unlock`        | Restore automatic selection                                                       |
| `/route new`           | Start a fresh work unit on the next request                                       |
| `/route use terra max` | Request a configured role and supported thinking level                            |
| `/route outcome pass`  | Record a user-reported result after checking the work                             |
| `/route outcome fail`  | Record or replace a user-reported failure                                         |
| `/route stats`         | Report native usage and the nine model/level comparison rows                      |
| `/route reset`         | Clear routing controls and start fresh, but retain usage and provider cooldowns   |

Changing controls requires an idle agent.
A manual thinking change inside an active work unit requires verified cache behavior.
With the current subscription sign-in, start fresh before selecting a different level:

```text
/route new
/route use terra max
```

That is an explicit fresh selection, not a claim that the old cache survives.
A manual override does not call Jev just to collect statistics.
For task-matched evaluation, use a policy rule for the desired variant and leave normal work-unit classification enabled.

## Cache and fallback

Continuations reuse the previous successful physical pair.
Native retries reuse the failed pair unless confirmed subscription exhaustion requires fallback.
Direct operations, including compaction, do not classify or update work-unit state.
Pi checks the chosen physical model's context limit and performs its normal compaction.

Optional monetary switches require known prices, observed usage, a remaining-work estimate, and known cache lifetime.
Defaults do not invent the remaining request count.
The audited models do not declare cache lifetime.
Optional price-driven changes therefore remain conservative.
A clearly harder new task can justify a capability change after hysteresis and confidence checks.

Before an automatic physical switch, the router considers higher supported thinking levels on the current model.
It rejects this option when cache preservation is unverified.
For a verified path, it also requires comparable successful-work evidence, bounded latency, cache reuse, and total generation cost.
No automatic thinking or model changes occur during ordinary continuation.

Confirmed GPT subscription exhaustion selects the existing authenticated DeepSeek Flash account.
The failed generation resumes through Pi's native lifecycle.
Completed tool results stay in context and successful operations do not replay.
A partial failed tool turn stops rather than risking duplicate operations.

DeepSeek remains selected until a safe new-work boundary.
Provider cooldowns prevent repeated GPT probes.
Shared cooldown state uses a private, atomic file under the Pi agent directory.
`fallback.sharedCooldownFile: null` disables that shared file for isolated tests.

The fallback token cap checks observed native usage before each request.
One request can exceed the threshold before its usage is known.
It is not a hard invoice limit.
Missing usage blocks further capped fallback requests.

## Measurement limits

`/route stats` reports native input, output, cache-read, cache-write, and cost estimates.
Classifier accounting is separate because Pi exposes no public extension method to append native classifier usage entries.
Zero classifier prices mean unknown pricing, not free service.

Generation latency includes routing and classification and excludes tool execution and time waiting for the user.
User-reported outcomes are not independent proof of success.
Mixed-model or mixed-thinking work units do not supply pair-specific completion evidence.
Failed reported work units contribute to cost per reported success.

Subscription catalog costs are comparison estimates, not per-request bills.
Exact remaining subscription quota is unknown.
Shared warming and compaction costs remain in native totals but lack per-work-unit allocation.
Historical sessions without performance records have unknown comparison measurements.
Partially measured work units cannot supply completion-cost evidence.
Further work invalidates an earlier completion annotation until you check the result again.

The old Codex adapter labels all JSON HTTP 429 errors as ChatGPT usage limits.
That ambiguous wording alone does not trigger DeepSeek spending.
Recognized quota codes or native structured error evidence are required.

See [the audit](docs/AUDIT.md), [thinking/cache findings](docs/THINKING.md), and [synthetic comparison](docs/BENCHMARK.md).
No live nine-variant quality benchmark is claimed.
