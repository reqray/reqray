import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

/** The panel's theme, stamped onto the document so the stylesheets see it. */
export function useTheme(): [Theme, (next: Theme) => void] {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
  }, [theme]);

  return [theme, setTheme];
}
