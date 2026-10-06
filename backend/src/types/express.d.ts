import type { LocalUser } from "./local-user";

declare global {
  namespace Express {
    interface Request {
      /** Set by LocalAuthMiddleware.requireLocal. */
      localUser?: LocalUser;
      /** Set by requestContextMiddleware (first middleware). */
      requestId?: string;
    }
  }
}

export {};
