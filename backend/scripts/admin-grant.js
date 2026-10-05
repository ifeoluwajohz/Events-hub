#!/usr/bin/env node
// Controlled, server-side bootstrap of platform admins. There is deliberately NO HTTP
// endpoint that can create the first admin. Run by an operator with database access:
//
//   npm run admin:grant -- --email person@example.com --reason "Initial platform admin"
//
// The user must already exist (signed in once through Clerk) and have a verified email.
require("dotenv").config();
const { getPrisma, disconnect } = require("../src/db");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = (arg("email") || "").trim().toLowerCase();
  const reason = (arg("reason") || "").trim();
  if (!email || reason.length < 3) {
    console.error('Usage: npm run admin:grant -- --email <verified email> --reason "<why>"');
    process.exit(2);
  }
  const prisma = getPrisma();
  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email } });
    if (!user) throw new Error(`No user with verified email ${email}. They must sign in once first.`);
    if (!user.clerkUserId) throw new Error("User is not linked to a Clerk account yet.");
    if (user.status !== "ACTIVE") throw new Error(`User is ${user.status}.`);
    if (user.platformRole === "ADMIN") return { user, changed: false };
    const updated = await tx.user.update({ where: { id: user.id }, data: { platformRole: "ADMIN" } });
    await tx.auditLog.create({
      data: {
        actorId: null,
        actorRole: "SYSTEM",
        action: "user.platform_admin.granted",
        targetType: "user",
        targetId: user.id,
        metadata: { via: "cli", reason, operator: process.env.USER || "unknown" },
      },
    });
    return { user: updated, changed: true };
  });
  console.log(result.changed ? `Granted platform admin to ${email} (${result.user.id}).` : `${email} is already a platform admin.`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(disconnect);
