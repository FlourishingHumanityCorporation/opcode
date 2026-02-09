import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  getStatusIndicator,
  renderTabStatusMarker,
} from '@/components/tabStatusIndicator';

describe('tabStatusIndicator', () => {
  it('maps workspace statuses to semantic indicators', () => {
    expect(getStatusIndicator('running')).toEqual({
      kind: 'running',
      label: 'In progress',
    });
    expect(getStatusIndicator('attention')).toEqual({
      kind: 'needs_response',
      label: 'Needs response',
    });
    expect(getStatusIndicator('complete')).toEqual({
      kind: 'needs_check',
      label: 'Needs check',
    });
    expect(getStatusIndicator('error')).toEqual({
      kind: 'error',
      label: 'Error',
    });
    expect(getStatusIndicator('idle')).toBeNull();
    expect(getStatusIndicator('active')).toBeNull();
  });

  it('renders running marker with spin animation', () => {
    const indicator = getStatusIndicator('running');
    if (!indicator) {
      throw new Error('Expected running indicator');
    }

    const html = renderToStaticMarkup(renderTabStatusMarker(indicator));
    expect(html).toContain('aria-label="In progress"');
    expect(html).toContain('animate-spin');
  });

  it('renders question mark and blue check markers with expected labels', () => {
    const needsResponse = getStatusIndicator('attention');
    const needsCheck = getStatusIndicator('complete');
    if (!needsResponse || !needsCheck) {
      throw new Error('Expected non-null indicators');
    }

    const responseHtml = renderToStaticMarkup(renderTabStatusMarker(needsResponse));
    const checkHtml = renderToStaticMarkup(renderTabStatusMarker(needsCheck));

    expect(responseHtml).toContain('aria-label="Needs response"');
    expect(responseHtml).toContain('?');
    expect(checkHtml).toContain('aria-label="Needs check"');
    expect(checkHtml).toContain('bg-sky-500');
  });
});
