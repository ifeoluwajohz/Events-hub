// Free-ticket booking (Phase 2B). Paid checkout is Phase 4: paid ticket types are
// refused here, but the model (TicketType price, BookingItem price snapshot, currency)
// already supports them.
const crypto = require("node:crypto");
const { Prisma } = require("@prisma/client");
const { getPrisma } = require("../db");
const { notFound, conflict, forbidden, badRequest } = require("../http/errors");

const bookingInclude = {
  items: { include: { ticketType: { select: { name: true } } } },
  tickets: { include: { ticketType: { select: { id: true, name: true } } }, orderBy: /** @type {const} */ ({ createdAt: "asc" }) },
  event: { include: { media: { include: { asset: true } } } },
};

// 160 random bits; the QR payload. Never derived from database ids.
const newTicketCode = () => crypto.randomBytes(20).toString("base64url");

/**
 * @param {import("../auth/currentUser").CurrentUser} user
 * @param {{ eventId: string, items: Array<{ ticketTypeId: string, quantity: number }>, idempotencyKey: string }} input
 * @returns {Promise<{ booking: any, replayed: boolean }>}
 */
async function createFreeBooking(user, { eventId, items, idempotencyKey }) {
  const prisma = getPrisma();

  // Replays of the same request return the original booking.
  const previous = await prisma.booking.findUnique({ where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } }, include: bookingInclude });
  if (previous) return replay(previous, eventId);

  const ids = items.map((i) => i.ticketTypeId);
  if (new Set(ids).size !== ids.length) throw badRequest("DUPLICATE_ITEMS", "Each ticket type may appear once");

  try {
    const booking = await prisma.$transaction(async (tx) => {
      const event = await tx.event.findFirst({
        where: { id: eventId, status: { in: ["PUBLISHED", "COMPLETED", "CANCELLED"] }, organizer: { status: "ACTIVE" } },
        include: { organizer: true, ticketTypes: true },
      });
      if (!event) throw notFound("Event");
      if (event.status !== "PUBLISHED" || event.startsAt <= new Date()) {
        throw conflict("EVENT_NOT_BOOKABLE", "This event is not open for booking");
      }
      if (event.organizer.ownerUserId === user.id) throw forbidden("OWN_EVENT", "You cannot book your own event");

      const now = new Date();
      const lines = items.map((item) => {
        const tt = event.ticketTypes.find((t) => t.id === item.ticketTypeId);
        if (!tt || tt.status !== "ACTIVE") throw notFound("Ticket type");
        if (tt.salesStartAt && tt.salesStartAt > now) throw conflict("SALES_NOT_STARTED", `${tt.name} is not on sale yet`);
        if (tt.salesEndAt && tt.salesEndAt <= now) throw conflict("SALES_ENDED", `${tt.name} is no longer on sale`);
        if (item.quantity < tt.minPerOrder || item.quantity > tt.maxPerOrder) {
          throw badRequest("INVALID_QUANTITY", `${tt.name}: choose between ${tt.minPerOrder} and ${tt.maxPerOrder}`);
        }
        if (tt.priceMinor > 0) throw conflict("PAID_CHECKOUT_UNAVAILABLE", "Paid tickets are not on sale yet");
        return { tt, quantity: item.quantity };
      });

      // Reserve inventory atomically. Sorted ids keep lock order stable (no deadlocks).
      for (const { tt, quantity } of [...lines].sort((a, b) => a.tt.id.localeCompare(b.tt.id))) {
        const reserved = await tx.$executeRaw`
          UPDATE "TicketType" SET "quantitySold" = "quantitySold" + ${quantity}, "updatedAt" = now()
          WHERE "id" = ${tt.id} AND "status" = 'ACTIVE' AND "quantitySold" + ${quantity} <= "quantityTotal"`;
        if (reserved !== 1) throw conflict("SOLD_OUT", `Not enough ${tt.name} tickets left`);
      }

      const created = await tx.booking.create({
        data: {
          userId: user.id,
          eventId: event.id,
          status: "CONFIRMED",
          confirmedAt: now,
          currency: event.currency,
          totalMinor: lines.reduce((sum, l) => sum + l.tt.priceMinor * l.quantity, 0),
          idempotencyKey,
          items: { create: lines.map((l) => ({ ticketTypeId: l.tt.id, quantity: l.quantity, unitPriceMinor: l.tt.priceMinor })) },
        },
      });
      await tx.ticket.createMany({
        data: lines.flatMap((l) =>
          Array.from({ length: l.quantity }, () => ({
            eventId: event.id, bookingId: created.id, ticketTypeId: l.tt.id, holderUserId: user.id, code: newTicketCode(), status: /** @type {const} */ ("VALID"),
          })),
        ),
      });
      return tx.booking.findUniqueOrThrow({ where: { id: created.id }, include: bookingInclude });
    });
    return { booking, replayed: false };
  } catch (err) {
    // A concurrent request with the same idempotency key won the race.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.booking.findUnique({ where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } }, include: bookingInclude });
      if (winner) return replay(winner, eventId);
    }
    throw err;
  }
}

/** @param {any} booking @param {string} eventId */
function replay(booking, eventId) {
  if (booking.eventId !== eventId) throw conflict("IDEMPOTENCY_KEY_REUSED", "This idempotency key was used for a different booking");
  return { booking, replayed: true };
}

/** @param {import("../auth/currentUser").CurrentUser} user @param {{ cursor?: string, limit: number }} f */
function listOwnBookings(user, f) {
  return getPrisma().booking.findMany({
    where: { userId: user.id },
    include: bookingInclude,
    orderBy: [{ bookingDate: "desc" }, { id: "asc" }],
    take: f.limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
  });
}

/** Owner-scoped: another user's booking is a 404. @param {import("../auth/currentUser").CurrentUser} user @param {string} bookingId */
async function getOwnBooking(user, bookingId) {
  const booking = await getPrisma().booking.findFirst({ where: { id: bookingId, userId: user.id }, include: bookingInclude });
  if (!booking) throw notFound("Booking");
  return booking;
}

/** @param {import("../auth/currentUser").CurrentUser} user @param {string} bookingId */
async function cancelOwnBooking(user, bookingId) {
  return getPrisma().$transaction(async (tx) => {
    const booking = await tx.booking.findFirst({ where: { id: bookingId, userId: user.id }, include: { items: true, tickets: true, event: true } });
    if (!booking) throw notFound("Booking");
    if (!["PENDING", "CONFIRMED"].includes(booking.status)) throw conflict("NOT_CANCELLABLE", `This booking is ${booking.status}`);
    if (booking.event.startsAt <= new Date()) throw conflict("EVENT_STARTED", "Bookings cannot be cancelled after the event starts");
    if (booking.totalMinor > 0) throw conflict("REFUND_REQUIRED", "Paid bookings are cancelled through refunds (not available yet)");
    if (booking.tickets.some((t) => t.checkedInAt)) throw conflict("TICKET_USED", "A ticket in this booking was already used");

    const { count } = await tx.booking.updateMany({
      where: { id: booking.id, status: booking.status },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancellationReason: "Cancelled by attendee" },
    });
    if (count !== 1) throw conflict("STALE_STATE", "The booking changed; reload and try again");
    await tx.ticket.updateMany({ where: { bookingId: booking.id, status: "VALID" }, data: { status: "CANCELLED" } });
    // Return inventory (never below zero: guarded by the WHERE and the CHECK constraint).
    for (const item of booking.items) {
      await tx.$executeRaw`
        UPDATE "TicketType" SET "quantitySold" = "quantitySold" - ${item.quantity}, "updatedAt" = now()
        WHERE "id" = ${item.ticketTypeId} AND "quantitySold" >= ${item.quantity}`;
    }
    return tx.booking.findUniqueOrThrow({ where: { id: booking.id }, include: bookingInclude });
  });
}

/** @param {import("../auth/currentUser").CurrentUser} user @param {{ cursor?: string, limit: number }} f */
function listOwnTickets(user, f) {
  return getPrisma().ticket.findMany({
    where: { holderUserId: user.id, status: { in: ["VALID", "CANCELLED"] } },
    include: { ticketType: { select: { id: true, name: true } }, event: true },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: f.limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
  });
}

/** @param {import("../auth/currentUser").CurrentUser} user @param {string} ticketId */
async function getOwnTicket(user, ticketId) {
  const ticket = await getPrisma().ticket.findFirst({
    where: { id: ticketId, holderUserId: user.id },
    include: { ticketType: { select: { id: true, name: true } }, event: true },
  });
  if (!ticket) throw notFound("Ticket");
  return ticket;
}

module.exports = { createFreeBooking, listOwnBookings, getOwnBooking, cancelOwnBooking, listOwnTickets, getOwnTicket };
