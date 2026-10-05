# Database: migrations and rules

## Rules (read before changing the schema)

1. **Never** run `prisma migrate reset`, `prisma db push` or `--accept-data-loss` against any shared database, and never run `prisma migrate dev` against one either.
2. Create migrations locally with `npx prisma migrate dev --create-only`, **read the SQL**, and hand-edit it. Prisma turns renames into drop + add. Use `@map` (as Phase 2B does) or `ALTER ... RENAME` instead.
3. Destructive changes (dropping columns or tables) go in their own migration, after a backup and with explicit approval. The **legacy** fields (`legacy*` in `schema.prisma`, plus the `Admin` and `Picture` tables) are kept on purpose until the contract migration.
4. CI fails on any difference between `schema.prisma` and the migrations (`npm run prisma:drift`).

## Objects Prisma does not model (raw SQL in migrations)

Prisma's diff ignores these, so they survive future migrations. Don't remove them by hand.

| Object | Migration |
|---|---|
| CHECK constraints on `TicketType`, `BookingItem`, `Booking`, `Event`, `Organizer`, `VerificationSubmission`, `VerificationEvidence`, `Report` | `20261005120200_phase2b_tighten` |
| Append-only triggers on `AuditLog`, `VerificationDecision`, `EventModerationAction`, `OrganizerStatusChange`, `VerificationEvidence` | same |
| Immutability guard on `VerificationSubmission` (only `status` may change) | same |

## Phase 2B migrations

| Migration | Stage | What it does |
|---|---|---|
| `20261005120000_phase2b_expand` | Expand | Adds new enums, tables, columns and indexes. Relaxes NOT NULL on legacy columns. Drops only the `User.prefferedName` unique index. **Nothing else is dropped or renamed.** |
| `20261005120100_phase2b_backfill` | Backfill | Deterministic data migration, all-or-nothing. Refuses unsafe data with an explanatory error. Ends with invariant checks that abort on failure. |
| `20261005120200_phase2b_tighten` | Tighten | NOT NULL on the backfilled columns, the unique event/category index, CHECK constraints, history triggers. |

The contract migration (dropping the legacy fields) is **not** written yet. It needs explicit approval after 2B is proven in production.

## Production rollout runbook

Do not skip steps. Stop at any failure.

1. **Credentials:** confirm the Phase 0 rotation is done (`docs/SECURITY.md` §3).
2. **Identify the target:** confirm `DATABASE_URL` points at the intended database.
3. **Inspect (read-only):** `psql "$DATABASE_URL" -f docs/phase2/inspect-db.sql`. Check that the table shape matches the legacy migrations and note the counts.
4. **Backup:** `pg_dump --format=custom --file=pre-phase2b.dump "$DATABASE_URL"`, then check that the file restores: `pg_restore --list pre-phase2b.dump`.
5. **Rehearse on a restored copy** (never on production):
   ```bash
   createdb rehearsal && pg_restore --no-owner -d rehearsal pre-phase2b.dump
   DATABASE_URL=postgresql://.../rehearsal npx prisma migrate deploy
   ```
   If the backfill aborts, its message says which data needs a manual decision. Report it and do not "fix" data silently.
6. **Verify the rehearsal:** re-run the inspection, compare counts, and smoke-test the API against the rehearsal database.
7. **Deploy:** run `npx prisma migrate deploy` against production with the same artifacts, then deploy the new API and frontend together.
8. **Bootstrap the first admin:** that person signs in once, then run `npm run admin:grant -- --email <their verified email> --reason "Initial platform admin"`.
9. **Schedule** `npm run jobs:complete-events` (for example hourly).

### If the backfill fails in production

Prisma runs each migration atomically, so a failed backfill changes nothing (this is covered by `test/migration.test.js`). Fix the data that caused the refusal, then:

```bash
npx prisma migrate resolve --rolled-back 20261005120100_phase2b_backfill
npx prisma migrate deploy
```
