import { type VisualizationStatus } from '../../../core/models/domain-enums.model';

/** The three sections of the detail page, picked with the selector under the header (revision 5). */
export type DetailView = 'summary' | 'components' | 'console';

export const DETAIL_VIEWS: readonly DetailView[] = ['components', 'summary', 'console'];

/** `?view=` value → view; anything else (missing, empty, unknown, wrong case) → null. */
export function parseDetailView(raw: string | null | undefined): DetailView | null {
  return DETAIL_VIEWS.find((v) => v === raw) ?? null;
}

/** Summary once the run completed; the live console while it runs or after it failed or was cancelled. */
export function defaultDetailView(status: VisualizationStatus | null): DetailView {
  return status === 'completed' ? 'summary' : 'console';
}
