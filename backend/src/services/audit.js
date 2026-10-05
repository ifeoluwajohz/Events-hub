// Append-only audit trail. Always called inside the same transaction as the
// action it records, so an action and its audit row commit (or fail) together.

/**
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {{
 *   actor: { id: string } | null,
 *   actorRole: "ADMIN" | "ORGANIZER" | "SYSTEM",
 *   action: string,
 *   targetType: string,
 *   targetId: string,
 *   metadata?: Record<string, unknown>,
 *   req?: any,
 * }} entry
 */
function recordAudit(tx, { actor, actorRole, action, targetType, targetId, metadata, req }) {
  return tx.auditLog.create({
    data: {
      actorId: actor ? actor.id : null,
      actorRole,
      action,
      targetType,
      targetId,
      metadata: /** @type {any} */ (metadata) ?? undefined,
      requestId: req ? req.id : undefined,
      ipAddress: req ? req.ip : undefined,
    },
  });
}

module.exports = { recordAudit };
