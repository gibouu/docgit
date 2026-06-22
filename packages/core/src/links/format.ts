/**
 * Display formatting for linked values. Locale-aware so a French translation
 * branch can show "1 200 000,00 €" where the English original shows
 * "€1,200,000.00".
 */

export interface ValueFormat {
  /** 'raw' passes the stored cell value through untouched. */
  style: 'raw' | 'number' | 'currency' | 'percent';
  locale?: string; // e.g. 'fr-FR', 'en-US'
  currency?: string; // e.g. 'EUR' — REQUIRED when style is 'currency' (formatValue throws if omitted)
  /** Compact notation: 1.2M / 1,2 M. */
  compact?: boolean;
  decimals?: number;
}

export function formatValue(raw: string, format: ValueFormat): string {
  if (format.style === 'raw') return raw;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return raw; // non-numeric cells pass through

  const options: Intl.NumberFormatOptions = {};
  if (format.style === 'currency') {
    // Require an explicit currency rather than silently defaulting — a wrong
    // currency on a financial value is worse than a clear error.
    if (!format.currency) throw new Error('A currency code is required for currency formatting.');
    options.style = 'currency';
    options.currency = format.currency;
  } else if (format.style === 'percent') {
    options.style = 'percent';
  }
  if (format.compact) {
    options.notation = 'compact';
    options.compactDisplay = 'short';
  }
  if (format.decimals !== undefined) {
    options.minimumFractionDigits = format.decimals;
    options.maximumFractionDigits = format.decimals;
  }

  return new Intl.NumberFormat(format.locale ?? 'en-US', options).format(numeric);
}
