/**
 * Display formatting for linked values. Locale-aware so a French translation
 * branch can show "1 200 000,00 €" where the English original shows
 * "€1,200,000.00".
 */

export interface ValueFormat {
  /** 'raw' passes the stored cell value through untouched. */
  style: 'raw' | 'number' | 'currency' | 'percent';
  locale?: string; // e.g. 'fr-FR', 'en-US'
  currency?: string; // e.g. 'EUR' — required when style is 'currency'
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
    options.style = 'currency';
    options.currency = format.currency ?? 'EUR';
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
