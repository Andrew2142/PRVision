import { Component } from '@angular/core';
import { definePrvisionHarness } from '../harness-api';
import { SignalCardComponent } from '../proto-fixtures/signal-card.component';
@Component({ selector: 'prv-host-107', imports: [SignalCardComponent], template: '<signal-card [titel]="x" /><unknown-el></unknown-el>' })
class Host107 { x = 'typo'; }
export default definePrvisionHarness({ component: Host107 });
