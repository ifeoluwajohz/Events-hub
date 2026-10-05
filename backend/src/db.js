const { PrismaClient } = require("@prisma/client");

/** @type {PrismaClient | undefined} */
let prisma;

// One PrismaClient per process (each instance owns a connection pool).
function getPrisma() {
  if (!prisma) prisma = new PrismaClient();
  return prisma;
}

async function disconnect() {
  if (prisma) {
    await prisma.$disconnect();
    prisma = undefined;
  }
}

module.exports = { getPrisma, disconnect };
