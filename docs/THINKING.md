# Thinking levels and cache verification

The thinking amendment extends the existing router.
It does not replace its continuation, retry, or fallback paths.
`max` is a supported candidate above `xhigh`, not an alias for it.

## Installed registry and authentication

The read-only amendment audit used Pi 1.4.0.
It selected `openai/gpt-6.1-terra` and `openai/gpt-6.1-sol`.
Both expose Medium, High, XHigh, and Max.
The authenticated `openai/gpt-6-astra` also exposes High and Max, but routing to Astra remains opt-in.

The initial audit did not expose GPT-6.1 Terra.
The later effective catalog does.
Defaults already contain both explicit identities, so this change needs no fuzzy model lookup.
Run `bun run audit` for the current registry rather than assuming either snapshot still applies.

## Current subscription sign-in

Cache preservation across thinking changes is not verified for the current ChatGPT OAuth path.
OAuth is the existing subscription sign-in.
This result applies even when the model declares `supportsMidConvoEffort`.

OpenAI documents an append-only `configuration_update` item for compatible GPT-6 models.
With this mechanism, the request-level `reasoning.effort` stays fixed.
OpenAI also states that changing request-level effort can rewrite hidden instructions.

Pi 1.4.0 explicitly disables configuration updates for ChatGPT sign-in.
Its native adapter changes request-level effort instead.
The cache key can remain identical while the hidden prompt prefix changes.
An unchanged cache key is therefore insufficient evidence.

The router blocks automatic same-model level changes for this authentication.
It also blocks explicit level changes inside the active work unit.
A user can start a new work unit and make a fresh selection at Max.
The extension does not claim cache preservation for that fresh selection.

## Verified native API-key path

The positive verification covers the documented native request format, not guaranteed remote cache residency.
It requires all of the following:

- The physical model uses `openai-responses` under `openai`.
- The resolved endpoint is the standard OpenAI API endpoint.
- The model registry declares mid-conversation effort support.
- The resolved authentication is a direct OpenAI API key, not subscription sign-in.
- No custom provider transport or authorization-header override replaces that path.
- The latest successful physical response carries Pi's matching `providerThinkingLevel` metadata.

These conditions prevent a catalog flag from enabling escalation under incompatible authentication.
They also prevent an old prefix from inheriting verification after an authentication or transport change.
Unknown paths fail closed.
There is no configuration switch that asserts verification without these checks.

Offline tests invoke Pi's actual native adapter with injected HTTP responses.
For API-key authentication, the tests prove that High-to-Max keeps top-level effort fixed and preserves the prior input prefix.
For synthetic subscription authentication, they prove that top-level effort changes and no configuration update appears.
The HTTP client never reaches a real provider.

## Choosing thinking before another model

Automatic reconsideration happens only at a safe new-work boundary.
Ordinary tool execution, feedback, and retries preserve the selected level.
An explicit verified user change can also update the current level.

Before an otherwise justified physical switch, the router lists every supported higher level on the current model.
This list includes Max when the registry supports it.
If the current level is Max, no higher level exists.

A verified path alone does not prove that Terra Max can replace Sol XHigh.
The router compares recorded work units with matching category, complexity, and risk.
Defaults require at least three completed, user-reported work units for each compared pair.
The preferred higher level must meet these conditions:

- Its reported success rate meets the configured minimum and is no worse than the policy target.
- Its generation cost per reported success is no greater.
- Its summed generation latency stays within the configured ratio.
- Its observed cache reuse is no worse.

The router includes failed reported work in the cost denominator calculation.
Unknown cost, incomplete outcomes, mismatched cohorts, or sparse samples reject the preference.
If no higher level qualifies, the original physical-model decision remains in force.
A capability switch is not treated as free cache transfer.

The defaults are `minCompletedWorkUnits: 3`, `minSuccessRate: 0.8`, and `maxLatencyRatio: 1.25`.
These are conservative policy thresholds, not statistical proof.
`preferCurrentModel: false` disables the preference without weakening cache verification.

## Comparison and limitations

The comparison table covers nine variants:

| Model role | Thinking variants        |
| ---------- | ------------------------ |
| Terra      | High, XHigh, Max         |
| Sol        | Medium, High, XHigh, Max |
| Astra      | High, Max                |

`/route stats` shows supported and available variants separately.
A disabled Astra role does not become a routing target through the comparison.
Unknown measurements remain null.

After checking the task, use `/route outcome pass` or `/route outcome fail`.
The latest annotation replaces the earlier outcome for that work unit on the current branch.
Further generation invalidates that annotation until the user checks the updated result.
The extension does not infer task success from a normal assistant stop.

Per-response cache, cost, and latency observations remain visible without an outcome.
Completion comparisons require an outcome and exclude units that changed model or level.
Old sessions without performance records cannot supply the missing latency or task association.
Partially measured work units also stay outside completion-cost comparisons.
Mixed fallback units remain in native accounting but do not prove the quality of one model/level pair.

No live nine-variant trial was run for this amendment.
The implementation does not claim that Max is always better, faster, or cheaper.
The tests demonstrate supported dispatch, measurement, conservative decisions, and cache-safe request construction.
They do not rank real coding ability.

## Sources

- [OpenAI reasoning effort](https://developers.openai.com/api/docs/guides/reasoning#reasoning-effort).
- [OpenAI mid-conversation configuration updates](https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation).
- [OpenAI prompt caching and effort changes](https://developers.openai.com/api/docs/guides/prompt-caching#change-reasoning-effort-without-rewriting-the-prefix).
- Installed Pi 1.4.0: `pi-ai/dist/api/openai-responses.js`, especially `getConfigurationUpdateEffort()` and `buildParams()`.
- Installed Pi 1.4.0: `pi-ai/dist/api/openai-responses-shared.js` for effort metadata replay.
- Installed Pi 1.4.0: `getSupportedThinkingLevels()` and `clampThinkingLevel()`.
