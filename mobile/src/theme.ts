/**
 * Lumora design tokens for React Native.
 * Film-first surfaces and warm, readable text. Keep these export keys stable:
 * the native player and account screens share this contract.
 */
export const colors = {
  base: '#0d0e0f',
  surface: '#161718',
  surfaceRaised: '#202122',
  surfaceOverlay: '#292a2b',
  border: '#313232',
  borderStrong: '#51514f',
  content: '#f5f1e8',
  contentMuted: '#b7b3ac',
  contentSubtle: '#97958f',
  primary: '#e11d48',
  primaryContrast: '#ffffff',
  success: '#a1c4a8',
  warning: '#e7be76',
  danger: '#e8938a',
  info: '#a5bccd',
} as const;

export const spacing = (n: number) => n * 4;

export const radius = { sm: 6, md: 10, lg: 20, pill: 999 } as const;

export const type = {
  h1: { fontSize: 32, lineHeight: 40, letterSpacing: -0.8, fontWeight: '700' as const },
  h2: { fontSize: 22, lineHeight: 30, letterSpacing: -0.4, fontWeight: '600' as const },
  h3: { fontSize: 16, lineHeight: 24, fontWeight: '600' as const },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' as const },
  small: { fontSize: 14, lineHeight: 20, fontWeight: '400' as const },
  tiny: { fontSize: 12, lineHeight: 18, fontWeight: '500' as const },
} as const;
