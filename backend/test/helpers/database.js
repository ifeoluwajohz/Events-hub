// Test database helpers. Every test file gets its own throwaway database on the
// server named by TEST_DATABASE_ADMIN_URL (never a real environment's database).
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("pg");

const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL || "postgresql://postgres@localhost:55432/postgres";
const BACKEND_DIR = path.resolve(__dirname, "..", "..");
const PRISMA_DIR = path.join(BACKEND_DIR, "prisma");
const MIGRATIONS_DIR = path.join(PRISMA_DIR, "migrations");

const urlFor = (dbName) => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  return url.toString();
};

async function adminQuery(sql) {
  const client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function createDatabase(prefix = "evt_test") {
  const name = `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
  await adminQuery(`CREATE DATABASE "${name}"`);
  return { name, url: urlFor(name) };
}

async function dropDatabase(name) {
  await adminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

const allMigrationNames = () =>
  fs.readdirSync(MIGRATIONS_DIR).filter((n) => fs.statSync(path.join(MIGRATIONS_DIR, n)).isDirectory()).sort();

// Runs `prisma migrate deploy` exactly as production does. With `only`, deploys
// from a temporary migrations folder containing just those migrations.
function migrateDeploy(databaseUrl, only) {
  let schemaPath = path.join(PRISMA_DIR, "schema.prisma");
  let tmp;
  if (only) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evt-migrations-"));
    const dir = path.join(tmp, "migrations");
    fs.mkdirSync(dir);
    fs.copyFileSync(path.join(MIGRATIONS_DIR, "migration_lock.toml"), path.join(dir, "migration_lock.toml"));
    for (const name of only) fs.cpSync(path.join(MIGRATIONS_DIR, name), path.join(dir, name), { recursive: true });
    schemaPath = path.join(tmp, "schema.prisma");
    fs.copyFileSync(path.join(PRISMA_DIR, "schema.prisma"), schemaPath);
  }
  try {
    return execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", schemaPath], {
      cwd: BACKEND_DIR,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
      encoding: "utf8",
    });
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function prismaCli(databaseUrl, args) {
  return execFileSync("npx", ["prisma", ...args], {
    cwd: BACKEND_DIR,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
    encoding: "utf8",
  });
}

async function withClient(databaseUrl, fn) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

module.exports = {
  ADMIN_URL,
  allMigrationNames,
  createDatabase,
  dropDatabase,
  migrateDeploy,
  prismaCli,
  withClient,
};
