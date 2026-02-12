import { createMiddleware } from "hono/factory";

const PUBLIC_PATHS = new Set(["/health", "/openapi.json"]);

export function bearerAuth(apiToken: string) {
  return createMiddleware(async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) {
      return next();
    }

    const header = c.req.header("authorization");
    if (!header) {
      return c.json(
        { code: "PERMISSION_DENIED", message: "Missing Authorization header" },
        401,
      );
    }

    const [scheme, token] = header.split(" ", 2);
    if (scheme !== "Bearer" || token !== apiToken) {
      return c.json(
        { code: "PERMISSION_DENIED", message: "Invalid bearer token" },
        401,
      );
    }

    return next();
  });
}
