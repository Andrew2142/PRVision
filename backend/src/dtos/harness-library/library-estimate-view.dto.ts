/** Scan estimate (16 §14.3, §10.7): the component count and the expected cost with the current model. */
export interface LibraryEstimateView {
  componentCount: number;
  toWriteCount: number;
  truncated: boolean;
  stateAllowance: number;
  kind: "scan" | "rescan";
  model: string;
  priceModel: string;
  priceExact: boolean;
  basis: "history" | "default";
  perHarnessUsd: number;
  estimatedUsd: number;
  lowUsd: number;
  highUsd: number;
  estimatedMinutes: number;
  warnings: string[];
}
