// Previous-location stack behind the reader's back arrow.
//
// Every jump the reader makes on the user's behalf (a claim quote, a citation
// portal, a find hit, a typed page number) first remembers where the well was.
// The back arrow pops the newest entry and returns there, so a chain of jumps
// unwinds like undo. Pure data: no DOM, no timers, so it is testable under node.

/**
 * Create a bounded stack of `{page, top}` snapshots.
 *
 * @param {object} [options]
 * @param {number} [options.limit=80] Newest entries kept; the oldest is dropped past it.
 * @param {number} [options.nearPx=16] A snapshot on the same page within this many
 *   pixels of the newest entry is a repeat and is not stacked again.
 * Extra fields on a snapshot (such as a fractional page anchor) are kept as given.
 * @returns {{remember(snap: {page: number, top: number}): boolean, pop(): ({page: number, top: number}|undefined), readonly size: number}}
 */
export function createLocationHistory({ limit = 80, nearPx = 16 } = {}) {
  const stack = [];
  return {
    /** Push a snapshot; returns false when it was refused as invalid or as a repeat. */
    remember(snap) {
      if (!snap || !Number.isInteger(snap.page) || snap.page < 1) return false;
      const top = Number.isFinite(snap.top) ? snap.top : 0;
      const last = stack[stack.length - 1];
      if (last && last.page === snap.page && Math.abs(last.top - top) <= nearPx) return false;
      stack.push({ ...snap, page: snap.page, top });
      if (stack.length > limit) stack.shift();
      return true;
    },
    /** Remove and return the newest snapshot, or undefined when the stack is empty. */
    pop() {
      return stack.pop();
    },
    /** Number of remembered locations. */
    get size() {
      return stack.length;
    },
  };
}
