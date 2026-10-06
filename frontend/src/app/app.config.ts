import { type ApplicationConfig, inject, provideAppInitializer, provideZoneChangeDetection } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { MAT_DIALOG_DEFAULT_OPTIONS } from '@angular/material/dialog';
import { MAT_FORM_FIELD_DEFAULT_OPTIONS } from '@angular/material/form-field';
import { MAT_TOOLTIP_DEFAULT_OPTIONS } from '@angular/material/tooltip';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { TitleStrategy, provideRouter, withComponentInputBinding, withRouterConfig } from '@angular/router';
import { routes } from './app.routes';
import { errorInterceptor } from './core/interceptors/error.interceptor';
import { PrvisionTitleStrategy } from './core/services/page-title.strategy';
import { ThemeService } from './core/services/theme.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withComponentInputBinding(), withRouterConfig({ paramsInheritanceStrategy: 'always' })),
    { provide: TitleStrategy, useClass: PrvisionTitleStrategy },
    provideHttpClient(withInterceptors([errorInterceptor])),
    provideAnimationsAsync(),
    provideAppInitializer(() => {
      inject(ThemeService).init();
    }),
    {
      provide: MAT_FORM_FIELD_DEFAULT_OPTIONS,
      // Same as Uply: fill avoids the MDC outline "leading rail".
      useValue: { appearance: 'fill', subscriptSizing: 'dynamic' },
    },
    { provide: MAT_TOOLTIP_DEFAULT_OPTIONS, useValue: { showDelay: 300, hideDelay: 0, touchendHideDelay: 1500 } },
    {
      provide: MAT_DIALOG_DEFAULT_OPTIONS,
      useValue: { autoFocus: 'first-tabbable', restoreFocus: true, hasBackdrop: true },
    },
  ],
};
