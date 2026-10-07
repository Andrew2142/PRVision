import { type ValidatorFn, Validators } from '@angular/forms';
import { LIBRARY_SPEND_CAP_MAX_USD, LIBRARY_SPEND_CAP_MIN_USD } from '../../core/constants/ui.constants';

/** At most two decimals (cents), as the API's `@IsNumber({ maxDecimalPlaces: 2 })`. */
const TWO_DECIMALS: ValidatorFn = (control) => {
  const value: unknown = control.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6 ? null : { decimals: true };
};

/** Validators of the scan spending cap input (16 §15.2 item 4); "required" is checked when No cap is off. */
export function spendCapValidators(): ValidatorFn[] {
  return [Validators.min(LIBRARY_SPEND_CAP_MIN_USD), Validators.max(LIBRARY_SPEND_CAP_MAX_USD), TWO_DECIMALS];
}
