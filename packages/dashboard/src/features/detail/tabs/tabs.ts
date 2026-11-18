export type Tab = 'headers' | 'body' | 'sql' | 'cache' | 'logs';

export const TABS: Array<[Tab, string]> = [
  ['headers', 'Headers'],
  ['body', 'Body'],
  ['sql', 'SQL'],
  ['cache', 'Cache'],
  ['logs', 'Logs'],
];
