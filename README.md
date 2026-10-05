# The Event

Event discovery and ticketing web app.

```
frontend/   React 18 + Vite + TypeScript + Tailwind, Clerk for sign-in
backend/    Express 4 + Prisma 6 + PostgreSQL
docs/       AUDIT.md (codebase audit and roadmap), SECURITY.md (secret handling)
```

> Status: Phase 2B (backend foundation) implemented. See `docs/PHASE2B_IMPLEMENTATION.md`. Production rollout is blocked on credential rotation (`docs/SECURITY.md`) and the database runbook (`backend/prisma/README.md`).

## Requirements

- Node.js 22 (see `.nvmrc`), npm 10
- PostgreSQL (for the backend)
- A Clerk application (publishable key)

## Installation

```bash
cd frontend && npm ci
cd ../backend && npm ci
```

## Environment variables

Each app has a template listing every variable it reads. Copy it and fill in the values locally. **Never commit real values**; see `docs/SECURITY.md`.

```bash
cp frontend/.env.example frontend/.env.local
cp backend/.env.example  backend/.env
```

| App | Variable | Purpose |
|---|---|---|
| frontend | `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key (public) |
| frontend | `VITE_REACT_APP_API_KEY` | Backend base URL (misnamed: it's a URL, not a key) |
| backend | `DATABASE_URL` | Postgres connection string (Prisma) |
| backend | `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | Clerk keys of the same instance as the frontend (secret key is SECRET) |
| backend | `CLERK_JWT_KEY` (optional) | Clerk PEM public key for offline token verification |
| backend | `CORS_ORIGINS` | Exact allowed browser origins (required in production) |
| backend | `TRUST_PROXY`, `PORT` | Proxy awareness for rate limits; API port (4000) |
| backend (tests) | `TEST_DATABASE_ADMIN_URL`, `SHADOW_DATABASE_URL` | Throwaway Postgres for tests and the drift check; never a real environment |

`VITE_*` values are bundled into the browser, so never put a secret in one.

## Development

```bash
# backend (http://localhost:4000); never run migrate dev/reset against a shared database
cd backend && npx prisma migrate deploy && npm run dev

# frontend (http://localhost:5173)
cd frontend && npm run dev
```

The first platform admin is created from the command line only: `cd backend && npm run admin:grant -- --email <verified email> --reason "<why>"` (that person must have signed in once).

## Checks

| Where | Command | What it does |
|---|---|---|
| frontend | `npm run lint` / `npm run typecheck` / `npm run build` | ESLint, TypeScript, production build |
| backend | `npm run typecheck` | Type-checks the JS backend (JSDoc + Prisma types) |
| backend | `npm run prisma:drift` | Fails if `schema.prisma` differs from the migrations (needs `SHADOW_DATABASE_URL`) |
| backend | `npm test` | API, authorization, lifecycle, booking concurrency and migration tests against a real Postgres (`TEST_DATABASE_ADMIN_URL`) |

Database rules and the production migration runbook: `backend/prisma/README.md`.

## CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`:

- **secrets-guard**: fails if any `.env` or service-account file is tracked
- **frontend**: `npm ci`, lint, typecheck, build
- **backend** (with a Postgres service): `prisma validate`, schema drift check, typecheck, syntax check, migrations on an empty database, full test suite

CI doesn't deploy.
