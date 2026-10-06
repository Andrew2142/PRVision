import { enumValues, type ValueOf } from "../utility/value-of";

export const VisualizationSourceType = {
  GITHUB_PR: "github_pr",
  LOCAL_BRANCH: "local_branch",
  WORKING_TREE: "working_tree",
  /** Two commits on one branch (00 §16). */
  COMMIT_RANGE: "commit_range"
} as const;
export type VisualizationSourceType = ValueOf<typeof VisualizationSourceType>;
export const VISUALIZATION_SOURCE_TYPE_VALUES = enumValues(VisualizationSourceType);
