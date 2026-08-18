import { assocItemEntriesDefaultIndex } from './associate-item-entries-index';

describe('assocItemEntriesDefaultIndex', () => {
  it('should default an explicit `null` index to the 1-based array position', () => {
    expect(assocItemEntriesDefaultIndex([{ index: null, itemId: 100 }])).toEqual(
      [{ index: 1, itemId: 100 }],
    );
  });

  it('should default an own `undefined` index property to the 1-based array position', () => {
    expect(
      assocItemEntriesDefaultIndex([{ index: undefined, itemId: 300 }]),
    ).toEqual([{ index: 1, itemId: 300 }]);
  });

  it('should default an absent index key to the 1-based array position', () => {
    expect(assocItemEntriesDefaultIndex([{ itemId: 200 }])).toEqual([
      { index: 1, itemId: 200 },
    ]);
  });

  it('should preserve an explicit numeric index, including zero', () => {
    expect(
      assocItemEntriesDefaultIndex([
        { index: 5, itemId: 100 },
        { index: 0, itemId: 200 },
      ]),
    ).toEqual([
      { index: 5, itemId: 100 },
      { index: 0, itemId: 200 },
    ]);
  });

  it('should assign defaults following the array position and preserve other fields', () => {
    expect(
      assocItemEntriesDefaultIndex([
        { index: null, itemId: 100 },
        { itemId: 200, quantity: 2 },
        { index: 9, itemId: 300 },
        { index: undefined, itemId: 400 },
      ]),
    ).toEqual([
      { index: 1, itemId: 100 },
      { index: 2, itemId: 200, quantity: 2 },
      { index: 9, itemId: 300 },
      { index: 4, itemId: 400 },
    ]);
  });

  it('should return an empty array for empty entries', () => {
    expect(assocItemEntriesDefaultIndex([])).toEqual([]);
  });
});
