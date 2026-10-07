/**
 * AI cost from token usage and the published price table (16 §6.13, D13, E17). Pure.
 */
import { AI_MODEL_PRICES_USD_PER_MTOK, AI_PRICE_FALLBACK_MODEL } from "../../config-consts";
import type { AiUsage } from "../../types/visualization-pipeline";

/** Prices of one model in USD per million tokens. */
export interface ModelPrice {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  cacheReadUsdPerMTok: number;
  cacheWriteUsdPerMTok: number;
}

/** A price and whether it is the model's own (`exact`) or the fallback model's. */
export interface PriceLookup {
  price: ModelPrice;
  exact: boolean;
  priceModel: string;
}

/** Cost of a usage record, rounded to 4 decimals. */
export interface UsageCost {
  usd: number;
  exact: boolean;
  priceModel: string;
}

type PriceTableEntry = { input: number; output: number; cacheRead: number; cacheWrite: number };

const PRICE_TABLE: Readonly<Record<string, PriceTableEntry>> = AI_MODEL_PRICES_USD_PER_MTOK;
const TOKENS_PER_MTOK = 1_000_000;
const USD_DECIMALS = 4;

function toModelPrice(entry: PriceTableEntry): ModelPrice {
  return {
    inputUsdPerMTok: entry.input,
    outputUsdPerMTok: entry.output,
    cacheReadUsdPerMTok: entry.cacheRead,
    cacheWriteUsdPerMTok: entry.cacheWrite
  };
}

/**
 * Price of a model: exact match on the lower-cased model id; otherwise AI_PRICE_FALLBACK_MODEL with exact = false
 * (E17: unknown models are priced like the most expensive listed one, so caps stay conservative).
 *
 * @throws Error when the fallback model is missing from the table (config validation rejects that at boot).
 */
export function priceFor(model: string): PriceLookup {
  const key = model.trim().toLowerCase();
  const own = Object.prototype.hasOwnProperty.call(PRICE_TABLE, key) ? PRICE_TABLE[key] : undefined;
  if (own) {
    return { price: toModelPrice(own), exact: true, priceModel: key };
  }
  const fallback = PRICE_TABLE[AI_PRICE_FALLBACK_MODEL];
  if (!fallback) {
    throw new Error(`AI_PRICE_FALLBACK_MODEL "${AI_PRICE_FALLBACK_MODEL}" has no price`);
  }
  return { price: toModelPrice(fallback), exact: false, priceModel: AI_PRICE_FALLBACK_MODEL };
}

/**
 * Cost of a usage record in USD. `usage.inputTokens` already includes cache reads and writes (05's mapUsage), so:
 * uncached = max(0, inputTokens − cacheRead − cacheWrite) and
 * usd = (uncached·input + cacheRead·cacheRead$ + cacheWrite·cacheWrite$ + outputTokens·output$) / 1e6,
 * rounded to 4 decimals. Missing cache counts are 0.
 */
export function usageCostUsd(model: string, usage: AiUsage): UsageCost {
  const { price, exact, priceModel } = priceFor(model);
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheWrite = usage.cacheWriteInputTokens ?? 0;
  const uncached = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
  const raw =
    (uncached * price.inputUsdPerMTok +
      cacheRead * price.cacheReadUsdPerMTok +
      cacheWrite * price.cacheWriteUsdPerMTok +
      usage.outputTokens * price.outputUsdPerMTok) /
    TOKENS_PER_MTOK;
  return { usd: roundUsd(raw), exact, priceModel };
}

function roundUsd(value: number): number {
  const factor = 10 ** USD_DECIMALS;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
