import { parseBoolean } from './parse-boolean';

describe('parseBoolean', () => {
  describe('numeric values', () => {
    it('should parse the number 1 as true', () => {
      expect(parseBoolean(1, false)).toBe(true);
      expect(parseBoolean(1, undefined)).toBe(true);
    });

    it('should parse the number 0 as false', () => {
      expect(parseBoolean(0, null)).toBe(false);
      expect(parseBoolean(0, undefined)).toBe(false);
    });
  });

  describe('string values', () => {
    it('should parse the truthy strings as true', () => {
      expect(parseBoolean('1', false)).toBe(true);
      expect(parseBoolean('true', false)).toBe(true);
      expect(parseBoolean('TRUE ', false)).toBe(true);
    });

    it('should parse the falsy strings as false', () => {
      expect(parseBoolean('0', true)).toBe(false);
      expect(parseBoolean('false', true)).toBe(false);
      expect(parseBoolean(' False ', true)).toBe(false);
    });
  });

  describe('boolean values', () => {
    it('should pass the given boolean through untouched', () => {
      expect(parseBoolean(true, false)).toBe(true);
      expect(parseBoolean(false, true)).toBe(false);
    });
  });

  describe('unparsable values', () => {
    const defaultValue = Symbol('default');

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['empty string', ''],
      ['whitespace string', '  '],
      ['unrecognized string', 'garbage'],
      ['out of range number', 2],
      ['negative number', -1],
      ['NaN', NaN],
      ['plain object', {}],
      ['empty array', []],
    ])('should return the given default value for %s', (_label, value) => {
      expect(parseBoolean(value, defaultValue)).toBe(defaultValue);
    });
  });
});
