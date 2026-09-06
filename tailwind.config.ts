import type { Config } from 'tailwindcss';

/**
 * Lumora design tokens (Section 5: UI/UX Design Bible).
 * Dark cinematic base, restrained translucent surfaces, thin borders,
 * 4px spacing rhythm, small/medium/large semantic radii, explicit
 * success/warning/danger/info colors. Colors are exposed as CSS variables
 * (see globals.css) so admin theming can override them at runtime.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Base cinematic surfaces
        base: 'rgb(var(--color-base) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--color-surface) / <alpha-value>)',
          raised: 'rgb(var(--color-surface-raised) / <alpha-value>)',
          overlay: 'rgb(var(--color-surface-overlay) / <alpha-value>)',
        },
        border: {
          DEFAULT: 'rgb(var(--color-border) / <alpha-value>)',
          strong: 'rgb(var(--color-border-strong) / <alpha-value>)',
        },
        // Text
        content: {
          DEFAULT: 'rgb(var(--color-content) / <alpha-value>)',
          muted: 'rgb(var(--color-content-muted) / <alpha-value>)',
          subtle: 'rgb(var(--color-content-subtle) / <alpha-value>)',
        },
        // Brand accent
        primary: {
          DEFAULT: 'rgb(var(--color-primary) / <alpha-value>)',
          hover: 'rgb(var(--color-primary-hover) / <alpha-value>)',
          contrast: 'rgb(var(--color-primary-contrast) / <alpha-value>)',
        },
        // Semantic status
        success: 'rgb(var(--color-success) / <alpha-value>)',
        warning: 'rgb(var(--color-warning) / <alpha-value>)',
        danger: 'rgb(var(--color-danger) / <alpha-value>)',
        info: 'rgb(var(--color-info) / <alpha-value>)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
      },
      spacing: {
        // 4px rhythm helpers beyond Tailwind defaults
        '18': '4.5rem',
        '22': '5.5rem',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'var(--font-sans)', 'sans-serif'],
      },
      boxShadow: {
        soft: '0 1px 2px rgb(0 0 0 / 0.4), 0 8px 24px rgb(0 0 0 / 0.35)',
        raised: '0 2px 4px rgb(0 0 0 / 0.5), 0 16px 48px rgb(0 0 0 / 0.45)',
      },
      transitionTimingFunction: {
        deliberate: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 200ms var(--ease-deliberate, ease-out)',
        shimmer: 'shimmer 1.5s infinite',
      },
    },
  },
  plugins: [],
};

export default config;
