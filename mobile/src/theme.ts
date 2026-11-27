export const colors = {
  bg: '#f6f7f9',
  surface: '#ffffff',
  ink: '#1f2023',
  muted: '#5f6368',
  accent: '#1a73e8',
  accentInk: '#ffffff',
  accentSoft: '#e8f0fe',
  border: '#e3e5e8',
  danger: '#c5221f',
  dangerSoft: '#fce8e6',
  success: '#137333',
  successSoft: '#e6f4ea',
} as const;

export const radius = { sm: 10, md: 14, lg: 20, pill: 999 } as const;
export const space = (n: number): number => n * 4;
