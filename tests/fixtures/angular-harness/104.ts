import { definePrvisionHarness } from '../harness-api';
import { SignalCardComponent } from '../proto-fixtures/signal-card.component';

export default definePrvisionHarness({
  component: SignalCardComponent,                // signal input(), input.required(), transform
  inputs: { title: 'Signal inputs', count: '21' },
  hostStyle: { width: '360px' },
});
