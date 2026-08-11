# Contributing to Woboo

Thank you for your interest in contributing to Woboo!

## Getting Started

1. Clone the repository:
   \`\`\`bash
   git clone https://github.com/SbxTheDead/woboo.git
   cd woboo
   \`\`\`

2. Install dependencies:
   \`\`\`bash
   npm install
   \`\`\`

3. Run the setup wizard:
   \`\`\`bash
   npm run setup
   \`\`\`

4. Run the test suite:
   \`\`\`bash
   npm test
   \`\`\`

5. Start the dashboard:
   \`\`\`bash
   npm run panel
   \`\`\`

## Project Structure

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full module map and data flow.

Key files:
- `woboo.mjs` — CLI entry point
- `src/foreman.mjs` — Core mission loop
- `src/brain.mjs` — AI planning
- `src/guard.mjs` — Safety system
- `src/server.mjs` — Dashboard server
- `src/ui.mjs` — Dashboard UI (self-contained HTML)

## Code Style

- **ESM modules only** — use `import`/`export`, not `require`
- **No build step** — code runs directly in Node 22+
- **Comments explain why, not what** — the code should be readable; comments add context
- **Error handling is defensive** — disk failures, network errors, and malformed data must never crash the mission
- **One module, one job** — each file does exactly one thing

## Testing

- Tests live in `test/` as `*.test.mjs` files
- Run with `npm test` (single-threaded to avoid port conflicts)
- Live tests (real Chrome) live in `test/live/`
- New features should include tests

## Pull Request Process

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes, following the code style above
4. Add tests for new functionality
5. Ensure all tests pass: `npm test`
6. Commit with a clear message
7. Push and open a Pull Request

## Reporting Issues

- Use [GitHub Issues](https://github.com/SbxTheDead/woboo/issues)
- Include steps to reproduce
- Include your OS, Node version, and Woboo version
- Include relevant logs from `~/.woboo/journal.jsonl`

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
