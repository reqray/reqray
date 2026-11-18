/** Short badge for a detector; new detectors fall back to their id. */
export function badgeFor(detector: string): string {
  switch (detector) {
    case 'n_plus_one':
      return 'N+1';
    case 'sequential_http':
      return 'SEQ HTTP';
    case 'dup_http':
    case 'dup_cache':
      return 'DUP';
    case 'slow_budget':
      return 'SLOW';
    case 'slow_code':
      return 'CODE';
    case 'heavy_response':
      return 'HEAVY';
    case 'pool_wait':
      return 'WAIT';
    case 'transaction_hold':
      return 'TX';
    default:
      return detector.toUpperCase();
  }
}
