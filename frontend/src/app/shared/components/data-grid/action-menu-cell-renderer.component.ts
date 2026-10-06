import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { type ICellRendererAngularComp } from 'ag-grid-angular';
import { type ICellRendererParams } from 'ag-grid-community';

export interface ActionMenuItem {
  action: string;
  label: string;
  icon: string;
  tone?: 'neutral' | 'primary' | 'danger';
  disabled?: boolean;
}

export type ActionMenuCellRendererParams = ICellRendererParams & {
  actions?: ActionMenuItem[] | ((row: unknown) => ActionMenuItem[]);
  onAction?: (action: string, row: unknown) => void;
};

/** Row "more" menu for ag-grid cells. `items` is a signal so `refresh()` re-renders under OnPush. */
@Component({
  selector: 'app-action-menu-cell-renderer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule],
  template: `
    <button
      mat-icon-button
      type="button"
      class="dd-grid-menu-trigger"
      aria-label="More actions"
      matTooltip="More actions"
      [matMenuTriggerFor]="actionMenu"
      (click)="stopPropagation($event)"
    >
      <mat-icon aria-hidden="true">more_vert</mat-icon>
    </button>

    <mat-menu #actionMenu="matMenu" xPosition="before">
      @for (item of items(); track item.action) {
        <button
          mat-menu-item
          type="button"
          [disabled]="item.disabled"
          [class.dd-menu-danger]="item.tone === 'danger'"
          (click)="handleAction($event, item.action)"
        >
          <mat-icon aria-hidden="true">{{ item.icon }}</mat-icon>
          <span>{{ item.label }}</span>
        </button>
      }
    </mat-menu>
  `,
})
export class ActionMenuCellRendererComponent implements ICellRendererAngularComp {
  protected readonly items = signal<ActionMenuItem[]>([]);
  private params?: ActionMenuCellRendererParams;

  agInit(params: ActionMenuCellRendererParams): void {
    this.params = params;
    this.items.set(this.resolveItems(params));
  }

  refresh(params: ActionMenuCellRendererParams): boolean {
    this.params = params;
    this.items.set(this.resolveItems(params));
    return true;
  }

  protected stopPropagation(event: Event): void {
    event.stopPropagation();
  }

  handleAction(event: MouseEvent, action: string): void {
    event.stopPropagation();
    this.params?.onAction?.(action, this.params.data);
  }

  private resolveItems(params: ActionMenuCellRendererParams): ActionMenuItem[] {
    if (typeof params.actions === 'function') {
      return params.actions(params.data);
    }

    return params.actions ?? [];
  }
}
