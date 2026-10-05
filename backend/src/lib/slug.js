const crypto = require("node:crypto");

/** @param {string} text @param {string} fallback */
function slugify(text, fallback = "item") {
  const base = (text || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || fallback;
}

/** Slug with a random suffix so titles never need to be unique. @param {string} text @param {string} fallback */
const uniqueSlug = (text, fallback) => `${slugify(text, fallback)}-${crypto.randomBytes(4).toString("hex")}`;

module.exports = { slugify, uniqueSlug };
