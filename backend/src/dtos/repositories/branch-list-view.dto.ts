/** Response of GET /api/repositories/:id/branches (00 §9). */
export interface BranchListView {
  current: string | null;
  branches: string[];
  defaultBranch: string;
  workingTreeDirty: boolean;
}
