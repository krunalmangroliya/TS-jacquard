# Regression fixtures

These ten inputs are **synthetic development fixtures**, not the ten real designer acceptance images requested by JDM_SPEC_v1. Sources are generated deterministically by `packages/eval/src/fixtures.ts`.

`pnpm eval` traces each fixture, checks independent face/open-end budgets, renders three loom sizes, re-renders for deterministic comparison and compares PNG/BMP bytes plus vector geometry with committed snapshots. Results and timings go into ignored `actual/`.

`pnpm eval --browser` also compares every BMP with the same pure TypeScript pipeline inside a browser Web Worker. Requires a locally installed Chromium/Edge/Chrome or Playwright browser.

To accept intentional changes, inspect actual outputs, then run `pnpm eval --update --reason "explanation"`. Include `EVAL-UPDATE: explanation` in the commit when committing changed expectations.

Acceptance still needs real PNGs, real machine profiles, matching customer-approved coloring, a comparison of total designer effort, and a real NedGraphics import test. The current metrics are diagnostics, not evidence that manual cleanup has fallen by 80%.
