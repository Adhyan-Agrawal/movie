/**
 * Lumora design tokens for React Native.
 * Mirrors the web app's dark palette (src/styles/globals.css) so the native
 * app reads as the same product: near-black base, layered surfaces, a single
 * violet accent, and the same semantic success/warning/danger tones.
 */
export const colors = {
  base: '#08090c',
  surface: '#0e1015',
  surfaceRaised: '#151823',
  surfaceOverlay: '#1c2030',
  border: '#232838',
  borderStrong: '#333a52',
  content: '#f4f5f8',
  contentMuted: '#a2a8ba',
  contentSubtle: '#6b7185',
  primary: '#7c5cff',
  primaryContrast: '#ffffff',
  success: '#39d98a',
  warning: '#f5a524',
  danger: '#ff5c5c',
  info: '#4aa8ff',
} as const;

export const spacing = (n: number) => n * 4;

export const radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const;

export const type = {
  h1: { fontSize: 28, fontWeight: '800' as const },
  h2: { fontSize: 20, fontWeight: '700' as const },
  h3: { fontSize: 16, fontWeight: '600' as const },
  body: { fontSize: 14, fontWeight: '400' as const },
  small: { fontSize: 12, fontWeight: '400' as const },
  tiny: { fontSize: 11, fontWeight: '500' as const },
} as const;
