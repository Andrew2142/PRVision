import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";
import { LOCAL_USER, type LocalUser } from "../../types/local-user";

type AuthStore = { user?: LocalUser; requestId?: string };

/**
 * Request- and job-scoped context (AsyncLocalStorage): the local user and the request id. Controllers, services,
 * middleware and the logger read it without passing the request object around. Adapted from Uply-v2 without
 * sessions or core users (00 D9: no authentication).
 */
export class AuthContext {
  private static readonly storage = new AsyncLocalStorage<AuthStore>();

  /**
   * Opens the request store. Mounted after express.json (04 §5.1): body-parser resumes the request from the
   * socket's async context, so a store opened earlier would be lost. Carries the id set by
   * requestContextMiddleware.
   */
  static middleware(req: Request, _res: Response, next: NextFunction): void {
    AuthContext.storage.run({ requestId: req.requestId }, () => {
      next();
    });
  }

  /**
   * Runs fn inside a fresh store with the local user set (worker jobs, tests). Sync throws become rejections.
   *
   * @param fn - Work to run inside the context.
   * @param options - Optional request id (the BullMQ job id for worker jobs) and user override.
   */
  static runAsLocalUser<T>(
    fn: () => Promise<T> | T,
    options: { requestId?: string; user?: LocalUser } = {}
  ): Promise<T> {
    return AuthContext.storage.run({ user: options.user ?? LOCAL_USER, requestId: options.requestId }, async () => {
      const result = await fn();
      return result;
    });
  }

  /** Stores the user on the current context. Throws outside a context. */
  static setUser(user: LocalUser): void {
    AuthContext.getStore().user = user;
  }

  /** The current user, when inside a context that has one. */
  static getUser(): LocalUser | undefined {
    return AuthContext.storage.getStore()?.user;
  }

  /** The current user, or throws when the context has none. */
  static requireUser(): LocalUser {
    const user = AuthContext.getUser();
    if (!user) {
      throw new Error("Local user context is not available");
    }
    return user;
  }

  /** The current user id, when available. */
  static getUserId(): number | undefined {
    return AuthContext.getUser()?.id;
  }

  /** The current user id, or throws when the context has no user. */
  static requireUserId(): number {
    return AuthContext.requireUser().id;
  }

  /** Stores the request id on the current context. Throws outside a context. */
  static setRequestId(requestId: string): void {
    AuthContext.getStore().requestId = requestId;
  }

  /** The current request id (HTTP request or worker job), when available. */
  static getRequestId(): string | undefined {
    return AuthContext.storage.getStore()?.requestId;
  }

  private static getStore(): AuthStore {
    const store = AuthContext.storage.getStore();
    if (!store) {
      throw new Error("AuthContext store is not initialized for this request");
    }
    return store;
  }
}
