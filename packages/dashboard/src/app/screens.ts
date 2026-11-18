import type { Screen } from './routing';

/**
 * The panel's destinations, in the order the tabs sit in.
 *
 * One list, read by the nav and by the command palette: a screen only one of
 * them knows about is a screen half the panel cannot reach.
 */
export const NAV_SCREENS: ReadonlyArray<{ screen: Screen; label: string }> = [
  { screen: 'requests', label: 'Requests' },
  { screen: 'routes', label: 'Routes' },
  { screen: 'findings', label: 'Findings' },
  { screen: 'history', label: 'History' },
  { screen: 'exceptions', label: 'Exceptions' },
  { screen: 'project', label: 'Project' },
];
