/** GET /api/health — always HTTP 200 (00 §14.4). */
export interface HealthView {
  status: "ok" | "degraded";
  database: boolean;
  redis: boolean;
  /** APP_VERSION. */
  version: string;
}
