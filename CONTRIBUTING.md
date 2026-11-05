# Contributing to StrataGate

Thank you for helping improve StrataGate. Contributions of code, tests, documentation, bug reports, design feedback, and reproducible evaluations are all valuable.

[中文贡献指南](CONTRIBUTING.zh-CN.md)

## Before you start

- Search the [existing Gitee issues](https://gitee.com/diqier4123/StrataGate-AgentMemory/issues) before opening a new one.
- For a bug, include the relevant integration, Node.js version, reproduction steps, expected behavior, and actual behavior.
- For a substantial feature or architectural change, open an issue first so the approach and scope can be discussed before implementation.
- Never include private conversations, credentials, API keys, or other sensitive data in issues, tests, fixtures, or pull requests. Report security issues according to [`SECURITY.md`](SECURITY.md).

By participating, you agree to follow the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Ways to contribute

Useful contributions include:

- fixing a reproducible bug or adding a regression test;
- clarifying setup, usage, architecture, or evaluation documentation;
- improving the shared memory engine in `packages/core/`;
- improving the DeepSeek Harness adapter in `src/`;
- improving an integration such as `integrations/workbuddy/`;
- adding a carefully documented benchmark or evaluation;
- improving accessibility, error messages, or developer experience.

Small, focused changes are welcome. A pull request does not need to introduce a large feature to be useful.

## Development setup

StrataGate is an npm workspace monorepo. Use Node.js `22.19.0` or a newer 22.x release, or Node.js 24 and above. Run the local checks below; GitHub CI is required again following account recovery on 2026-11-05.

```bash
git clone https://gitee.com/diqier4123/StrataGate-AgentMemory.git
cd StrataGate-AgentMemory
npm ci
```

Run the main local checks:

```bash
npm run check
npm test
npm run build
```

You can also run a narrower command while iterating:

```bash
npm run check:core
npm run test:core
npm run check:dsh
npm run test:dsh
npm run check:workbuddy
npm run test:workbuddy
```

## Making a change

1. Create a branch from the latest `main`.
2. Keep the change focused and avoid unrelated formatting or refactoring.
3. Add or update tests when behavior changes. A bug fix should ideally include a regression test.
4. Update the relevant English and Chinese documentation when user-facing behavior changes.
5. Run the checks that cover your change; run the complete check, test, and build suite before opening a pull request when practical.

Memory behavior is especially sensitive to provenance, timestamps, scope isolation, deterministic ordering, and evidence sufficiency. Changes in these areas should include focused tests for their invariants and edge cases.

## Pull requests

A helpful pull request includes:

- a concise explanation of the problem and the chosen solution;
- links to relevant issues or discussions;
- the tests and commands used to verify the change;
- screenshots or recordings for visible UI changes;
- documentation updates for changed behavior or configuration;
- benchmark details and machine-readable artifacts for performance or accuracy claims.

Please keep commits reviewable and respond to review feedback constructively. Maintainers may ask to split a broad pull request into smaller changes.

## Reporting evaluation results

Evaluation claims should be reproducible. Record the dataset or subset, model and configuration, prompts, run count, scoring method, comparison conditions, and relevant artifact hashes. Clearly distinguish complete-system comparisons from component ablations, and avoid generalizing beyond the evaluated scope.

## License

By contributing, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
