# ADR 0001: Split Opcode Into CodeInterfaceX

- Status: Accepted
- Date: 2026-02-10
- Decision Makers: CodeInterfaceX maintainers

## Context

The project started as `opcode` and has been heavily customized for internal workflows and product direction. Over time, those changes expanded across:

- desktop UX and terminal behavior
- notification and attention routing
- mobile sync and remote-access behavior
- scripts, release automation, and operational tooling
- naming/identity and runtime contracts

Maintaining these changes as a thin layer on top of the upstream `opcode` codebase created growing friction:

- high merge/conflict cost on upstream changes
- unclear product identity and ownership boundaries
- unstable compatibility expectations (upstream vs internal behavior)
- increasing risk when shipping internal-only changes

## Decision

We split the customized product into a distinct project: **CodeInterfaceX**.

Key decisions included:

1. Adopt new product identity:
- Display name: `CodeInterfaceX`
- Technical slug: `codeinterfacex`
- App identifier: `com.flourishinghumanity.codeinterfacex`

2. Execute a clean-break technical rename:
- rename runtime/event/storage/protocol identifiers from `opcode*` to `codeinterfacex*`
- rename binaries to `codeinterfacex` and `codeinterfacex-web`
- rename agent file extension from `.opcode.json` to `.codeinterfacex.json`

3. Preserve upstream lineage explicitly:
- keep `origin` as active development remote
- keep `upstream` pointing to `https://github.com/winfunc/opcode.git`

4. Use archive-and-reset migration semantics for legacy local state:
- archive old `opcode` local artifacts on first run
- do not provide long-term backward-compat aliases for legacy contracts

## Consequences

### Positive

- Clear product identity and ownership for internal roadmap decisions.
- Lower coordination overhead for internal-first changes.
- More predictable runtime contracts aligned with current product behavior.
- Cleaner release communication around breaking changes.

### Negative

- Upstream changes are now selectively adopted, not implicitly inherited.
- Existing users/scripts depending on `opcode` identifiers must update.
- Additional maintenance burden for migration documentation and tooling.

### Operational Implications

- CI/release scripts, tests, and docs must target `codeinterfacex*`.
- Legacy identity checks are required to prevent accidental regression.
- Future compatibility changes should be explicit ADRs, not incidental edits.

## Alternatives Considered

1. Continue as a heavily patched fork under `opcode` identity.
- Rejected: identity ambiguity and cumulative merge complexity remained high.

2. Keep only UI branding changes and retain all technical `opcode` contracts.
- Rejected: would preserve confusion and ongoing contract mismatch risk.

3. Big-bang migration with no archival of local legacy state.
- Rejected: high risk of opaque user breakage and poor rollback visibility.

## Follow-up

- Keep this ADR updated when re-evaluating upstream sync strategy.
- Add subsequent ADRs for:
  - compatibility policy changes
  - mobile protocol versioning strategy
  - future repository/remote topology changes
