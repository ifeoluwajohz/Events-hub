#!/usr/bin/env node
// Read-only report for the Phase 2B backfill.
//
//   npm run migrate:report            (human-readable)
//   npm run migrate:report -- --json  (machine-readable)
//
// 1. Prints what the backfill recorded INSIDE its own transaction: exact transform
//    counts, defaults applied, rows deliberately left untouched, every invariant and
//    its result, anomalies kept as history. That record exists only if every
//    invariant passed (the migration aborts otherwise).
// 2. Independently re-verifies the DURABLE invariants (ones that must stay true
//    after the app is in use), scoped to migrated records. Point-in-time invariants
//    (e.g. "no event published by the migration") are only valid at migration time
//    and are reported from the record, not re-checked.
// Runs in a READ ONLY transaction. Exit code 1 if the record is missing or a check fails.
require("dotenv").config();
const { getPrisma, disconnect } = require("../src/db");
const { DURABLE_CHECKS } = require("../src/migrations/phase2bChecks");

async function main() {
  const asJson = process.argv.includes("--json");
  const prisma = getPrisma();
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const record = await tx.auditLog.findUnique({ where: { id: "aud_phase2b_backfill" } });
    const rechecks = [];
    for (const check of DURABLE_CHECKS) {
      const [row] = /** @type {Array<{ violations: bigint | number }>} */ (await tx.$queryRawUnsafe(check.sql));
      // A check that cannot evaluate (e.g. the record is missing) counts as a failure.
      const violations = row ? Number(row.violations) : 1;
      rechecks.push({ name: check.name, violations, passed: violations === 0 });
    }
    return { record, rechecks };
  });

  const metadata = /** @type {any} */ (result.record ? result.record.metadata : null);
  const recordedFailures = metadata ? Object.entries(metadata.invariants).filter(([, v]) => v !== "passed") : [];
  const ok = Boolean(metadata) && recordedFailures.length === 0 && result.rechecks.every((c) => c.passed);

  if (asJson) {
    console.log(JSON.stringify({ ok, migratedAt: result.record?.createdAt ?? null, recorded: metadata, rechecks: result.rechecks }, null, 2));
  } else if (!metadata) {
    console.log("Phase 2B backfill record NOT FOUND: the backfill has not run (or did not commit) on this database.");
  } else {
    const section = (title, obj) => {
      console.log(`\n${title}`);
      for (const [k, v] of Object.entries(obj || {}).sort(([a], [b]) => a.localeCompare(b))) console.log(`  ${k.padEnd(52)} ${v}`);
    };
    console.log(`Phase 2B backfill report (migrated at ${result.record?.createdAt.toISOString()})`);
    section("Records transformed:", metadata.transformed);
    section("Approved defaults applied:", metadata.defaultsApplied);
    section("Left untouched (by design):", metadata.leftUntouched);
    section("Anomalies kept as history (review recommended):", metadata.anomaliesKeptAsHistory);
    section("Invariants at migration time:", metadata.invariants);
    section("Totals after migration:", metadata.totals);
    console.log("\nIndependent re-check of durable invariants (now):");
    for (const c of result.rechecks) console.log(`  ${c.name.padEnd(52)} ${c.passed ? "passed" : `FAILED (${c.violations} violations)`}`);
    console.log(`\nOverall: ${ok ? "ALL INVARIANTS PASSED" : "FAILURES PRESENT"}`);
  }
  if (!ok) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(disconnect);
