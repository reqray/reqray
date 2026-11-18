import type { ReplayComparison } from '../../../api/index';
import { ComparisonRow, FIELDS } from './ComparisonRow';

interface ComparisonProps {
  result: ReplayComparison | null;
}

export function Comparison({ result }: ComparisonProps) {
  return (
    <div className="comparison">
      <div className="label">COMPARISON</div>
      <div className="cmp-row cmp-head">
        <span />
        <span>original</span>
        <span>replay</span>
      </div>
      {FIELDS.map((field) => (
        <ComparisonRow key={field.name} field={field} result={result} />
      ))}
    </div>
  );
}
