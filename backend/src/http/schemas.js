// Request schemas shared by the routers. Unknown fields are rejected (.strict()).
const { z } = require("zod");

const trimmed = (min, max) => z.string().trim().min(min).max(max);
const optionalText = (max) => z.string().trim().max(max).nullable().optional();

const timezone = z.string().trim().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "Must be an IANA time zone, e.g. Africa/Lagos");

const httpsUrl = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((u) => u.startsWith("https://"), "Must be an https URL");

const countryCode = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Must be an ISO 3166-1 alpha-2 code");
const currencyCode = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Must be an ISO 4217 code");
const MAX_PRICE_MINOR = 1_000_000_000; // 10M major units

const ticketTypeFields = {
  name: trimmed(1, 80),
  description: optionalText(500),
  priceMinor: z.number().int().min(0).max(MAX_PRICE_MINOR),
  quantityTotal: z.number().int().min(1).max(1_000_000),
  minPerOrder: z.number().int().min(1).max(100).optional(),
  maxPerOrder: z.number().int().min(1).max(100).optional(),
  salesStartAt: z.coerce.date().nullable().optional(),
  salesEndAt: z.coerce.date().nullable().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
};

/** @param {any} t */
const orderLimitsValid = (t) => t.minPerOrder === undefined || t.maxPerOrder === undefined || t.maxPerOrder >= t.minPerOrder;
/** @param {any} t */
const salesWindowValid = (t) => !t.salesStartAt || !t.salesEndAt || t.salesEndAt > t.salesStartAt;

const ticketTypeCreate = z
  .object({ ...ticketTypeFields, status: z.enum(["ACTIVE", "HIDDEN"]).optional() })
  .strict()
  .refine(orderLimitsValid, { message: "maxPerOrder must be >= minPerOrder" })
  .refine(salesWindowValid, { message: "salesEndAt must be after salesStartAt" });

const ticketTypeUpdate = z
  .object({
    name: ticketTypeFields.name.optional(),
    description: ticketTypeFields.description,
    priceMinor: ticketTypeFields.priceMinor.optional(),
    quantityTotal: ticketTypeFields.quantityTotal.optional(),
    minPerOrder: ticketTypeFields.minPerOrder,
    maxPerOrder: ticketTypeFields.maxPerOrder,
    salesStartAt: ticketTypeFields.salesStartAt,
    salesEndAt: ticketTypeFields.salesEndAt,
    sortOrder: ticketTypeFields.sortOrder,
    status: z.enum(["ACTIVE", "HIDDEN", "ARCHIVED"]).optional(),
  })
  .strict()
  .refine(orderLimitsValid, { message: "maxPerOrder must be >= minPerOrder" })
  .refine(salesWindowValid, { message: "salesEndAt must be after salesStartAt" });

const eventFields = {
  title: trimmed(3, 140),
  summary: trimmed(1, 300),
  description: trimmed(1, 10000),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().nullable().optional(),
  timezone,
  attendanceMode: z.enum(["IN_PERSON", "ONLINE", "HYBRID"]).optional(),
  venueName: optionalText(200),
  addressLine: optionalText(300),
  city: optionalText(120),
  region: optionalText(120),
  country: countryCode.nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  onlineUrl: httpsUrl.nullable().optional(),
  currency: currencyCode,
  categoryIds: z.array(z.string().min(1).max(64)).max(5).optional(),
};

/** @param {any} e */
const coordinatesPaired = (e) => (e.latitude == null) === (e.longitude == null);
/** @param {any} e */
const endsAfterStart = (e) => !e.endsAt || !e.startsAt || e.endsAt > e.startsAt;

const eventCreate = z
  .object({ ...eventFields, ticketTypes: z.array(ticketTypeCreate).max(20).optional() })
  .strict()
  .refine((e) => e.startsAt > new Date(), { message: "startsAt must be in the future", path: ["startsAt"] })
  .refine(endsAfterStart, { message: "endsAt must be after startsAt", path: ["endsAt"] })
  .refine(coordinatesPaired, { message: "latitude and longitude go together", path: ["latitude"] });

const eventUpdate = z
  .object(Object.fromEntries(Object.entries(eventFields).map(([k, v]) => [k, v.optional()])))
  .strict()
  .refine((e) => !e.startsAt || e.startsAt > new Date(), { message: "startsAt must be in the future", path: ["startsAt"] })
  .refine(endsAfterStart, { message: "endsAt must be after startsAt", path: ["endsAt"] })
  .refine((e) => e.latitude === undefined || e.longitude === undefined || coordinatesPaired(e), { message: "latitude and longitude go together", path: ["latitude"] });

const organizerFields = {
  displayName: trimmed(2, 100),
  type: z.enum(["INDIVIDUAL", "BUSINESS", "NON_PROFIT"]).optional(),
  bio: optionalText(2000),
  websiteUrl: httpsUrl.nullable().optional(),
  contactEmail: z.string().trim().toLowerCase().email().max(200).nullable().optional(),
  contactPhone: optionalText(40),
  country: countryCode.nullable().optional(),
  city: optionalText(120),
};
const organizerCreate = z.object(organizerFields).strict();
const organizerUpdate = z.object({ ...organizerFields, displayName: organizerFields.displayName.optional() }).strict();

const verificationSubmission = z
  .object({
    country: countryCode,
    organizerType: z.enum(["INDIVIDUAL", "BUSINESS", "NON_PROFIT"]),
    declaredData: z.record(z.string().max(64), z.string().trim().max(1000)),
    evidence: z
      .array(
        z
          .object({
            requirementKey: z.string().trim().min(1).max(64),
            kind: z.enum(["GOVERNMENT_ID", "BUSINESS_REGISTRATION", "PROOF_OF_ADDRESS", "TAX_ID", "WEB_PRESENCE", "SOCIAL_PROFILE", "OTHER"]),
            assetId: z.string().min(1).max(64).optional(),
            value: z.string().trim().min(1).max(1000).optional(),
            note: z.string().trim().max(1000).optional(),
          })
          .strict()
          .refine((e) => Boolean(e.assetId) !== Boolean(e.value), { message: "Provide either a file (assetId) or a value" }),
      )
      .min(1)
      .max(20),
  })
  .strict();

const bookingCreate = z
  .object({
    eventId: z.string().min(1).max(64),
    items: z
      .array(z.object({ ticketTypeId: z.string().min(1).max(64), quantity: z.number().int().min(1).max(100) }).strict())
      .min(1)
      .max(10),
    idempotencyKey: z.string().trim().regex(/^[\w-]{8,100}$/, "8-100 letters, digits, '-' or '_'"),
  })
  .strict();

const reportCreate = z
  .object({
    targetType: z.enum(["EVENT", "ORGANIZER", "USER"]),
    targetId: z.string().min(1).max(64),
    reason: z.enum(["SCAM_OR_FRAUD", "MISLEADING", "INAPPROPRIATE", "SPAM", "SAFETY_CONCERN", "INTELLECTUAL_PROPERTY", "OTHER"]),
    details: z.string().trim().max(2000).optional(),
  })
  .strict();

const meUpdate = z
  .object({ displayName: optionalText(80), phone: optionalText(40), location: optionalText(120) })
  .strict();

module.exports = {
  timezone,
  httpsUrl,
  countryCode,
  currencyCode,
  ticketTypeCreate,
  ticketTypeUpdate,
  eventCreate,
  eventUpdate,
  organizerCreate,
  organizerUpdate,
  verificationSubmission,
  bookingCreate,
  reportCreate,
  meUpdate,
};
