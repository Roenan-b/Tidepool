/** Appearance preference stored in the `tp_theme` cookie and read on the server to avoid a flash. */
export type Theme = 'system' | 'light' | 'dark';

export const THEME_COOKIE = 'tp_theme';

export function parseTheme(value: string | undefined | null): Theme {
  return value === 'light' || value === 'dark' ? value : 'system';
}
