# The Event

Event discovery and ticketing web app.

```
frontend/   React 18 + Vite + TypeScript + Tailwind, Clerk for sign-in
backend/    Express 4 + Prisma 6 + PostgreSQL
docs/       AUDIT.md (codebase audit and roadmap), SECURITY.md (secret handling)
```

> Status: under active stabilisation. Authenticated API flows (booking, my tickets, create event) don't work end to end until the backend's Clerk migration (Phase 2 in `docs/AUDIT.md`).

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
| backend | `JWT_SECRET` | Signs backend session tokens |
| backend | `FIREBASE_SERVICE_ACCOUNT_JSON` / `FIREBASE_SERVICE_ACCOUNT_PATH` | Firebase Admin credential (until Phase 2) |
| backend | `PORT` | API port (use 4000; the default 5173 clashes with Vite) |

`VITE_*` values are bundled into the browser, so never put a secret in one.

## Development

```bash
# backend (http://localhost:4000)
cd backend && npx prisma migrate dev && npm run dev

# frontend (http://localhost:5173)
cd frontend && npm run dev
```

## Checks

Run from `frontend/`:

| Command | What it does |
|---|---|
| `npm run lint` | ESLint (errors fail CI; warnings are tracked tech debt) |
| `npm run typecheck` | TypeScript, no emit |
| `npm run build` | Typecheck + production build to `dist/` |

## CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`:

- **secrets-guard**: fails if any `.env` or service-account file is tracked
- **frontend**: `npm ci`, lint, typecheck, build
- **backend**: `npm ci`, syntax check of every source file, `prisma validate`

CI doesn't deploy.
