# Compatibility audit

The audit used Pi 1.4.0, Bun 1.4.4, and Node 24.21.0.
The repository contained only the untracked `PROMPT.md`.
No project extensions or subagent definitions existed here.
No global extension directory or subagent workflow directory existed.

## Existing environment

The global packages were pi-web-access, pi-polish, pi-context-bar, pi-feedback, and pi-model-pick.
No package registered a virtual model or a `route` command.
pi-model-pick changes models only on explicit commands.
pi-polish changes tool guidance before a run.
The orchestrator does not replace either workflow or their tools.

Authenticated providers were `openai`, `typesafe`, and `deepseek`.
The OpenAI account uses subscription authentication.
`openai-codex` had no configured authentication.
No credentials were printed or changed.

The catalog contained `openai/gpt-5.6-terra` and `openai/gpt-6.1-sol`.
It did not contain GPT-6.1 Terra in the initial audit.
The later read-only amendment audit resolves authenticated `openai/gpt-6.1-terra`.
The default explicit aliases support both catalog snapshots.
It also contained `openai/gpt-6-astra` and `deepseek/deepseek-flash`.
Preferred IDs remain configurable. Compatible IDs are explicit, not fuzzy matches.

Terra supports off, low, medium, high, xhigh, and max.
Sol and Astra support low, medium, high, xhigh, and max.
DeepSeek Flash supports off, low, high, and max.
The implementation uses Pi's `clampThinkingLevel()` rather than a private mapping.

## Classifier

`typesafe/jev-latest` was authenticated.
One synthetic classification passed through `ModelRegistry.classify()`.
The request asked whether a spelling fix was low or high complexity.
Jev returned low with probability 1.
Usage was 330 input tokens and 33 output tokens.
The catalog price was zero. This is missing price information, not evidence of free service.
No repository content or transcript was sent for this check.

## Native contracts

The installed declarations expose `registerVirtualModel<T>()`.
Requests include reason, previous, failed, state, messages, and signal.
State is stored before dispatch, follows the active branch, and survives compaction.
Returning the same state object avoids another state entry.
Direct requests have no state, and Pi ignores returned state.
Assistant messages record the physical provider, model, and thinking level.

`findOfType("classifier", provider, id)` returns a classifier model.
`classify(model, context, options)` returns typed answers and optional usage.
Pi uses `bool` for TypeSafe yes/no questions.
Choice answers expose probabilities and normalized confidence.
The router gates changes on selected-answer probabilities, not confidence alone.

`getSettings()` exposes the effective settings.
The unset `cacheWarming` setting resolves to streaming in Pi.
`PI_CACHE_RETENTION` was not overridden for development.
Audited target models declared no prompt-cache lifetime.
Native warming therefore skips them unless catalog metadata changes.
The extension registers no warmer and changes no warming configuration.

Pi retries transient errors through Virtual Model requests with reason retry.
Pi excludes subscription exhaustion from ordinary retries.
For terminal subscription errors, `turn_end` records recovery evidence and a context edit.
The edit omits only the failed assistant attempt from future model context.
Pi 1.4.0 does not resume an errored low-level loop from `turn_end` alone.
The documented `agent_before_settle` boundary requests continuation after the error.
A persisted attempt marker prevents recovery loops.
The virtual router then selects the fallback through that native continuation.
Raw history and completed tool results remain intact.
There is no second agent loop and no rewritten provider error.

The legacy Codex adapter converts all JSON HTTP 429 responses into a usage-limit message.
That message cannot distinguish throttling from exhausted subscription quota.
The router does not fail over from that ambiguous wording alone.
Explicit error codes or unambiguous subscription-limit evidence are required.

Extension contexts expose read-only session managers.
There is no public extension method to append native usage entries.
Physical requests and native warming retain native accounting.
Classifier usage is stored as non-context custom entries and reported separately by `/route stats`.

## Thinking amendment findings

The amendment preserves the existing Virtual Model, branch state, and quota recovery.
The registry exposes Max above XHigh for authenticated Terra, Sol, and Astra.
Defaults use Medium/High for routine work, XHigh for complex work, and Max for exceptional work.
Astra remains disabled unless configured.

The current OpenAI account uses ChatGPT subscription sign-in.
The installed adapter rejects configuration updates for that authentication method.
Changing top-level reasoning effort can invalidate the hidden prompt prefix.
Automatic intra-model escalation is therefore disabled for this account.

Native-adapter tests use injected HTTP responses to distinguish the API-key and subscription wire paths.
No real OpenAI comparison requests were sent for this amendment.
The read-only `bun run audit` sends no model requests and blocks credential writes.
See [THINKING.md](THINKING.md) for verification scope and comparison limitations.

## Validation and local activation

`bun run check` passed type checking, Biome, and 134 tests.
The suite includes 26 native CLI integration cases and native-adapter wire tests.
All nine requested model/thinking variants dispatch correctly with mock providers.
Max quota failover preserves completed tools and stays on DeepSeek.
The synthetic benchmark also exercises a case where static Terra High costs less than sticky routing.

After validation, `pi install /home/chikob/dev/pi-jev-orchestrator` installed the supported local package.
Pi stored `../../dev/pi-jev-orchestrator` relative to its agent directory.
That reference resolves to this repository. No implementation was copied into the agent directory.
The original packages, default model, authentication file, and warming configuration remained unchanged.
A private pre-install configuration backup is in `.test-artifacts/activation-20261030T172607/settings.before.json`.
An isolated package-autoload smoke test listed `orchestrator/auto` without `-e` or a model request.
The user's default model remains unchanged. Selecting the orchestrator is explicit.

## References

The audit read the requested official pages and the installed documentation and declarations:

- https://pi.dev/docs/latest/extensions
- https://pi.dev/docs/latest/virtual-models
- https://pi.dev/docs/latest/models
- https://pi.dev/docs/latest/settings
- https://docs.typesafe.ai/agent-skill
- https://docs.typesafe.ai/llms.txt
- https://docs.typesafe.ai/primitives.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/jev-router.ts

The official example switches after the first edit.
This implementation uses its classifier and Virtual Model APIs, but does not use that phase switch.
Installed 1.4.0 declarations take precedence over newer web examples.
See `README.md` for development, installation, and known limits.
