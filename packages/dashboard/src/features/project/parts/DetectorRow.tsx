import { detectorOptions } from '../../../shared/format';

interface DetectorRowProps {
  label: string;
  /** `null` — the detector is off, and has no thresholds to show. */
  settings: Record<string, number> | null;
}

export function DetectorRow({ label, settings }: DetectorRowProps) {
  return (
    <div className="detector-row">
      <span className={settings ? 's-ok' : 's-dim'}>{settings ? '●' : '○'}</span>
      <span className="mono">{label}</span>
      <span className="mono s-fg2">{detectorOptions(settings)}</span>
    </div>
  );
}
