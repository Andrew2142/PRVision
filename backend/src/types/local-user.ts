/** The single local user every request and worker job runs as (00 D9: no authentication). */
export interface LocalUser {
  readonly id: 1;
  readonly login: "local";
  readonly displayName: string;
}

/** Frozen constant put into AuthContext by LocalAuthMiddleware.requireLocal and AuthContext.runAsLocalUser. */
export const LOCAL_USER: LocalUser = Object.freeze({ id: 1, login: "local", displayName: "Local user" });
