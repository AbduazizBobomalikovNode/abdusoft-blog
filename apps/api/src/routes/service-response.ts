import type { Context } from "hono";
import { SERVICE_ERROR_STATUS, type ServiceError } from "../lib/posts/types.js";

/** Xizmat xatosini (`ServiceError`) HTTP javobiga aylantiradi: `{ error, ...extra }` + mos status. */
export function errorResponse(c: Context, error: ServiceError): Response {
  return c.json({ error: error.message, ...(error.extra ?? {}) }, SERVICE_ERROR_STATUS[error.kind]);
}
