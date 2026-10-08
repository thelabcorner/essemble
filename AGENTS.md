# AGENTS.md — ESsemble

This file governs work inside the ESsemble repository.

## Architectural contract

ESsemble is an umbrella framework, resolver, composer, and distribution surface over independent toolkit repositories. It is not a monorepo conversion.

- Keep every component independently versioned, testable, releasable, and usable outside ESsemble.
- Treat `components/` as nested Git repositories / future committed submodules. Do not edit component source from ESsemble unless the task explicitly targets that component.
- Never copy component source into ESsemble to avoid dependency resolution.
- Do not collapse runtime, build, native, validation, benchmark, and rollout relationships into one dependency class.
- Do not infer consumer runtime dependencies from the rollout graph. Rollout edges answer "what must rebuild/retest after an upstream change"; ESsemble resolution answers "what does this requested composition need".
- Preserve the ESB64 <-> ESPACK composition cycle as an explicit strongly connected component. Do not break it with arbitrary ordering.
- Prefer exact lock revisions and content/provenance checks over mutable branch assumptions.
- The framework may install the whole ecosystem, but generated runtime output must remain selective: no giant bundle merely because all tools are installed.
- ArcFit is a downstream product/consumer, not an ESsemble component.
- ESOBF is preview/local-only until it has a distributable Git source.

## Sources of truth

- `registry/catalog.json`: ESsemble's transitional component metadata and dependency lanes.
- `essemble.lock.json`: exact source revisions used by this framework checkout.
- `profiles/*.json`: named selection/scoping policies.
- Upstream `/scripts/agent-skills/es-ecosystem-rollout/references/dependency-graph.json`: authoritative rollout graph. It is provenance input, not a drop-in consumer resolver.

Longer term, component-owned manifests should replace centrally maintained component metadata and generate the umbrella catalog.

## Dependency lanes

Allowed relationship keys are:

- `runtime` — required by the selected runtime API itself.
- `build` — compiler/build-time tooling.
- `compose` — artifact composition/vendor inputs.
- `native` — native ABI/build requirements.
- `optionalRuntime` — optional runtime integrations.
- `validation` — test/release validation only.
- `benchmark` — measurement-only dependencies.
- `prototype` — prototype/research-only dependencies.
- `integration` — explicit downstream vendoring/integration relationships.

A resolver command must state which lanes it closes over. The default user-facing resolution lane is `runtime` only.

## Change discipline

- Read parent `/scripts/AGENTS.md` and relevant skills before cross-repo changes.
- Preserve unrelated dirty state in `/scripts`.
- Do not stage, commit, push, reset, stash, clean, restore, or rewrite sibling repositories unless explicitly requested.
- Keep resolver behavior deterministic and test cycle handling.
- Add measurements before making performance claims.
