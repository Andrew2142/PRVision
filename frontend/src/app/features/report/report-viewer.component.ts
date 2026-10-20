import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { type VisualizationDetailView } from '../../core/models/visualization.model';
import { setArtifactBaseUrl } from '../../core/utils/artifact-url.util';
import { EmptyStateComponent } from '../../shared/components/empty-state/empty-state.component';
import { InlineAlertComponent } from '../../shared/components/inline-alert/inline-alert.component';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner.component';
import {
  type SegmentOption,
  SegmentedControlComponent,
} from '../../shared/components/segmented-control/segmented-control.component';
import { StatusPillComponent } from '../../shared/components/status-pill/status-pill.component';
import { ComponentCardComponent } from '../visualizations/components/component-card/component-card.component';
import { SummaryCardComponent } from '../visualizations/components/summary-card/summary-card.component';
import {
  COMPONENT_FILTER_PREDICATES,
  type ComponentFilter,
  countComponents,
  defaultComponentFilter,
} from '../visualizations/visualization-detail/component-filters';
import { frameworkChipLabel, refWithSha, summaryLine } from '../visualizations/visualization-format';

/** The report.json a headless run writes (backend `headless/report-export.ts`). */
export interface HeadlessReport {
  format: number;
  generatedAt: string;
  repository: { name: string; path: string };
  visualization: VisualizationDetailView;
}

export const REPORT_FORMAT_VERSION = 1;
type ReportView = 'components' | 'summary';

/** report.json keeps image paths relative ("artifacts/…"); the app's image helper expects "/artifacts/…". */
function absolutizeImages(value: unknown): unknown {
  if (typeof value === 'string') {
    return /^artifacts\/\d+\/\d+\/(?:s\d+\/)?(?:base|head|diff)\.png$/.test(value) ? `/${value}` : value;
  }
  if (Array.isArray(value)) return value.map(absolutizeImages);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, absolutizeImages(item)]));
  }
  return value;
}

/** `?src=` names the report; the default is report.json next to the page. */
export function reportSource(search: string, href: string): URL {
  const src = new URLSearchParams(search).get('src') ?? 'report.json';
  return new URL(src, href);
}

/**
 * A headless run's report, read-only: the same header and component cards as the visualization page, loaded from
 * report.json instead of the API. Used for local previews and for hosted reports.
 */
@Component({
  selector: 'app-report-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ComponentCardComponent,
    SummaryCardComponent,
    SegmentedControlComponent,
    StatusPillComponent,
    EmptyStateComponent,
    InlineAlertComponent,
    LoadingSpinnerComponent,
  ],
  templateUrl: './report-viewer.component.html',
  host: { class: 'block min-h-full bg-[var(--color-bg-primary)]' },
})
export class ReportViewerComponent {
  private readonly http = inject(HttpClient);

  protected readonly report = signal<HeadlessReport | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly view = signal<ReportView>('components');
  protected readonly filterChoice = signal<ComponentFilter | null>(null);

  protected readonly detail = computed(() => this.report()?.visualization ?? null);
  protected readonly counts = computed(() => countComponents(this.detail()?.components ?? []));
  protected readonly filter = computed<ComponentFilter>(() => {
    const d = this.detail();
    return this.filterChoice() ?? (d ? defaultComponentFilter(this.counts(), d.components) : 'all');
  });
  protected readonly components = computed(() =>
    (this.detail()?.components ?? []).filter(COMPONENT_FILTER_PREDICATES[this.filter()]),
  );
  protected readonly header = computed(() => {
    const v = this.detail();
    if (!v) return null;
    const head = v.sourceType === 'working_tree' ? 'working tree' : refWithSha(v.headRef, v.headSha);
    return {
      title: v.title,
      status: v.status,
      repositoryName: v.repositoryName,
      frameworkLabel: frameworkChipLabel(v.framework),
      refsBase: refWithSha(v.baseRef, v.baseSha),
      refsHead: head,
      summaryLine: summaryLine(v),
    };
  });
  protected readonly viewOptions = computed<SegmentOption<ReportView>[]>(() => [
    { value: 'components', label: 'Components', count: this.counts().all },
    { value: 'summary', label: 'Summary' },
  ]);
  protected readonly filterOptions = computed<SegmentOption<ComponentFilter>[]>(() => {
    const c = this.counts();
    return [
      { value: 'changed', label: 'Changed', count: c.changed },
      { value: 'unchanged', label: 'Unchanged', count: c.unchanged },
      { value: 'failed', label: 'Failed', count: c.failed },
      { value: 'all', label: 'All', count: c.all },
    ];
  });

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const url = reportSource(window.location.search, window.location.href);
      const raw = await firstValueFrom(this.http.get<HeadlessReport>(url.toString()));
      if (raw.format !== REPORT_FORMAT_VERSION) {
        this.loadError.set(`This report was written by a different PRVision version (format ${String(raw.format)}).`);
        return;
      }
      // Screenshots sit next to report.json.
      setArtifactBaseUrl(new URL('.', url).toString());
      this.report.set(absolutizeImages(raw) as HeadlessReport);
      document.title = `${raw.visualization.title} · PRVision`;
    } catch {
      this.loadError.set('The report could not be loaded. Check the link, or run /prvision again.');
    }
  }
}
