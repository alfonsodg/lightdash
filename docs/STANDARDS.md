# Development Standards — Agent BI Fork

This document summarizes the engineering, git, and quality standards applied across the fork (`develop` integration branch and `ext/agentBi` / `packages/agent-bi` modules).

## Git & Branching

- `main`: tracks `upstream/main` (`lightdash/lightdash`) cleanly with zero fork commits.
- `develop`: primary integration branch for all fork features and fixes.
- `feat/*` and `fix/*`: short-lived branches created from `develop` and integrated back into `develop` after CI and remote verification.
- Conventional Commits with issue references (`Ref #N`) are required on every commit.

## Stack & Tooling

- Package manager: `pnpm` pinned via `packageManager` in root `package.json`.
- Languages: TypeScript (`tsrs` typecheck), React + Mantine + CSS Modules (`no-inline-style-prop`), ECharts, Express + Knex + PostgreSQL.
- Linting & Formatting: `oxlint` and `oxfmt` enforced via `lint-staged` and GitHub Actions (`agent-bi-image.yml`).

## Code & Security Rules

- No hardcoded URLs, ports, credentials, or environment-specific thresholds in source code.
- White-label UI and error messages: avoid product brand names in `ext/agentBi` user-facing copy and errors.
- Wrap `JSON.parse` calls in `try/catch` and use `assertUnreachable` for exhaustive switches.
- Keep local operational inventory (`REMOTE.md`), `debug/` artifacts, and `packages/agent-bi/dist` untracked in Git.

## Testing & Verification

- Unit tests: Vitest suites across `packages/agent-bi`, `packages/backend` (`src/ext`), and `packages/frontend` (`src/ext/agentBi`).
- CI/CD: Every release tag triggers `agent-bi-image.yml` (build, lint, typecheck, unit tests, Trivy/SBOM scan, and GHCR publish).
- Remote E2E: Playwright validation against Sandbox and `cosapia` covering responsive viewports, light/dark themes, and live `ES | EN` localization.
