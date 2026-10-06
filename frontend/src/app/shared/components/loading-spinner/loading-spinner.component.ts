import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

@Component({
  selector: 'app-loading-spinner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatProgressSpinnerModule],
  template: `
    <div role="status" class="flex items-center justify-center" [class.py-12]="!inline()">
      <mat-spinner [diameter]="diameter()" [attr.aria-label]="label()" />
      <span class="sr-only">{{ label() }}</span>
    </div>
  `,
})
export class LoadingSpinnerComponent {
  readonly diameter = input(48);
  readonly label = input('Loading');
  readonly inline = input(false);
}
