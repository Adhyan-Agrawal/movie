import { describe, expect, it } from 'vitest';
import { getImageProps } from 'next/image';

describe('Next image delivery', () => {
  it('globally disables the optimizer so browser image requests keep their external URL', async () => {
    const { default: config } = await import('../../next.config.mjs');
    expect(config.images?.unoptimized).toBe(true);
    expect(config.images?.remotePatterns).toContainEqual({ protocol: 'https', hostname: 'image.tmdb.org' });
    expect(JSON.stringify(config.images)).not.toContain('/_next/image');
    expect(JSON.stringify(config.images)).not.toContain('/cdn-cgi/image');
  });

  it('emits the TMDB origin URL rather than an optimizer src or srcset', () => {
    const src = 'https://image.tmdb.org/t/p/w500/fixture.jpg';
    const { props } = getImageProps({ src, alt: 'Fixture poster', width: 500, height: 750, unoptimized: true });
    expect(props.src).toBe(src);
    expect(props.srcSet).toBeUndefined();
    expect(props.src).not.toContain('/_next/image');
    expect(props.src).not.toContain('/cdn-cgi/image');
  });
});
