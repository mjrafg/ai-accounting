import * as _ from 'lodash';

/**
 * Determines whether the given value is "blank".
 *
 * Part of the server's collection of small standalone helpers in `src/utils/`,
 * where each file exposes a single focused utility.
 *
 * A value is considered blank when it is an empty string, empty array, or
 * empty object, as well as `null`, `undefined`, or `NaN`. Numbers (including
 * `0`) are never blank.
 *
 * @example
 * isBlank('');        // true
 * isBlank(null);      // true
 * isBlank(NaN);       // true
 * isBlank(0);         // false
 * isBlank('hello');   // false
 */
export const isBlank = (value) => {
  return (_.isEmpty(value) && !_.isNumber(value)) || _.isNaN(value);
};
