/**
 * Characterization (regression lock) spec for `formatNumber`.
 *
 * Every expectation below was captured by executing the real implementation
 * against its real dependencies (`accounting`, `js-money`, `lodash`) — nothing
 * here is mocked or stubbed. The purpose is to document what this money
 * formatting path returns TODAY so that any drift fails loudly.
 *
 * This is NOT a specification of correct accounting behaviour. Some assertions
 * deliberately lock in behaviour that is arguably wrong (see the comments
 * marked HAZARD); they are recorded, not repaired.
 */
import { formatNumber } from './format-number';

describe('formatNumber (characterization)', () => {
  describe('default settings', () => {
    it('formats a positive decimal with a thousands separator and 2 decimals', () => {
      expect(formatNumber(1234.5, {})).toBe('$1,234.50');
    });

    it("formats a negative value with the default 'mines' format", () => {
      expect(formatNumber(-1234.5, {})).toBe('-$1,234.50');
    });

    it('renders the negative as a bare "-" prefixed to the positive rendering', () => {
      expect(formatNumber(-1234.5, {})).toBe('-' + formatNumber(1234.5, {}));
    });

    it('formats zero as a fully rendered zero amount', () => {
      expect(formatNumber(0, {})).toBe('$0.00');
    });

    it('rounds to the default precision of 2 decimals', () => {
      expect(formatNumber(1234.567, {})).toBe('$1,234.57');
      expect(formatNumber(1234.564, {})).toBe('$1,234.56');
    });
  });

  describe('currency / symbol options', () => {
    it('resolves the currency symbol from the currencyCode option', () => {
      expect(formatNumber(1234.5, { currencyCode: 'USD' })).toBe('$1,234.50');
      expect(formatNumber(1234.5, { currencyCode: 'EUR' })).toBe('€1,234.50');
      expect(formatNumber(1234.5, { currencyCode: 'GBP' })).toBe('£1,234.50');
      expect(formatNumber(1234.5, { currencyCode: 'JPY' })).toBe('¥1,234.50');
    });

    // HAZARD: with no currencyCode the js-money lookup yields `undefined`, so
    // `accounting` falls back to its own library default symbol ("$"). A dollar
    // sign therefore appears even though no currency was ever requested — and an
    // unrecognised code degrades to the same silent dollar default.
    it('falls back to the accounting default symbol when the code is missing or unknown', () => {
      expect(formatNumber(1234.5, {})).toBe('$1,234.50');
      expect(formatNumber(1234.5, { currencyCode: 'NOT_A_CODE' })).toBe(
        '$1,234.50',
      );
    });

    it('honours the explicit `symbol` only when `money` is false', () => {
      expect(formatNumber(1234.5, { money: false, symbol: '#' })).toBe(
        '#1,234.50',
      );
      expect(formatNumber(1234.5, { money: false })).toBe('1,234.50');
      // `symbol` is ignored while `money` is true — the currency sign wins.
      expect(formatNumber(1234.5, { money: true, symbol: '#' })).toBe(
        '$1,234.50',
      );
    });

    it('respects custom thousand and decimal separators', () => {
      expect(
        formatNumber(1234.5, {
          currencyCode: 'USD',
          thousand: '.',
          decimal: ',',
        }),
      ).toBe('$1.234,50');
    });
  });

  describe('negativeFormat option', () => {
    it("wraps in parentheses and emits no '-' when negativeFormat is 'parentheses'", () => {
      const formatted = formatNumber(-1234.5, {
        negativeFormat: 'parentheses',
        currencyCode: 'USD',
      });

      expect(formatted).toBe('($1,234.50)');
      expect(formatted.includes('-')).toBe(false);
    });

    // HAZARD: any unrecognised negativeFormat resolves to `undefined`, which
    // `accounting` then dereferences — a bad setting throws at format time
    // instead of falling back to a sane default.
    it('throws for an unrecognised negativeFormat on a negative value', () => {
      expect(() =>
        formatNumber(-1234.5, {
          negativeFormat: 'unsupported',
          currencyCode: 'USD',
        }),
      ).toThrow();
    });
  });

  describe('excerptZero option', () => {
    it('replaces the entire zero rendering with zeroSign', () => {
      const formatted = formatNumber(0, { excerptZero: true, zeroSign: '-' });

      expect(formatted).toBe('-');
      expect(/[0-9]/.test(formatted)).toBe(false);
    });

    it('renders an empty string when excerptZero is on and no zeroSign is given', () => {
      expect(formatNumber(0, { excerptZero: true })).toBe('');
    });

    it('leaves non-zero values untouched while excerptZero is on', () => {
      expect(
        formatNumber(1234.5, {
          excerptZero: true,
          zeroSign: '-',
          currencyCode: 'USD',
        }),
      ).toBe('$1,234.50');
    });
  });

  describe('coercion and scaling', () => {
    it('coerces a numeric string input via parseFloat', () => {
      expect(formatNumber('1234.5', { currencyCode: 'USD' })).toBe('$1,234.50');
    });

    // HAZARD: parseFloat('abc') is NaN, and `accounting` silently formats that
    // as a zero amount. A non-numeric value therefore reads as a real $0.00
    // balance rather than throwing or surfacing 'NaN'.
    it('renders a non-numeric input as a zero amount', () => {
      expect(formatNumber('abc', { currencyCode: 'USD' })).toBe('$0.00');
    });

    it('divides by exactly 1000 when divideOn1000 is true', () => {
      expect(
        formatNumber(1234567, { divideOn1000: true, currencyCode: 'USD' }),
      ).toBe('$1,234.57');
    });

    it('drops the decimal separator entirely at precision 0', () => {
      expect(
        formatNumber(1234.56, { precision: 0, currencyCode: 'USD' }),
      ).toBe('$1,235');
    });
  });
});
