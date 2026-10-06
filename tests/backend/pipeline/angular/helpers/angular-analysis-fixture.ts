/**
 * 15b test fixture: a small Angular 21 workspace in a monorepo app root (`apps/web`), shaped like the sheet 15
 * §5.9.2 fixture, plus a runner that analyses base/head file maps with 08's worktree helpers (stub git and
 * persistence, no database).
 */
import type { TestContext as NodeTestContext } from "node:test";
import { AngularChangeAnalysisService } from "../../../../../backend/src/services/visualizations/pipeline/angular/angular-change-analysis-service";
import type { ChangeAnalysisResult, PipelineContext } from "../../../../../backend/src/types/visualization-pipeline";
import type { GitNameStatusEntry } from "../../../../../backend/src/utilities/services/git-client";
import {
  diffEntries,
  makeContext,
  makeWorktrees,
  stubGitClient,
  stubPersistence,
  type FileMap,
  type StubPersistence,
  type TestContext
} from "../../change-analysis/helpers/worktree-fixture";

export const APP = "apps/web";
export const SRC = `${APP}/src`;
export const APP_DIR = `${SRC}/app`;

export const ANGULAR_JSON = JSON.stringify(
  {
    version: 1,
    projects: {
      web: {
        projectType: "application",
        root: "",
        sourceRoot: "src",
        architect: {
          build: {
            builder: "@angular/build:application",
            options: {
              browser: "src/main.ts",
              index: "src/index.html",
              tsConfig: "tsconfig.app.json",
              polyfills: ["zone.js"],
              styles: ["src/styles.css"]
            },
            configurations: { development: { optimization: false } }
          }
        }
      }
    }
  },
  null,
  2
);

const BADGE_TS = `import { Component, Input } from "@angular/core";

@Component({
  selector: "app-badge",
  templateUrl: "./badge.component.html",
  styleUrl: "./badge.component.css"
})
export class BadgeComponent {
  @Input() label!: string;
  @Input() tone: "info" | "warn" = "info";
}
`;

const ORDER_LIST_TS = `import { Component } from "@angular/core";
import { BadgeComponent } from "@app/shared/badge/badge.component";
import { HighlightDirective } from "../../shared/directives/highlight.directive";
import { MoneyPipe } from "../../shared/pipes/money.pipe";
import { Order, OrdersService } from "../orders.service";

@Component({
  selector: "app-order-list",
  imports: [BadgeComponent, MoneyPipe, HighlightDirective],
  templateUrl: "./order-list.component.html",
  styleUrls: ["./order-list.component.scss"]
})
export class OrderListComponent {
  orders: Order[] = [];
  constructor(private readonly ordersService: OrdersService) {}
}
`;

const ORDER_LIST_HTML = `<section class="orders">
  @for (order of orders; track order.id) {
    <div appHighlight>
      <app-badge [label]="order.status" tone="info" />
      <span>{{ order.total | money }}</span>
    </div>
  } @empty {
    <p>No orders</p>
  }
</section>
`;

export const MAIN_FILES: FileMap = {
  "package.json": JSON.stringify({ name: "sample-angular-monorepo", private: true }),
  [`${APP}/package.json`]: JSON.stringify({ name: "web", dependencies: { "@angular/core": "~21.2.0" } }),
  [`${APP}/angular.json`]: ANGULAR_JSON,
  [`${APP}/tsconfig.json`]: JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/app/*"] } } }),
  [`${APP}/tsconfig.app.json`]: JSON.stringify({ extends: "./tsconfig.json", files: ["src/main.ts"] }),
  [`${APP}/tailwind.config.js`]: "module.exports = { content: ['./src/**/*.{html,ts}'] };\n",
  [`${SRC}/index.html`]: "<!doctype html><html><body><app-root></app-root></body></html>\n",
  [`${SRC}/styles.css`]: '@import "./styles/base.css";\n.card { padding: 1rem; }\n',
  [`${SRC}/styles/base.css`]: "body { margin: 0; }\n",
  [`${SRC}/main.ts`]: `import { bootstrapApplication } from "@angular/platform-browser";
import { AppComponent } from "./app/app.component";
import { appConfig } from "./app/app.config";

bootstrapApplication(AppComponent, appConfig).catch((err) => console.error(err));
`,
  [`${APP_DIR}/app.config.ts`]: `import { ApplicationConfig } from "@angular/core";
import { provideRouter } from "@angular/router";
import { API_BASE_URL } from "./tokens";

export const appConfig: ApplicationConfig = {
  providers: [provideRouter([]), { provide: API_BASE_URL, useValue: "/api" }]
};
`,
  [`${APP_DIR}/tokens.ts`]: `import { InjectionToken } from "@angular/core";
export const API_BASE_URL = new InjectionToken<string>("API_BASE_URL");
`,
  [`${APP_DIR}/app.component.ts`]: `import { Component } from "@angular/core";
import { OrderListComponent } from "./orders/order-list/order-list.component";
import { OrderSummaryComponent } from "./orders/order-summary.component";

@Component({
  selector: "app-root",
  imports: [OrderListComponent, OrderSummaryComponent],
  template: \`<main><app-order-list /><app-order-summary /><img src="assets/logo.svg" alt="logo" /></main>\`
})
export class AppComponent {}
`,
  [`${SRC}/assets/logo.svg`]: '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
  [`${APP_DIR}/shared/badge/badge.component.ts`]: BADGE_TS,
  [`${APP_DIR}/shared/badge/badge.component.html`]:
    '<span class="badge" [class.warn]="tone === \'warn\'">{{ label }}</span>\n',
  [`${APP_DIR}/shared/badge/badge.component.css`]: ".badge { color: blue; }\n",
  [`${APP_DIR}/shared/signal-card/signal-card.component.ts`]: `import { booleanAttribute, Component, input } from "@angular/core";

@Component({
  selector: "app-signal-card",
  template: \`<article [class.compact]="compact()">
  <h2>{{ title() }}</h2>
</article>\`
})
export class SignalCardComponent {
  title = input.required<string>();
  compact = input(false, { transform: booleanAttribute });
}
`,
  [`${APP_DIR}/shared/legacy-chip/legacy-chip.component.ts`]: `import { Component, Input } from "@angular/core";

@Component({
  selector: "app-legacy-chip",
  standalone: false,
  templateUrl: "./legacy-chip.component.html"
})
export class LegacyChipComponent {
  @Input() text = "";
}
`,
  [`${APP_DIR}/shared/legacy-chip/legacy-chip.component.html`]: '<span class="chip">{{ text }}</span>\n',
  [`${APP_DIR}/shared/legacy-chip/legacy-chip.module.ts`]: `import { NgModule } from "@angular/core";
import { CommonModule } from "@angular/common";
import { LegacyChipComponent } from "./legacy-chip.component";

@NgModule({ declarations: [LegacyChipComponent], imports: [CommonModule], exports: [LegacyChipComponent] })
export class LegacyChipModule {}
`,
  [`${APP_DIR}/shared/pipes/money.pipe.ts`]: `import { Pipe, PipeTransform } from "@angular/core";

@Pipe({ name: "money" })
export class MoneyPipe implements PipeTransform {
  transform(value: number): string {
    return "$" + value.toFixed(2);
  }
}
`,
  [`${APP_DIR}/shared/directives/highlight.directive.ts`]: `import { Directive } from "@angular/core";

@Directive({ selector: "[appHighlight]", host: { class: "highlight" } })
export class HighlightDirective {}
`,
  [`${APP_DIR}/styles/_variables.scss`]: "$gap: 8px;\n",
  [`${APP_DIR}/orders/orders.service.ts`]: `import { HttpClient } from "@angular/common/http";
import { inject, Injectable } from "@angular/core";
import { API_BASE_URL } from "../tokens";

export interface Order {
  id: number;
  status: string;
  total: number;
}

@Injectable({ providedIn: "root" })
export class OrdersService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  list() {
    return this.http.get<Order[]>(this.baseUrl + "/orders");
  }
}
`,
  [`${APP_DIR}/orders/order-list/order-list.component.ts`]: ORDER_LIST_TS,
  [`${APP_DIR}/orders/order-list/order-list.component.html`]: ORDER_LIST_HTML,
  [`${APP_DIR}/orders/order-list/order-list.component.scss`]:
    '@use "../../styles/variables" as v;\n.orders { gap: v.$gap; }\n',
  [`${APP_DIR}/orders/order-list/order-list.component.spec.ts`]: `import { TestBed } from "@angular/core/testing";
import { OrderListComponent } from "./order-list.component";

describe("OrderListComponent", () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OrderListComponent]
    }).compileComponents();
  });
});
`,
  [`${APP_DIR}/orders/order-summary.component.ts`]: `import { Component } from "@angular/core";
import { LegacyChipModule } from "../shared/legacy-chip/legacy-chip.module";

@Component({
  selector: "app-order-summary",
  imports: [LegacyChipModule],
  template: \`<div class="summary"><app-legacy-chip text="Paid" /></div>\`
})
export class OrderSummaryComponent {}
`,
  [`${APP_DIR}/notifications/poller.service.ts`]: `import { Injectable } from "@angular/core";
import { interval } from "rxjs";

@Injectable({ providedIn: "root" })
export class PollerService {
  private count = 0;
  constructor() {
    interval(30000).subscribe(() => this.count++);
  }
  current(): number {
    return this.count;
  }
}
`,
  [`${APP_DIR}/notifications/notification-bell.component.ts`]: `import { Component, inject } from "@angular/core";
import { PollerService } from "./poller.service";

@Component({ selector: "app-notification-bell", template: "<button>{{ poller.current() }}</button>" })
export class NotificationBellComponent {
  readonly poller = inject(PollerService);
}
`
};

/** Repository fields of the fixture app (15 §5.2.1). */
export const ANGULAR_REPO: Partial<PipelineContext["repository"]> = {
  framework: "angular",
  appRoot: APP,
  angularProject: "web",
  angularBuildConfiguration: "development",
  tsconfigPath: `${APP}/tsconfig.app.json`,
  entryFilePath: `${SRC}/main.ts`,
  globalStylePaths: [`/${SRC}/styles.css`]
};

/** `MAIN_FILES` with `changes` applied (`null` deletes a file). */
export function withChanges(changes: Record<string, string | null>, base: FileMap = MAIN_FILES): FileMap {
  const merged = new Map(Object.entries(base));
  for (const [file, content] of Object.entries(changes)) {
    if (content === null) {
      merged.delete(file);
    } else {
      merged.set(file, content);
    }
  }
  return Object.fromEntries(merged);
}

export interface AngularRunOptions {
  entries?: GitNameStatusEntry[];
  persistence?: StubPersistence;
  repo?: Partial<PipelineContext["repository"]>;
  tweak?: (ctx: TestContext) => void;
}

/** Runs `AngularChangeAnalysisService` over two file maps in temp worktrees (removed after the test). */
export async function analyzeAngular(
  t: NodeTestContext,
  base: FileMap,
  head: FileMap,
  options: AngularRunOptions = {}
): Promise<{ result: ChangeAnalysisResult; ctx: TestContext; persistence: StubPersistence }> {
  const wt = await makeWorktrees({ base, head });
  t.after(() => wt.cleanup());
  const persistence = options.persistence ?? stubPersistence();
  const ctx = makeContext({ baseDir: wt.baseDir, headDir: wt.headDir }, { ...ANGULAR_REPO, ...options.repo });
  options.tweak?.(ctx);
  const service = new AngularChangeAnalysisService({
    gitClient: stubGitClient(options.entries ?? diffEntries(base, head)),
    ...persistence
  });
  const result = await service.analyze(ctx);
  return { result, ctx, persistence };
}

/** `[rank, displayName, changeKind, reason]` of every rendered candidate. */
export function rows(result: ChangeAnalysisResult): Array<[number, string, string, string]> {
  return result.candidates.map((c) => [c.rank, c.displayName, c.changeKind, c.reason]);
}
