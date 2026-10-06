import { OverlayContainer } from '@angular/cdk/overlay';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import {
  type ActionMenuCellRendererParams,
  ActionMenuCellRendererComponent,
  type ActionMenuItem,
} from './action-menu-cell-renderer.component';

describe('ActionMenuCellRendererComponent', () => {
  let overlay: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ActionMenuCellRendererComponent],
      providers: [provideNoopAnimations()],
    }).compileComponents();
    overlay = TestBed.inject(OverlayContainer).getContainerElement();
  });

  function params(actions: ActionMenuItem[], onAction?: (action: string) => void): ActionMenuCellRendererParams {
    return { actions, onAction, data: { id: 1 } } as unknown as ActionMenuCellRendererParams;
  }

  function openMenu(host: HTMLElement): HTMLButtonElement[] {
    host.querySelector<HTMLButtonElement>('button.dd-grid-menu-trigger')?.click();
    return Array.from(overlay.querySelectorAll<HTMLButtonElement>('button[mat-menu-item]'));
  }

  it('refresh() with new actions re-renders menu items (OnPush)', async () => {
    const fixture = TestBed.createComponent(ActionMenuCellRendererComponent);
    fixture.componentInstance.agInit(params([{ action: 'open', label: 'Open', icon: 'open_in_new' }]));
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(openMenu(host).map((b) => b.querySelector('span')?.textContent?.trim())).toEqual(['Open']);
    overlay.querySelector<HTMLElement>('.cdk-overlay-backdrop')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const refreshed = fixture.componentInstance.refresh(
      params([
        { action: 'redetect', label: 'Re-detect', icon: 'refresh' },
        { action: 'remove', label: 'Remove', icon: 'delete', tone: 'danger' },
      ]),
    );
    expect(refreshed).toBeTrue();
    fixture.detectChanges();
    const labels = openMenu(host).map((b) => b.querySelector('span')?.textContent?.trim());
    expect(labels).toEqual(['Re-detect', 'Remove']);
  });

  it('danger item gets dd-menu-danger', () => {
    const onAction = jasmine.createSpy('onAction');
    const fixture = TestBed.createComponent(ActionMenuCellRendererComponent);
    fixture.componentInstance.agInit(
      params(
        [
          { action: 'open', label: 'Open', icon: 'open_in_new' },
          { action: 'remove', label: 'Remove', icon: 'delete', tone: 'danger' },
        ],
        onAction,
      ),
    );
    fixture.detectChanges();
    const items = openMenu(fixture.nativeElement as HTMLElement);
    expect(items[0]?.classList).not.toContain('dd-menu-danger');
    expect(items[1]?.classList).toContain('dd-menu-danger');
    items[1]?.click();
    expect(onAction).toHaveBeenCalledWith('remove', { id: 1 });
  });
});
