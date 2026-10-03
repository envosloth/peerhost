# Ownership metadata: configured durability

`OwnershipLedger` keeps its public async methods and `OwnershipState` / `TransferOffer` shapes. Metadata is now a single JSON state row in a SQLite database, using the runtime's built-in `node:sqlite` `DatabaseSync`; no native npm add-on is required. The filename extension does not select the format: a newly created `a.json` is also SQLite. New application integrations should use `ownership.sqlite`.

## Persistence boundary

Each connection requests `PRAGMA journal_mode=DELETE` and `PRAGMA synchronous=EXTRA`, reads both settings back, and rejects the operation unless the results are `delete` and `3`. `synchronous` is a connection setting; inspecting it on an unrelated connection does not establish the ledger's configuration.

`acceptTransfer` records the accepted offer id as `acceptedOfferId`, so a retried offer can be recognized and re-acknowledged without a second commit. `cancelTransfer(offerId, target)` returns an `offered` source to `owned` for exactly that pending offer and target; it is called only after the target's pinned acknowledgment reports a definitive decline, never after an error or timeout. A confirmed (`transferred`) offer cannot be cancelled.

Ownership changes run inside `BEGIN IMMEDIATE` transactions. Reads and writes of the state row use bound SQL parameters. The operation returns its value only after `COMMIT` succeeds; in particular, `prepareTransfer` returns the offer from that transaction instead of rereading mutable state after releasing the lock. Contention fails immediately (`timeout: 0`) rather than bypassing SQLite locking.

On a change/write/commit error, the ledger attempts `ROLLBACK` and rejects. A rollback error produces an `AggregateError` containing both the original error and the rollback error; connection close is still attempted. Neither failure reports a successful transfer or returns an offer. Callers must not convert these errors to success or automatically restore source ownership. An error does not prove the previous state persisted: inspect the ledger and resolve uncertain outcomes explicitly.

SQLite documents that EXTRA adds rollback-journal directory synchronization after DELETE-mode journal removal. This replaces the previous temp-file/fsync/rename scheme, which did not establish rename-metadata durability.

## Existing JSON metadata

Preexisting JSON is **refused**, not automatically converted, reinitialized, truncated, or replaced. The error requires explicit migration; the original file is preserved. SQLite's `SQLITE_NOTADB` error is surfaced as unsupported metadata format guidance (including the legacy JSON case). Do not hide this error by creating a fresh owned ledger under another filename.

Automatic migration is deliberately not implemented. Before a separately reviewed migration, retain a byte-identical backup, confirm all affected processes are stopped, reconcile ownership with peer devices, and preserve the complete state, generation, revision and offer. Never reinterpret `uncertain`, `offered`, or `transferred` as locally `owned`. A filename change alone is not a migration.

## Verified scope and limits

Tests use disposable local files and actual SQLite transactions, observe the connection settings at transaction begin, reopen committed state, and inject unsupported-setting, COMMIT and ROLLBACK failures at the SQLite API boundary. They also force a confirmation between prepare's commit and return, reject self-transfers, and preserve uncertain ownership.

These are configured-durability and failure-handling tests, **not hardware power-loss tests**. No power was interrupted, no storage controller flush behavior was tested, and no resilience guarantee is made for the user's filesystem, disk cache, hardware, network filesystem, or snapshot/world-file persistence. A metadata commit alone does not prove Minecraft is stopped or that its world data is durable; those remain separate prerequisites.

References:
- [Node.js built-in SQLite API](https://nodejs.org/api/sqlite.html)
- [SQLite synchronous settings and EXTRA behavior](https://www.sqlite.org/pragma.html#pragma_synchronous)
- [SQLite journal modes](https://www.sqlite.org/pragma.html#pragma_journal_mode)
