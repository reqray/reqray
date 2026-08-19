import { describe, expect, it } from 'vitest';
import { isTypingTarget, nextIndex, scrollTopFor } from '../src/keyboard';

describe('keyboard helpers', () => {
  describe('shortcuts stay out of the way while typing', () => {
    // The rule that matters: `j` in the filter field is the letter j.
    // Elements are stand-ins for the shape the browser hands the handler;
    // the real thing is exercised by the browser test.
    const element = (tagName: string, extra: object = {}) =>
      ({ tagName, ...extra }) as unknown as EventTarget;

    it.each(['INPUT', 'TEXTAREA', 'SELECT'])('%s takes the key', (tag) => {
      expect(isTypingTarget(element(tag))).toBe(true);
    });

    it('a contenteditable element takes the key', () => {
      expect(isTypingTarget(element('DIV', { isContentEditable: true }))).toBe(true);
    });

    it('an ordinary element does not', () => {
      expect(isTypingTarget(element('BODY'))).toBe(false);
      expect(isTypingTarget(element('BUTTON'))).toBe(false);
      expect(isTypingTarget(null)).toBe(false);
    });
  });

  describe('selection stepping', () => {
    it('clamps instead of wrapping', () => {
      expect(nextIndex(0, -1, 5)).toBe(0);
      expect(nextIndex(4, 1, 5)).toBe(4);
    });

    it('starts at the near end when nothing is selected', () => {
      expect(nextIndex(-1, 1, 5)).toBe(0);
      expect(nextIndex(-1, -1, 5)).toBe(4);
    });

    it('has nothing to select in an empty list', () => {
      expect(nextIndex(-1, 1, 0)).toBe(-1);
    });
  });

  describe('scrolling only when the row would leave the viewport', () => {
    const view = { scrollTop: 100, viewportHeight: 200, rowHeight: 40 };

    it('leaves a visible row alone', () => {
      expect(scrollTopFor({ ...view, index: 4 })).toBeNull();
    });

    it('scrolls up by exactly the shortfall', () => {
      expect(scrollTopFor({ ...view, index: 2 })).toBe(80);
    });

    it('scrolls down by exactly the overshoot', () => {
      expect(scrollTopFor({ ...view, index: 8 })).toBe(160);
    });

    it('ignores a selection that does not exist', () => {
      expect(scrollTopFor({ ...view, index: -1 })).toBeNull();
    });
  });
});
