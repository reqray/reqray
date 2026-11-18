/** One labelled line of the report. */

interface FactProps {
  label: string;
  children: React.ReactNode;
}

/** A label and what it says. The screen is mostly these. */
export function Fact({ label, children }: FactProps) {
  return (
    <div className="fact">
      <span className="fact-label">{label}</span>
      <span className="fact-value mono">{children}</span>
    </div>
  );
}
