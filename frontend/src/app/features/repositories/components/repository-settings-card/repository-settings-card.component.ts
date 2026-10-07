import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { finalize } from 'rxjs';
import { STATE_ALLOWANCE_OPTIONS } from '../../../../core/constants/ui.constants';
import { type RepositoryView } from '../../../../core/models/repository.model';
import { ApiService } from '../../../../core/services/api.service';
import { plural } from '../../../../core/utils/library-format.util';

/** Info line after saving (16 §15.4, D4): what the new allowance changes. */
export function allowanceSavedText(repository: Pick<RepositoryView, 'libraryBuildMode' | 'stateAllowance'>): string {
  const states = plural(repository.stateAllowance, 'state');
  return repository.libraryBuildMode === 'scan'
    ? `Rescan from the Harness library card to rewrite every harness with ${states}.`
    : `New harnesses use ${states} from now on.`;
}

/** Repository settings card (16 §15.4): states per component, saved with PATCH /api/repositories/:id. */
@Component({
  selector: 'app-repository-settings-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatCardModule, MatFormFieldModule, MatProgressSpinnerModule, MatSelectModule],
  host: { class: 'block' },
  templateUrl: './repository-settings-card.component.html',
})
export class RepositorySettingsCardComponent {
  readonly repository = input.required<RepositoryView>();
  readonly saved = output<RepositoryView>();
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly options = STATE_ALLOWANCE_OPTIONS;
  /** The picked value; follows the repository whenever it changes. */
  protected readonly allowance = linkedSignal(() => this.repository().stateAllowance);
  protected readonly changed = computed(() => this.allowance() !== this.repository().stateAllowance);
  protected readonly saving = signal(false);
  protected readonly savedText = signal<string | null>(null);

  protected save(): void {
    if (!this.changed() || this.saving()) return;
    this.saving.set(true);
    this.savedText.set(null);
    this.api
      .updateRepository(this.repository().id, { stateAllowance: this.allowance() }) // not silent: errors are toasted
      .pipe(
        finalize(() => {
          this.saving.set(false);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (updated) => {
          this.savedText.set(allowanceSavedText(updated));
          this.saved.emit(updated);
        },
        error: () => undefined,
      });
  }
}
