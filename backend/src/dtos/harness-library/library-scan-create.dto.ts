import { Type } from "class-transformer";
import { IsIn, IsInt, IsNumber, IsOptional, Max, Min, ValidateIf } from "class-validator";
import {
  LIBRARY_SPEND_CAP_MAX_USD,
  LIBRARY_SPEND_CAP_MIN_USD,
  STATE_ALLOWANCE_MAX,
  STATE_ALLOWANCE_MIN
} from "../../config-consts";

/** POST /api/repositories/:id/library/scans (16 §14.3 LibraryScanCreateRequest). */
export class LibraryScanCreateDTO {
  /** "scan" writes what is missing (also Continue scan); "rescan" rewrites every component (E15). */
  @IsIn(["scan", "rescan"])
  kind!: "scan" | "rescan";

  /** Spending cap in USD (2 decimals); null or absent = no cap. */
  @ValidateIf((dto: LibraryScanCreateDTO) => dto.spendCapUsd !== null && dto.spendCapUsd !== undefined)
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(LIBRARY_SPEND_CAP_MIN_USD)
  @Max(LIBRARY_SPEND_CAP_MAX_USD)
  spendCapUsd?: number | null;

  /** New state allowance of the repository, applied before the job starts (same rules as PATCH). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(STATE_ALLOWANCE_MIN)
  @Max(STATE_ALLOWANCE_MAX)
  stateAllowance?: number;
}
