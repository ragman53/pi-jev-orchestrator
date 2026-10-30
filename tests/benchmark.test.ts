import { expect, test } from "bun:test";
import { STRATEGIES, simulate, WORKLOADS } from "./benchmark.ts";

test("sticky routing avoids naive model switches and repeated cache reconstruction", () => {
	for (const units of Object.values(WORKLOADS)) {
		const naive = simulate(STRATEGIES[1] as (typeof STRATEGIES)[number], units);
		const sticky = simulate(STRATEGIES[2] as (typeof STRATEGIES)[number], units);
		expect(sticky.pairChanges).toBeLessThan(naive.pairChanges);
		expect(sticky.reconstructionCost).toBeLessThan(naive.reconstructionCost);
		expect(Number.isFinite(sticky.totalCost)).toBe(true);
		if (units[0]?.solOutputMultiplier === 1) expect(sticky.totalCost).toBeLessThan(naive.totalCost);
	}
});
test("sticky routing is not assumed to beat static Terra High", () => {
	const units = WORKLOADS["optimistic Terra, costly Sol reasoning"] ?? [];
	const baseline = simulate("A: static Terra High", units);
	const sticky = simulate("C: cache-aware sticky", units);
	expect(sticky.totalCost).toBeGreaterThan(baseline.totalCost);
	expect(sticky.simulatedRetries).toBe(0);
});
