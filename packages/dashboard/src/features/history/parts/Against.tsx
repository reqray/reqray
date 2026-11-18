interface AgainstProps {
  now: number;
  before: number | undefined;
  format: (value: number) => string;
}

/** A number against the same number a period ago. */
export function Against({ now, before, format }: AgainstProps) {
  if (before === undefined || before === 0) return null;
  const move = (now - before) / before;
  // Under a percent either way is noise dressed as a trend.
  if (Math.abs(move) < 0.01) return <span className="s-dim"> · flat</span>;
  return (
    <span className={move > 0 ? 's-warn' : 's-ok'}>
      {' '}
      · {move > 0 ? '+' : ''}
      {Math.round(move * 100)}%<span className="s-dim"> from {format(before)}</span>
    </span>
  );
}
