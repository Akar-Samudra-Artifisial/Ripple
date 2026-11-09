import { describe, expect, it } from 'vitest';
import { valueLabel } from '../src/core/valueLabel';

describe('valueLabel', () => {
  it('adds the unit only when the value does not already say it', () => {
    expect(valueLabel('30 days after the trip ends', 'days')).toBe('30 days after the trip ends');
    expect(valueLabel('30 Days', 'days')).toBe('30 Days');
    expect(valueLabel('45', 'days')).toBe('45 days');
    expect(valueLabel('$60', 'USD')).toBe('$60 USD');
    expect(valueLabel('60', ' USD ')).toBe('60 USD');
    expect(valueLabel('economy class', null)).toBe('economy class');
    expect(valueLabel('$60', '')).toBe('$60');
  });
});
