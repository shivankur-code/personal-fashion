import { describe, expect, it } from 'vitest';
import { planModels } from '../src/index.js';

describe('model choices', () => {
  it('defaults to free vision models with fallbacks', () => {
    const c = planModels({});
    expect(c.model.endsWith(':free')).toBe(true);
    expect(c.fallbackModels.length).toBeGreaterThanOrEqual(1);
  });
  it('can be overridden by an environment variable', () => {
    expect(planModels({ LLM_MODELS_PLAN: 'anthropic/claude-haiku-5.5, x/y:free' }))
      .toEqual({ model: 'anthropic/claude-haiku-5.5', fallbackModels: ['x/y:free'] });
  });
});
