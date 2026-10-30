# Development

Keep source, tests, examples, and documentation in this repository.
Do not copy extension code into the Pi agent directory.
Use `pi -e ./index.ts` for development.
Run tests with an isolated `PI_CODING_AGENT_DIR` inside `.test-artifacts/`.
Do not use real provider quotas in automated tests.

Run `bun install --ignore-scripts` for setup.
Run `bun run check` before installation.
Run `bun run benchmark` for the synthetic cost comparison.
Install only after checks pass with `pi install /absolute/path/to/this/repository`.
Do not change the user's default model or authentication.
