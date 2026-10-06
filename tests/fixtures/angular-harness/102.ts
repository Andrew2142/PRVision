import { HttpHeaders } from '@angular/common/http';
import { definePrvisionHarness } from '../harness-api';
import { RankHistoryComponent } from '../../src/app/modules/member-ranks/rank-history/rank-history.component';
import { API_AUTH_BRIDGE } from '../../src/app/services/api-auth-bridge';
import { NotificationService } from '../../src/app/shared/services/notification.service';

export default definePrvisionHarness({
  component: RankHistoryComponent,
  inputs: { memberId: 'm-1' },
  providers: [
    { provide: API_AUTH_BRIDGE, useValue: { getAuthHeaders: () => new HttpHeaders(), getRegionalApiUrl: () => 'https://api.prvision.invalid/v1' } },
    { provide: NotificationService, useValue: { showError: () => undefined, showSuccess: () => undefined } },
  ],
  http: [{
    method: 'GET', url: '/members/m-1/rank-history',
    body: { success: true, data: [
      { member_id: 'm-1', member_rank_id: 'r-2', assigned_date: '2024-11-02T09:00:00Z', is_active: true, rank_name: 'Senior Member' },
      { member_id: 'm-1', member_rank_id: 'r-1', assigned_date: '2023-03-14T09:00:00Z', removed_date: '2024-11-02T09:00:00Z', is_active: false, rank_name: 'Member' },
    ] },
  }],
  hostStyle: { width: '640px' },
  setup: () => { document.documentElement.setAttribute('data-ui-shell', 'modern'); },
});
