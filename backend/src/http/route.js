const { z } = require("zod");

/**
 * Wraps an async handler with optional zod validation of params, query and body.
 * Parsed values are exposed as req.valid; invalid input never reaches the handler.
 *
 * @param {{ params?: z.ZodTypeAny, query?: z.ZodTypeAny, body?: z.ZodTypeAny }} schemas
 * @param {(req: any, res: import("express").Response) => Promise<unknown>} handler
 * @returns {import("express").RequestHandler}
 */
function route(schemas, handler) {
  return async (req, res, next) => {
    try {
      /** @type {any} */ (req).valid = {
        params: schemas.params ? schemas.params.parse(req.params) : req.params,
        query: schemas.query ? schemas.query.parse(req.query) : {},
        body: schemas.body ? schemas.body.parse(req.body ?? {}) : {},
      };
      await handler(req, res);
    } catch (err) {
      next(err);
    }
  };
}

// Shared schema pieces
const id = z.string().trim().min(1).max(64);
const idParam = z.object({ id }).strict();
const pagination = {
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
const reason = z.string().trim().min(3).max(2000);

/**
 * Cursor pagination helper over an id-ordered Prisma query result.
 * @template T
 * @param {T[]} rows rows fetched with take: limit + 1
 * @param {number} limit
 * @param {(row: T) => string} getId
 */
function page(rows, limit, getId) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? getId(items[items.length - 1]) : null };
}

module.exports = { route, id, idParam, pagination, reason, page, z };
