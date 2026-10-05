// Country-aware verification requirements, versioned. Each submission stores the
// version it was checked against, so past decisions stay explainable after rules change.
// Countries without a specific set use DEFAULT. To add a country, add a set below
// (e.g. "GH:BUSINESS"); no schema change is needed.

/**
 * @typedef {{ key: string, kinds: import("@prisma/client").EvidenceKind[], accepts: Array<"file"|"value">, required: boolean, label: string }} EvidenceRequirement
 * @typedef {{ key: string, required: boolean, label: string }} DeclaredField
 * @typedef {{ version: string, declaredFields: DeclaredField[], evidence: EvidenceRequirement[] }} RequirementSet
 */

/** @type {Record<string, RequirementSet>} */
const SETS = {
  "DEFAULT:INDIVIDUAL": {
    version: "DEFAULT-INDIVIDUAL@2026-10",
    declaredFields: [
      { key: "legalName", required: true, label: "Full legal name" },
      { key: "address", required: true, label: "Residential address" },
    ],
    evidence: [
      { key: "gov_id", kinds: ["GOVERNMENT_ID"], accepts: ["file"], required: true, label: "Government-issued ID" },
      { key: "web_presence", kinds: ["WEB_PRESENCE", "SOCIAL_PROFILE"], accepts: ["value"], required: false, label: "Website or social profile" },
    ],
  },
  "DEFAULT:BUSINESS": {
    version: "DEFAULT-BUSINESS@2026-10",
    declaredFields: [
      { key: "legalName", required: true, label: "Registered business name" },
      { key: "registrationNumber", required: true, label: "Business registration number" },
      { key: "address", required: true, label: "Registered address" },
      { key: "representativeName", required: true, label: "Authorised representative" },
    ],
    evidence: [
      { key: "business_registration", kinds: ["BUSINESS_REGISTRATION"], accepts: ["file"], required: true, label: "Registration certificate" },
      { key: "representative_id", kinds: ["GOVERNMENT_ID"], accepts: ["file"], required: true, label: "Representative's government ID" },
      { key: "web_presence", kinds: ["WEB_PRESENCE", "SOCIAL_PROFILE"], accepts: ["value"], required: true, label: "Website or social profile" },
    ],
  },
  "DEFAULT:NON_PROFIT": {
    version: "DEFAULT-NON_PROFIT@2026-10",
    declaredFields: [
      { key: "legalName", required: true, label: "Registered organisation name" },
      { key: "registrationNumber", required: true, label: "Registration number" },
      { key: "address", required: true, label: "Registered address" },
      { key: "representativeName", required: true, label: "Authorised representative" },
    ],
    evidence: [
      { key: "registration", kinds: ["BUSINESS_REGISTRATION"], accepts: ["file"], required: true, label: "Registration certificate" },
      { key: "representative_id", kinds: ["GOVERNMENT_ID"], accepts: ["file"], required: true, label: "Representative's government ID" },
      { key: "web_presence", kinds: ["WEB_PRESENCE", "SOCIAL_PROFILE"], accepts: ["value"], required: false, label: "Website or social profile" },
    ],
  },
  // Nigeria: the CAC registration number is declared; tax ID is optional supporting evidence.
  "NG:BUSINESS": {
    version: "NG-BUSINESS@2026-10",
    declaredFields: [
      { key: "legalName", required: true, label: "Registered business name (CAC)" },
      { key: "registrationNumber", required: true, label: "CAC registration number (RC/BN)" },
      { key: "address", required: true, label: "Registered address" },
      { key: "representativeName", required: true, label: "Authorised representative" },
    ],
    evidence: [
      { key: "business_registration", kinds: ["BUSINESS_REGISTRATION"], accepts: ["file"], required: true, label: "CAC certificate" },
      { key: "representative_id", kinds: ["GOVERNMENT_ID"], accepts: ["file"], required: true, label: "Representative's government ID" },
      { key: "tax_id", kinds: ["TAX_ID"], accepts: ["file", "value"], required: false, label: "Tax identification number" },
      { key: "web_presence", kinds: ["WEB_PRESENCE", "SOCIAL_PROFILE"], accepts: ["value"], required: true, label: "Website or social profile" },
    ],
  },
};

/**
 * @param {string} country ISO alpha-2
 * @param {import("@prisma/client").OrganizerType} organizerType
 * @returns {RequirementSet}
 */
function requirementsFor(country, organizerType) {
  return SETS[`${country}:${organizerType}`] || SETS[`DEFAULT:${organizerType}`];
}

module.exports = { requirementsFor };
