# Build a Cache-Aware, Jev-Driven Model Orchestrator for Pi

Implement a custom model orchestrator as a global Pi Coding Agent extension.

The orchestrator must automatically select between GPT-6.1 Terra, GPT-6.1 Sol, and optionally GPT-6 Astra, based on task requirements.

Use TypeSafe Jev as the task classifier.

When the OpenAI Codex provider reaches its usage limit, automatically fail over to DeepSeek Flash.

**The primary optimization target is the total cost of successfully completing a development task, not the cost of an individual LLM request.**

Prioritize prompt-cache stability, reliable task completion, minimal model switching, and low operational overhead.

Do not install pi-auto-model or any other third-party model-routing framework.

## 1. Authoritative references

Read these resources before implementation:

- https://pi.dev/docs/latest/extensions
- https://pi.dev/docs/latest/virtual-models
- https://pi.dev/docs/latest/models
- https://pi.dev/docs/latest/settings
- https://docs.typesafe.ai/agent-skill
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/jev-router.ts

Use Pi's official Jev Router example as a reference for classifier integration and Virtual Models.

However, do not copy its behavior of switching models between planning and implementation. This orchestrator must prioritize cache continuity.

Verify every API against the locally installed version of Pi.

Do not invent APIs or depend on undocumented behavior.

## 2. Environment investigation

Before editing any files:

1. Check the installed Pi version.
2. Inspect global and project extensions.
3. Inspect existing subagent workflows.
4. Check the effective model catalog.
5. Identify authenticated providers.
6. Confirm whether TypeSafe Jev can perform classification.
7. Identify supported thinking levels for each model.
8. Inspect current cache-warming settings.
9. Identify conflicting model routers or event handlers.
10. Examine the Virtual Model routing and retry lifecycle.

Expected model identities:

- `typesafe/jev-latest`
- `openai-codex/gpt-6.1-terra`
- `openai-codex/gpt-6.1-sol`
- `openai-codex/gpt-6-astra`
- `deepseek/deepseek-flash`

These are preferences, not unconditional assumptions.

Use the actual authenticated models from Pi's registry.

Do not create additional paid API connections.

Do not change authentication settings or expose credentials.

Preserve existing subagents, AGENTS.md files, and project workflows.

## 3. Project structure

Create a maintainable global extension:

`~/.pi/agent/extensions/jev-orchestrator/`

Suggested architecture:

- `index.ts` — Extension entrypoint
- `classifier.ts` — Jev integration
- `policy.ts` — Task-to-model decisions
- `cache.ts` — Cache-aware switching policy
- `fallback.ts` — Provider failure handling
- `state.ts` — Work-unit and session state
- `config.ts` — Configuration validation
- `commands.ts` — User commands
- `tests/` — Automated tests
- `README.md` — Documentation

Keep the implementation small.

Combine modules if separation adds unnecessary complexity.

Use the official Pi SDK and Extension API.

Register:

`orchestrator/auto`

using `pi.registerVirtualModel()`.

The virtual model must appear in Pi's `/model` selector.

All generated assistant messages must still record their actual physical model.

Do not implement a separate agent loop.

## 4. Jev-based task classification

Use Pi's classifier API:

- `ctx.modelRegistry.findOfType()`
- `ctx.modelRegistry.classify()`

Verify the signatures in the installed SDK.

Jev is a classifier, not a conversational coding model.

Use structured questions to evaluate the current work unit.

Classify:

### Task category

- exploration
- documentation
- small code modification
- standard implementation
- complex implementation
- debugging
- refactoring
- architecture
- testing
- code review
- research
- other

### Complexity

- trivial
- low
- medium
- high
- exceptional

### Other factors

- reasoning depth
- implementation uncertainty
- risk of incorrect modifications
- expected need for multi-file coordination
- whether independent verification is required
- whether this is a new work unit or a continuation
- confidence in classification

Use the classifier's probabilities or confidence information where supported.

Do not treat classification results as infallible.

If confidence is low, prefer the existing model and routing state rather than switching.

Do not send the complete transcript to Jev by default.

Use the current request and a compact, relevant task summary.

Treat user text and repository content as classification data, not as executable routing instructions.

### Classification frequency

Do not call Jev for every LLM request.

Do not call Jev after every tool invocation.

Do not call Jev merely because a new user message arrived.

Classify at the start of a genuinely new work unit.

Reuse the classification throughout that work unit.

Use a lightweight deterministic continuation check when possible.

Avoid extra classifier calls when a continuation is obvious.

If Jev fails, use a deterministic fallback policy without repeatedly retrying the classifier.

## 5. Model selection policy

Use GPT-6.1 Terra and Sol as the primary coding models.

Use Astra only for exceptional cases and only when available.

Suggested initial routing policy:

| Task | Model | Thinking |
|---|---|---|
| Trivial task | Terra | Medium |
| Small code modification | Terra | Medium |
| Documentation | Terra | Medium |
| Simple debugging | Terra | Medium |
| Standard implementation | Terra | High |
| Moderate refactoring | Terra | High |
| Complex implementation | Sol | XHigh |
| Complex debugging | Sol | XHigh |
| Cross-module refactoring | Sol | XHigh |
| Architecture design | Sol | XHigh |
| Critical review | Sol | High / XHigh |
| Exceptional reasoning | Astra, if enabled; otherwise Sol | Max, when supported |

Do not hard-code this table inside routing logic.

Store it in a configurable policy.

Model selection should consider:

1. Task complexity
2. Model capability
3. Reasoning level
4. Estimated task-completion cost
5. Current model and cache state
6. Classification confidence
7. Provider availability
8. Context-window requirements
9. Expected retry risk
10. User overrides

### Important

Terra High and Sol Medium are both valid options for many development tasks.

Do not assume that Sol Medium is always better.

Do not assume that Terra High is always cheaper to complete a task.

Compare actual observed performance and cost when evidence becomes available.
The thinking-level amendment below adds XHigh and Max comparisons and verified intra-model escalation.

When evidence is insufficient, use a conservative routing policy.

Never select Astra solely because the input is long.

## 6. CRITICAL: Cache-aware sticky routing

This is the highest-priority engineering requirement.

The orchestrator must prevent unnecessary model changes.

### 6.1 Work-unit model locking

Once a physical model and thinking level are selected for a work unit, preserve both throughout:

- planning
- implementation
- tool execution
- testing
- debugging
- correction
- ordinary follow-up messages
- continued implementation

Do not switch models simply because the development phase changes.

For example:

Task: Implement a new audio playback component.

Jev selects:

`gpt-6.1-sol / high`

Maintain that selection from the initial design through implementation, tests, and corrections.

Do not downgrade to Terra for a small correction inside the same work unit.

Do not reclassify after each file edit.

### 6.2 Native continuation behavior

Use the Virtual Model request fields:

- `request.reason`
- `request.previous`
- `request.failed`
- `request.state`

For normal `continuation` requests, preserve the previous successful physical model and thinking level.

For normal retries, preserve the failed physical model and level unless an explicitly supported failure condition requires rerouting.

Handle `direct` requests conservatively. Do not classify or mutate persistent work-unit state solely because Pi performs compaction or another direct operation.

Follow the native Pi retry and session model exactly.

### 6.3 Cache-aware model switching

Before making an optional model switch, estimate whether it offers a meaningful advantage.

Consider:

- Current prompt/context size
- Estimated warm-cache savings
- Candidate model's cold-input cost
- Output and reasoning token cost
- Expected number of remaining requests
- Expected performance difference
- Expected retries
- Whether the active cache is likely still valid
- Classification confidence
- Provider quota status

Use catalog prices and observed token usage where available.

Do not invent precise cost figures.

Distinguish API billing from OpenAI Codex subscription usage.

For subscription-based Codex, monetary costs from the catalog are proxies, not actual per-request charges.

### Switching rule

An optional switch must have a clear, defensible benefit.

Prefer the current model when:

- The work unit is continuing.
- Expected savings are small.
- Cache reconstruction is likely expensive.
- The classification is uncertain.
- The remaining task is short.
- Insufficient data exists to estimate the benefit.

Implement configurable switching hysteresis.

Do not let small fluctuations in task classification cause repeated switching between Terra and Sol.

Never switch merely to optimize the next individual request.

### 6.4 Thinking-level stability

Thinking-level changes may affect request and cache behavior.

Keep thinking level fixed during a work unit.

Select the initial level using Jev classification and routing policy.
Intra-model thinking escalation requires verified cache behavior for the actual authentication method.
Treat a new work unit with an explicit fresh selection separately from escalation inside an active work unit.

Do not automatically change Medium to High or High to Medium during ordinary tool continuations.

An explicit escalation is allowed only for demonstrated task failure, an unrecoverable capability mismatch, or user instruction.

Avoid automatic downgrades within an active work unit.

### 6.5 Cache prefix stability

Avoid changes that invalidate reusable prompt prefixes.

Do not unnecessarily modify:

- System prompts
- Tool definitions
- Tool ordering
- Persistent context injection
- Request structure
- Model selection
- Thinking-level configuration

Do not inject routing explanations into the model context on every request.

Show diagnostics through Pi's UI or commands instead.

Do not perform artificial compaction solely to make another model cheaper.

Preserve Pi's native cache behavior.

### 6.6 Cache warming

Inspect Pi's built-in `cacheWarming` support.

Do not implement a second independent cache-warming service.

Do not alter the user's global warming mode without authorization.

Allow the native warming mechanism to operate when supported.

Avoid warming inactive physical models.

Never assume that a cache can be transferred from Terra to Sol or from GPT to DeepSeek.

## 7. Work-unit boundaries

A work unit is a logically continuous development task.

Examples:

- Implementing a feature
- Fixing a specific bug
- Refactoring one subsystem
- Reviewing a specific change
- Updating a set of related documentation

The following do NOT automatically start a new work unit:

- Running tests
- Fixing test failures
- Responding to review feedback
- Continuing implementation
- Adding a clarification
- Modifying a recently edited file
- Following up on an unfinished task

A clearly independent new request can start a new work unit.

Use Jev only when boundary classification is genuinely uncertain and the expected value justifies a classifier call.

When uncertain, continue the existing work unit.

A new work-unit boundary permits reconsidering the physical model, but does not require switching.

Provide a manual command to explicitly start a new work unit.

Maintain consistent work-unit state across resume, branching, and compaction.

## 8. GPT usage-limit detection and DeepSeek fallback

Use:

`deepseek/deepseek-flash`

as the preferred fallback model.

Only use it if authenticated and available.

### Failure handling

Distinguish:

- Actual GPT usage-limit exhaustion
- Temporary rate limiting
- Provider overload
- Authentication errors
- Invalid requests
- Context overflow
- Network timeouts
- User cancellation

Do not assume all HTTP 429 responses mean a subscription usage limit was exhausted.

Use actual error metadata and documented response patterns.

Do not invent quota information.

### Failover behavior

When an eligible GPT usage-limit failure occurs:

1. Detect the failure using the native Virtual Model retry mechanism.
2. Record the affected provider or model as unavailable.
3. Apply a bounded cooldown.
4. Select DeepSeek Flash.
5. Map the requested thinking level to one supported by DeepSeek.
6. Retry the failed model-generation request through Pi's native mechanism.
7. Preserve completed tool results.
8. Do not replay successful file edits or shell commands.
9. Continue the current work unit.
10. Inform the user once that failover occurred.

Do not build a separate retry loop around Pi's agent loop.

Avoid infinite retry cycles.

Use a strict maximum retry count.

If DeepSeek is unavailable or also fails, stop cleanly and explain the failure.

### Cache-aware fallback

GPT-to-DeepSeek failover necessarily creates a new model-cache context.

This switch is permitted because continuing the task is more important than preserving the unavailable GPT cache.

After failover, keep DeepSeek selected for the remainder of the active work unit.

Do not switch back to GPT midway through that work unit.

Do not repeatedly probe GPT.

At the next safe work-unit boundary, consider a bounded GPT recovery attempt.

Respect any explicit retry-after information or known quota reset time.

If recovery fails, return to cooldown.

### Budget protection

Use only the existing authenticated DeepSeek account.

Do not silently add paid providers.

Allow a configurable fallback budget or usage cap when reliable accounting is available.

Do not confuse API balance, request quotas, and subscription usage limits.

## 9. State management

Use the Virtual Model `request.state` mechanism for branch-aware routing state.

Store:

- Current work-unit ID
- Task classification
- Classification confidence
- Selected provider/model
- Selected thinking level
- Sticky-routing status
- Fallback status
- Last routing explanation
- Retry count
- Relevant cooldown information

Keep session state JSON-serializable.

Avoid storing complete prompts or API secrets.

Preserve appropriate state across:

- Tool continuations
- User follow-ups
- Session resume
- Session branches
- Compaction
- Pi restart

For cooldown information that must apply across independent sessions, use a separate small, safe persistent state mechanism only if necessary.

Do not use a single mutable global session object that corrupts branch behavior.

Do not rewrite unchanged state on every request.

## 10. Configuration

Create a minimal configuration file, for example:

`~/.pi/agent/jev-orchestrator.json`

Support:

- Automatic routing enabled/disabled
- Preferred Terra model
- Preferred Sol model
- Optional Astra model
- DeepSeek fallback model
- Task-to-model mapping
- Thinking-level mapping
- Sticky-routing policy
- Classification confidence threshold
- Cache-switch hysteresis
- Cooldown policy
- Retry limits
- Fallback budget
- Diagnostic verbosity

Provide safe defaults.

Validate configuration on load.

If a configured model is unavailable, use an explicitly documented compatible fallback.

Do not silently route to unrelated models.

Make project-level policy overrides optional and future-compatible.

Keep the initial implementation globally reusable across Rust, Astro, and other projects.

## 11. Commands

Provide concise Pi commands.

Prefer a single `/route` command with subcommands, if supported by the actual API.

Required functionality:

- `/route status` — Show current physical model, thinking level, work unit, and fallback state
- `/route why` — Explain the latest model decision
- `/route auto` — Enable automatic selection
- `/route lock` — Lock the current physical model and thinking level
- `/route unlock` — Restore automatic selection
- `/route new` — Explicitly start a new work unit
- `/route stats` — Show observed token usage, cache statistics, and routing decisions
- `/route reset` — Clear routing state safely

Do not create commands that conflict with existing Pi commands.

Keep the terminal interface minimal.

Avoid repeated status notifications.

## 12. Cost and performance observability

Track available metrics:

- Physical model usage
- Selected thinking level
- Input tokens
- Output tokens
- Cache-read tokens
- Cache-write tokens
- Total estimated API cost
- Classification calls and costs
- Model-switch count
- Fallback count
- Retry count
- Cache-hit ratio
- Task completion outcomes, when verifiable

Use native Pi session accounting.

Distinguish measured values from estimates.

For Codex subscription authentication, do not present API-list prices as actual billed charges.

Do not infer exact remaining Codex quota unless a supported API explicitly provides it.

Maintain a small rolling history of routing decisions.

Do not send telemetry to external services.

Do not make additional LLM calls solely to collect statistics.

Provide enough diagnostic information to compare Terra Medium, Terra High, Sol Medium, and Sol High in real development tasks.

## 13. Automatic escalation policy

Do not escalate merely because an output is lengthy.

Do not escalate after every test failure.

Prefer deterministic evidence:

- Repeated failure to satisfy the same explicit requirement
- Inability to resolve a complex dependency
- Demonstrated insufficiency of the current model
- Severe unresolved reasoning errors
- Explicit user request

First distinguish ordinary implementation errors from model-capability limitations.

When escalation is necessary:

1. Check whether the current work can continue safely.
2. Evaluate the estimated cache-loss cost.
3. Compare the benefits of staying with the current model.
4. Avoid repeated escalation loops.
5. Record the reason for escalation.

Escalation should be exceptional, not routine.

Do not perform automatic downgrades after escalation within the same work unit.

## 14. Testing

Build automated tests using mocked classifiers, model registries, and provider responses.

Tests must cover:

### Routing

1. Terra is selected for appropriate low-complexity work.
2. Terra High is selected for standard implementation.
3. Sol is selected for genuinely complex tasks.
4. Astra is not selected unnecessarily.
5. Unsupported models are handled safely.
6. Unsupported thinking levels are clamped or mapped correctly.
7. Jev failure results in deterministic fallback.

### Cache stability

8. Normal tool continuations preserve physical model identity.
9. Normal continuations preserve thinking level.
10. Planning-to-implementation does not cause a model switch.
11. Small follow-up requests preserve sticky routing.
12. Low-confidence classification does not trigger switching.
13. Model-selection hysteresis prevents oscillation.
14. Cache cost is considered before optional switching.
15. No duplicate cache-warming mechanism exists.

### Fallback

16. GPT usage exhaustion triggers DeepSeek.
17. A temporary rate limit is handled according to policy.
18. Authentication failures are not incorrectly treated as quota exhaustion.
19. Completed tool operations are not replayed.
20. DeepSeek remains selected during the active work unit.
21. GPT recovery is attempted only at a safe boundary.
22. Cooldown prevents repeated failed GPT requests.
23. Exhausted fallback retries terminate cleanly.

### Persistence

24. Session resume restores routing.
25. Branch navigation restores branch-specific state.
26. Compaction does not corrupt state.
27. Manual locking is respected.
28. Manual work-unit reset behaves correctly.
29. Credentials never appear in logs.

### Cost comparison

Compare three strategies using synthetic workloads:

A. Static Terra High

B. Naive automatic switching between Terra and Sol after each request

C. Cache-aware sticky routing

Measure:

- Model switches
- Cache reconstruction costs
- Estimated token costs
- Simulated retries
- Total estimated work-unit cost

The cache-aware strategy should avoid unnecessary switching and cache loss relative to B.

Do not assume it always beats A.

Do not deliberately exhaust real API quotas.

## 15. Implementation phases

### Phase 1 — Audit

Inspect the current Pi environment and identify compatible APIs.

Document important findings.

### Phase 2 — Core router

Implement:

- Virtual Model registration
- Jev classification
- Terra/Sol model selection
- Thinking-level selection
- Sticky work-unit routing
- Session state

Test thoroughly.

### Phase 3 — Cache protection

Implement:

- Cache-aware switch decisions
- Routing hysteresis
- Work-unit boundaries
- Native cache-warming compatibility

Test cache stability.

### Phase 4 — DeepSeek fallback

Implement:

- Usage-limit detection
- Safe retry routing
- Cooldown
- Fallback persistence
- Safe GPT recovery

Test with mocked failures.

### Phase 5 — Diagnostics

Implement commands, lightweight usage reporting, and the README.

### Phase 6 — Validation and activation

Run:

- Type checking
- Unit tests
- Integration tests
- Minimal smoke tests

Use mock providers wherever practical.

Do not overwrite existing global extensions.

Activate the orchestrator only after critical tests pass.

Verify that `orchestrator/auto` appears in Pi's model selector and that the physical routing is correct.

Preserve the previous configuration so the change is reversible.

## 16. Engineering constraints

- TypeScript
- Native Pi APIs
- Minimal dependencies
- Explicit error handling
- Strict types where practical
- Small testable functions
- Deterministic routing policy
- No redundant model requests
- No speculative background workers
- No separate agent execution framework
- No automatic credential modifications
- No secrets in logs
- No duplicate cache warmer
- No automatic replacement of existing subagent infrastructure

Follow global AGENTS.md.

Prefer simple, transparent implementation over framework-like abstractions.

The implementation must remain understandable and maintainable by a solo developer.

## 17. Acceptance criteria

Consider the project complete when:

1. Pi exposes `orchestrator/auto`.
2. TypeSafe Jev can classify new work units.
3. Terra and Sol are both selectable routing targets.
4. Thinking levels are chosen based on task complexity.
5. Normal work-unit continuations preserve the same physical model and thinking level.
6. Unnecessary cache-invalidating switches are prevented.
7. Cache warming is not duplicated.
8. GPT usage-limit failures can trigger DeepSeek Flash.
9. Failover does not repeat already completed tool operations.
10. GPT recovery happens only at safe boundaries.
11. Session branches and resumes retain correct routing state.
12. Routing decisions and usage metrics are inspectable.
13. Critical tests pass.
14. Existing subagents and project workflows remain functional.
15. The implementation is documented and reversible.

## Final instruction

First inspect the installed Pi environment and official APIs.

Then implement the smallest working version, test it, and extend it through the phases above.

Do not stop after producing a design document.

Do not ask for confirmation for ordinary implementation decisions.

For a required API that is unavailable, use the simplest supported alternative and document the limitation.

Do not claim zero cache loss is possible across different physical models.

Optimize for reliable task completion, measured performance, low total cost, and maximum practical cache reuse.

## Thinking-level amendment

These requirements amend this specification. They do not define a separate router.
When earlier examples conflict with this section, this section takes precedence.

1. Support `max` for Terra, Sol, and Astra only when the installed model registry supports it.
2. Do not treat `xhigh` as the maximum level. Use Pi\'s supported-level query and native clamping.
3. Default to Medium and High. Use XHigh for complex tasks and Max for exceptional tasks.
4. Before an optional physical-model switch at a safe boundary, consider supported higher levels on the current model, including Max.
5. Verify cache behavior against the actual provider, API, endpoint, authentication, and native request format.
6. Permit intra-model escalation only on a verified cache-preserving path. A stable cache key alone is not proof.
7. Compare Terra High/XHigh/Max, Sol Medium/High/XHigh/Max, and Astra High/Max.
   Compare task outcomes, latency, cache reuse, and total work-unit cost, including unsuccessful attempts.
8. Preserve sticky continuations, work-unit boundaries, manual locks, and DeepSeek Flash quota failover.

For the current ChatGPT subscription sign-in, Pi 1.4.0 rejects the append-only configuration-update path.
Top-level reasoning-effort changes can alter hidden prompt instructions.
Do not enable automatic intra-model escalation for that authentication method.
A new work unit can make an explicit fresh selection without claiming that its prior cache survives.

For a future verified path, prefer a higher current-model level only with sufficient comparable completion evidence.
Require no worse reported success or cache reuse, no greater cost per reported success, and a bounded latency increase.
Match task category, complexity, and risk. Exclude mixed-pair work units from pair-specific success attribution.
Do not invent success rates, latency, cache hits, quota balances, or actual subscription charges.
Expose unknown measurements as unknown. Distinguish user-reported outcomes from independent verification.
Do not send additional model requests solely to fill the comparison table.
