import { importProvidersFrom } from '@angular/core';
import { definePrvisionHarness } from '../harness-api';
import { LegacyBadgeComponent, LegacyBadgeModule } from '../proto-fixtures/legacy-badge.module';

export default definePrvisionHarness({
  component: LegacyBadgeComponent,               // declared in an NgModule (standalone: false)
  inputs: { text: 'overdue', tone: 'bad' },
  providers: [importProvidersFrom(LegacyBadgeModule)],
});
