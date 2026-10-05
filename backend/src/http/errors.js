const { ZodError } = require("zod");
const { Prisma } = require("@prisma/client");

// Errors that are safe to show to clients. Anything else becomes a generic 500.
class AppError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (code, message, details) => new AppError(400, code, message, details);
const unauthorized = (message = "Authentication required") => new AppError(401, "UNAUTHENTICATED", message);
const forbidden = (code, message) => new AppError(403, code, message);
// Also used for resources that exist but belong to someone else: never reveal existence.
const notFound = (what = "Resource") => new AppError(404, "NOT_FOUND", `${what} not found`);
const conflict = (code, message, details) => new AppError(409, code, message, details);

/** @type {import("express").RequestHandler} */
const notFoundHandler = (req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
};

/**
 * @param {{ log?: (entry: object) => void }} [options]
 * @returns {import("express").ErrorRequestHandler}
 */
function errorHandler({ log = (entry) => console.error(JSON.stringify(entry)) } = {}) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    const requestId = /** @type {any} */ (req).id;

    if (err instanceof AppError) {
      return res.status(err.status).json({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
    }
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
    }
    if (err && err.type === "entity.parse.failed") {
      return res.status(400).json({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON" } });
    }
    if (err && err.type === "entity.too.large") {
      return res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" } });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === "P2002") {
        return res.status(409).json({ error: { code: "CONFLICT", message: "Resource already exists" } });
      }
      if (err.code === "P2025") {
        return res.status(404).json({ error: { code: "NOT_FOUND", message: "Resource not found" } });
      }
    }

    // Unexpected: log server-side without request bodies; never leak internals.
    log({
      level: "error",
      requestId,
      method: req.method,
      path: req.path,
      name: err && err.name,
      code: err && err.code,
      message: err && err.message,
    });
    return res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong", requestId } });
  };
}

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  notFoundHandler,
  errorHandler,
};
