import { Injectable, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { type RouterStateSnapshot, TitleStrategy } from '@angular/router';

/** Document titles read "Repositories · PRVision". */
@Injectable({ providedIn: 'root' })
export class PrvisionTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const page = this.buildTitle(snapshot);
    this.title.setTitle(page ? `${page} · PRVision` : 'PRVision');
  }
}

/** For detail pages that know a better name after loading (e.g. the visualization title). */
export function setPageTitle(title: Title, page: string): void {
  title.setTitle(`${page} · PRVision`);
}
