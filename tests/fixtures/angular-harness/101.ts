import { definePrvisionHarness } from '../harness-api';
import { NotificationItemComponent } from '../../src/app/modules/notifications/notification-item/notification-item.component';
import { NotificationService, type Notification } from '../../src/app/services/notification.service';

// Prototype-backed fake: keeps the real pure helpers (getTypeIcon/getTypeColor/getRelativeTime) without running
// the constructor, which would start a 30 s polling interval against the API.
const notificationServiceFake: Partial<NotificationService> = Object.create(NotificationService.prototype);

const notification: Notification = {
  notification_id: 'n-1',
  tenant_id: 't-1',
  user_id: 'u-1',
  title: 'Transfer request from Jane Smith',
  message: 'Jane Smith asked to move to the Westlake branch. Review the request before Friday.',
  notification_type: 'transfer_request',
  is_read: false,
  created_at: '2025-01-15T08:30:00.000Z',
  priority: 'high',
  action_url: '/app/transfers/42',
};

export default definePrvisionHarness({
  component: NotificationItemComponent,
  inputs: { notification, showActions: true, compact: false },
  providers: [{ provide: NotificationService, useValue: notificationServiceFake }],
  hostStyle: { width: '560px' },
  setup: () => {
    document.documentElement.setAttribute('data-ui-shell', 'modern');
    document.documentElement.setAttribute('data-ui-font', 'default');
  },
});
