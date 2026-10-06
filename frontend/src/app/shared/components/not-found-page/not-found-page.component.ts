import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { RouterLink } from '@angular/router';

/** Routed for `**` and embeddable by detail screens when the API returns 404. */
@Component({
  selector: 'app-not-found-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatButtonModule, MatIconModule],
  host: { class: 'block' },
  template: `
    <section class="mx-auto flex max-w-xl flex-col items-center gap-5 py-16 text-center">
      <div
        class="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--shell-accent-soft)] text-[var(--shell-accent)]"
      >
        <mat-icon aria-hidden="true">travel_explore</mat-icon>
      </div>
      <h1 class="font-display text-3xl font-bold tracking-tight text-[var(--color-text-primary)]">{{ title() }}</h1>
      <p class="text-sm leading-6 text-[var(--color-text-secondary)]">{{ message() }}</p>
      <a mat-flat-button color="primary" class="!rounded-xl" [routerLink]="backLink()">{{ backLabel() }}</a>
    </section>
  `,
})
export class NotFoundPageComponent {
  // withComponentInputBinding() sets every input of a routed component, so on the `**` route these
  // receive `undefined`; the transforms restore the defaults.
  readonly title = input('Page not found', { transform: orDefault('Page not found') });
  readonly message = input("There's nothing at this address.", {
    transform: orDefault("There's nothing at this address."),
  });
  readonly backLink = input('/repositories', { transform: orDefault('/repositories') });
  readonly backLabel = input('Go to repositories', { transform: orDefault('Go to repositories') });
}

function orDefault(fallback: string): (value: string | undefined) => string {
  return (value) => value ?? fallback;
}
