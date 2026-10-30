# Synthetic cost comparison

Run `bun run benchmark` for the repeatable A/B/C comparison.
The numbers are synthetic estimates, not live provider results.
The native CLI tests separately exercise all nine model/thinking variants.

Strategy A uses static Terra High.
Strategy B changes between Sol and Terra on each request.
Strategy C uses the production policy and cache-switch decision with a fixed pair inside each work unit.

The simulation assumes an 80% reusable prompt prefix.
A model or thinking change starts cold.
All requests finish within the assumed cache lifetime.
This deliberately conservative simulation does not assume a verified append-only thinking path.

The price snapshot uses Terra input/output/cache-read rates of 2/12/0.2 dollars per million tokens.
Sol uses 2/10/0.1.
These are catalog estimates, not subscription bills.

Hard debugging assigns two correction requests to Terra in one scenario.
Another scenario assigns no Terra corrections and four times the output tokens to Sol.
Those inputs illustrate sensitivity to task success and reasoning cost.
They are not measured capability claims.

The output includes model switches, pair changes, reconstruction cost, retries, token counts, and total work-unit cost.
Reconstruction cost is already part of the total.
Do not add it again.
The benchmark excludes unknown classifier pricing and does not invent live latency or success rates.

Tests require C to avoid unnecessary switching and reconstruction relative to B.
They also require a scenario in which C costs more than A.
The benchmark is not tuned to claim that routing always beats static Terra High.

For real variant comparisons, use `/route stats` and user-reported outcomes after checking the work.
Compare similar category, complexity, and risk cohorts.
Inspect latency, cache reads, failed attempts, and cost together.
Do not rank models from unmatched tasks or from the mock provider's fixed outputs.
