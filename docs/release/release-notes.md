# Solemn v0.1.0-rc.1

This is the candidate for restricted paper-only research. It packages the launch-momentum strategy, synthetic forward replay, isolated historical replay infrastructure, the reference execution simulator, reconciled portfolio analytics, and durable operational controls.

- Discovery and risk research use PumpPortal discovery and migration, Jupiter Tokens V2, and a read-only Solana RPC. Verified live execution evidence remains unavailable. Optional paid feeds default to disabled.
- Paper orders share exact-decimal accounting, configured allocation and drawdown controls, durable fills and restart reconciliation. Simulated exits support partial take-profit and protective exits with verified fixture observations. Unavailable liquidity can leave positions unresolved.
- Jupiter Swap V2 supports opted-in quote research, scoped unsigned inspection and read-only simulation. Address-lookup and downstream instruction cases remain restricted. No signing, broadcasting or live-money execution is implemented.
- The release candidate restricts legacy provider URL and credential handling and reconciles early synthetic audit metadata without rewriting stored economics. It adds a consolidated release command, deployment smoke, and backup and rollback guidance.

## Week 12 files

| Area                   | Files changed                                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime and recovery   | Worker configuration, Jupiter Tokens and token security clients, diagnostic RPC, scanner transport and service, forward fixture provider, and portfolio recovery.       |
| Verification           | `scripts/release-verify.mjs`, `scripts/release-smoke.mjs`, the CI workflow, forward release fixture, legacy audit regression, and scoped provider and PostgreSQL tests. |
| Release and operations | Root package metadata, `config/release.env.example`, README, the release audit documents, deployment and rollback guides, runbooks and threat model.                    |

The deployment uses Node and pnpm versions pinned by the repository and a local PostgreSQL 16 Compose service. See the [deployment guide](../operations/deployment.md), [rollback guide](../operations/release-rollback.md), [issue register](week12-issues.md) and [readiness decision](release-readiness.md). The version in the worktree identifies the candidate. No release tag or package has been published.
