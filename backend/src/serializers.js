// Response shapes. Allow-lists only: never spread database rows into responses,
// so new columns (and PII such as verification data or emails) are never leaked.
const { effectiveVerificationStatus, capabilities } = require("./policy");
const { publicUrl } = require("./storage");

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** @param {any} tt */
function ticketTypePublic(tt) {
  const remaining = Math.max(tt.quantityTotal - tt.quantitySold, 0);
  return {
    id: tt.id,
    name: tt.name,
    description: tt.description,
    priceMinor: tt.priceMinor,
    isFree: tt.priceMinor === 0,
    remaining,
    soldOut: remaining === 0,
    minPerOrder: tt.minPerOrder,
    maxPerOrder: tt.maxPerOrder,
    salesStartAt: iso(tt.salesStartAt),
    salesEndAt: iso(tt.salesEndAt),
  };
}

/** @param {any} tt */
function ticketTypeOwner(tt) {
  return { ...ticketTypePublic(tt), quantityTotal: tt.quantityTotal, quantitySold: tt.quantitySold, status: tt.status, sortOrder: tt.sortOrder };
}

/** @param {any[]} media */
function mediaOf(media = []) {
  const items = media
    .map((m) => ({ assetId: m.assetId, role: m.role, position: m.position, url: m.asset ? publicUrl(m.asset) : null }))
    .filter((m) => m.url)
    .sort((a, b) => (a.role === b.role ? a.position - b.position : a.role === "COVER" ? -1 : 1));
  return { coverImageUrl: items.find((m) => m.role === "COVER")?.url ?? null, gallery: items.filter((m) => m.role === "GALLERY") };
}

/** Sold-out and price summary are DERIVED from active ticket types, never stored. @param {any[]} ticketTypes */
function availability(ticketTypes = []) {
  const active = ticketTypes.filter((t) => t.status === "ACTIVE");
  const prices = active.map((t) => t.priceMinor);
  return {
    soldOut: active.length > 0 && active.every((t) => t.quantitySold >= t.quantityTotal),
    isFree: active.length > 0 && prices.every((p) => p === 0),
    priceFromMinor: prices.length ? Math.min(...prices) : null,
  };
}

/** @param {any} org */
function organizerPublic(org) {
  return {
    id: org.id,
    slug: org.slug,
    displayName: org.displayName,
    type: org.type,
    bio: org.bio,
    websiteUrl: org.websiteUrl,
    city: org.city,
    country: org.country,
    // Only a real, current VERIFIED state produces a badge.
    verified: org.status === "ACTIVE" && org.verificationStatus === "VERIFIED",
  };
}

/** @param {any} org */
function organizerOwner(org) {
  return {
    ...organizerPublic(org),
    contactEmail: org.contactEmail,
    contactPhone: org.contactPhone,
    status: org.status,
    verificationStatus: effectiveVerificationStatus(org),
    verifiedAt: iso(org.verifiedAt),
    createdAt: iso(org.createdAt),
  };
}

/** @param {any} e */
function eventBase(e) {
  return {
    id: e.id,
    slug: e.slug,
    title: e.title,
    summary: e.summary,
    description: e.description,
    status: e.status,
    attendanceMode: e.attendanceMode,
    startsAt: iso(e.startsAt),
    endsAt: iso(e.endsAt),
    timezone: e.timezone,
    venueName: e.venueName,
    addressLine: e.addressLine,
    city: e.city,
    region: e.region,
    country: e.country,
    latitude: e.latitude,
    longitude: e.longitude,
    currency: e.currency,
    categories: (e.categories || []).map((c) => ({ id: c.category.id, name: c.category.name, slug: c.category.slug })),
    ...mediaOf(e.media),
  };
}

/** Public view: no online URL (ticket holders only), only active ticket types. @param {any} e */
function eventPublic(e) {
  const active = (e.ticketTypes || []).filter((t) => t.status === "ACTIVE");
  return {
    ...eventBase(e),
    publishedAt: iso(e.publishedAt),
    cancelledAt: iso(e.cancelledAt),
    organizer: e.organizer ? organizerPublic(e.organizer) : null,
    ticketTypes: active.sort((a, b) => a.sortOrder - b.sortOrder).map(ticketTypePublic),
    ...availability(e.ticketTypes),
  };
}

/** @param {any} e */
function eventOwner(e) {
  return {
    ...eventBase(e),
    onlineUrl: e.onlineUrl,
    submittedAt: iso(e.submittedAt),
    publishedAt: iso(e.publishedAt),
    cancelledAt: iso(e.cancelledAt),
    cancellationReason: e.cancellationReason,
    createdAt: iso(e.createdAt),
    updatedAt: iso(e.updatedAt),
    ticketTypes: (e.ticketTypes || []).sort((a, b) => a.sortOrder - b.sortOrder).map(ticketTypeOwner),
    ...availability(e.ticketTypes),
  };
}

/** Organizer-facing history: reasons yes, internal notes and reviewer identity no. @param {any} a */
function moderationForOrganizer(a) {
  return { action: a.action, fromStatus: a.fromStatus, toStatus: a.toStatus, actorRole: a.actorRole, reason: a.reason, createdAt: iso(a.createdAt) };
}

/** @param {any} a */
function moderationForAdmin(a) {
  return { ...moderationForOrganizer(a), id: a.id, actorId: a.actorId, internalNote: a.internalNote, metadata: a.metadata };
}

/** @param {any} t */
function ticketForHolder(t) {
  return {
    id: t.id,
    code: t.code,
    status: t.status,
    checkedInAt: iso(t.checkedInAt),
    ticketType: t.ticketType ? { id: t.ticketType.id, name: t.ticketType.name } : null,
    event: t.event
      ? {
          id: t.event.id,
          slug: t.event.slug,
          title: t.event.title,
          status: t.event.status,
          startsAt: iso(t.event.startsAt),
          timezone: t.event.timezone,
          venueName: t.event.venueName,
          city: t.event.city,
          // released to ticket holders only
          onlineUrl: t.status === "VALID" ? t.event.onlineUrl : null,
        }
      : null,
    bookingId: t.bookingId,
    createdAt: iso(t.createdAt),
  };
}

/** @param {any} b */
function bookingForOwner(b) {
  return {
    id: b.id,
    status: b.status,
    currency: b.currency,
    totalMinor: b.totalMinor,
    bookingDate: iso(b.bookingDate),
    confirmedAt: iso(b.confirmedAt),
    cancelledAt: iso(b.cancelledAt),
    cancellationReason: b.cancellationReason,
    items: (b.items || []).map((i) => ({
      ticketTypeId: i.ticketTypeId,
      ticketTypeName: i.ticketType ? i.ticketType.name : null,
      quantity: i.quantity,
      unitPriceMinor: i.unitPriceMinor,
    })),
    event: b.event
      ? {
          id: b.event.id,
          slug: b.event.slug,
          title: b.event.title,
          summary: b.event.summary,
          status: b.event.status,
          startsAt: iso(b.event.startsAt),
          timezone: b.event.timezone,
          venueName: b.event.venueName,
          city: b.event.city,
          ...mediaOf(b.event.media),
        }
      : null,
    tickets: (b.tickets || []).map((t) => ticketForHolder({ ...t, event: b.event })),
  };
}

/** Organizer's attendee view: minimum necessary, no email (approved privacy rule). @param {any} t */
function attendeeForOrganizer(t) {
  return {
    ticketId: t.id,
    status: t.status,
    checkedInAt: iso(t.checkedInAt),
    ticketType: t.ticketType ? t.ticketType.name : null,
    bookingDate: iso(t.booking ? t.booking.bookingDate : t.createdAt),
    attendeeName: t.holder ? t.holder.displayName || t.holder.name || "Guest" : "Guest",
  };
}

/** @param {any} user */
function me(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    phone: user.phone,
    location: user.location,
    status: user.status,
    platformRole: user.platformRole,
    capabilities: capabilities(user),
    organizer: user.organizer ? organizerOwner(user.organizer) : null,
    createdAt: iso(user.createdAt),
  };
}

/** @param {any} user */
function userForAdmin(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    displayName: user.displayName,
    status: user.status,
    platformRole: user.platformRole,
    hasLegacyAccount: Boolean(user.legacyFirebaseUid),
    linkedToClerk: Boolean(user.clerkUserId),
    organizer: user.organizer
      ? { id: user.organizer.id, slug: user.organizer.slug, displayName: user.organizer.displayName, status: user.organizer.status, verificationStatus: effectiveVerificationStatus(user.organizer) }
      : null,
    createdAt: iso(user.createdAt),
  };
}

/** Organizer's own view of a submission: no declared PII echo, no internal notes. @param {any} s */
function submissionForOrganizer(s) {
  return {
    id: s.id,
    status: s.status,
    country: s.country,
    organizerType: s.organizerType,
    requirementSetVersion: s.requirementSetVersion,
    supersedesId: s.supersedesId,
    submittedAt: iso(s.submittedAt),
    evidence: (s.evidence || []).map((e) => ({ id: e.id, requirementKey: e.requirementKey, kind: e.kind, hasFile: Boolean(e.assetId) })),
    decisions: (s.decisions || []).map((d) => ({ action: d.action, reason: d.reason, createdAt: iso(d.createdAt) })),
  };
}

/** Queue row: no PII. @param {any} s */
function submissionSummaryForAdmin(s) {
  return {
    id: s.id,
    status: s.status,
    country: s.country,
    organizerType: s.organizerType,
    requirementSetVersion: s.requirementSetVersion,
    submittedAt: iso(s.submittedAt),
    supersedesId: s.supersedesId,
    organizer: s.organizer ? { id: s.organizer.id, slug: s.organizer.slug, displayName: s.organizer.displayName, status: s.organizer.status } : null,
  };
}

/** Full review view (access is audited by the caller). Evidence values are fetched individually. @param {any} s */
function submissionDetailForAdmin(s) {
  return {
    ...submissionSummaryForAdmin(s),
    declaredData: s.declaredData,
    evidence: (s.evidence || []).map((e) => ({ id: e.id, requirementKey: e.requirementKey, kind: e.kind, hasFile: Boolean(e.assetId), hasValue: e.value !== null, note: e.note })),
    decisions: (s.decisions || []).map((d) => ({
      id: d.id, action: d.action, reason: d.reason, internalNote: d.internalNote, reviewerId: d.reviewerId, createdAt: iso(d.createdAt),
    })),
  };
}

/** @param {any} r */
function reportForReporter(r) {
  return { id: r.id, reason: r.reason, status: r.status, eventId: r.eventId, organizerId: r.organizerId, targetUserId: r.targetUserId, createdAt: iso(r.createdAt) };
}

/** @param {any} r */
function reportForAdmin(r) {
  return {
    ...reportForReporter(r),
    reporterId: r.reporterId,
    details: r.details,
    resolution: r.resolution,
    resolvedById: r.resolvedById,
    resolvedAt: iso(r.resolvedAt),
  };
}

/** @param {any} a */
function auditEntry(a) {
  return {
    id: a.id, actorId: a.actorId, actorRole: a.actorRole, action: a.action, targetType: a.targetType, targetId: a.targetId,
    metadata: a.metadata, requestId: a.requestId, createdAt: iso(a.createdAt),
  };
}

module.exports = {
  iso,
  eventPublic,
  eventOwner,
  organizerPublic,
  organizerOwner,
  ticketTypeOwner,
  ticketTypePublic,
  moderationForOrganizer,
  moderationForAdmin,
  ticketForHolder,
  bookingForOwner,
  attendeeForOrganizer,
  me,
  userForAdmin,
  submissionForOrganizer,
  submissionSummaryForAdmin,
  submissionDetailForAdmin,
  reportForReporter,
  reportForAdmin,
  auditEntry,
};
