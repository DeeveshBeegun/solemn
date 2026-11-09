# Solemn v0.1.0-rc.1 readiness decision

**CONDITIONAL GO for restricted paper testing.** The local release gate passed on disposable PostgreSQL 16. The remaining high-severity findings prevent autonomous live-data paper execution. Real-money trading requires a separate authorization and security milestone.

| Category          | Outcome               | Basis                                                                                                                                                                                   |
| ----------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Technical         | PASS                  | Frozen install, source and transport safety checks, deterministic end-to-end integration, production build, PostgreSQL migration and ledger integrity.                                  |
| Operational       | CONDITIONAL           | Local startup, shutdown, rollback restore and persistent halts are verified. Live execution evidence, deployment privilege separation and external incident delivery remain incomplete. |
| Strategy evidence | INSUFFICIENT_EVIDENCE | No genuine historical or forward trading sample is available. Fixture results demonstrate engineering behavior only.                                                                    |

The candidate scope is deterministic fixtures, local paper replay, analytics research, optional free discovery collection and independent quote-only research. Autonomous trading against live observations and any real-money execution are outside this scope.

| Forward readiness                              | Outcome               | Evidence                                                                                                                                   |
| ---------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Replay                                         | VERIFIED              | The release fixture and process smoke produced deterministic paper economics, preserved the halt and reconciled after restart.             |
| Live data                                      | PARTIALLY_VERIFIED    | Previously collected discovery records establish a read-only discovery path. Verified live trade and pool observations remain unavailable. |
| Forward paper execution from live observations | BLOCKED               | The live collector cannot authorize entries from current evidence.                                                                         |
| Performance validation                         | INSUFFICIENT_EVIDENCE | No genuine historical or forward trading sample exists for an empirical evaluation.                                                        |

The next release should prioritize verified pool identity and state, execution-time ordering and coverage, token transfer behavior, current fee and USD provenance, and production database roles. Once those gates pass, use a frozen prospective four-to-eight-week forward observation plan, extending it if the independent coverage remains inadequate. Review net performance, missing exposure, concentration and operational cost against a no-trade baseline. Signing and submission require a separately authorized implementation and security review.

- [Architecture and security audit](week12-system-audit.md)
- [Executed checks and failure matrix](week12-test-results.md)
- [Findings and severity](week12-issues.md)
- [Performance evidence and $100 economics](week12-performance-review.md)
- [Release notes](release-notes.md)
- [Deployment](../operations/deployment.md), [rollback](../operations/release-rollback.md), and [incident runbooks](../operations/runbooks.md)
