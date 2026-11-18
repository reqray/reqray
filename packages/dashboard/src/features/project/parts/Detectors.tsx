import { DetectorRow } from './DetectorRow';

const DETECTORS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'nPlusOne', label: 'N+1' },
  { key: 'sequentialHttp', label: 'sequential HTTP' },
  { key: 'duplicateHttp', label: 'duplicate call' },
  { key: 'duplicateCache', label: 'duplicate cache read' },
  { key: 'slowBudget', label: 'time budget' },
];

interface DetectorsProps {
  detect: Record<string, unknown>;
}

/** The detectors and the thresholds they fire at. */
export function Detectors({ detect }: DetectorsProps) {
  return (
    <div className="detectors">
      {DETECTORS.map((detector) => (
        <DetectorRow
          key={detector.key}
          label={detector.label}
          settings={(detect[detector.key] as Record<string, number> | null) ?? null}
        />
      ))}
    </div>
  );
}
