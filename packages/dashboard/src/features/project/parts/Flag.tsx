/** A capability, ticked or crossed. */

interface FlagProps {
  on: boolean;
  children: React.ReactNode;
}

/** A setting that is either on or off, and reads as such at a glance. */
export function Flag({ on, children }: FlagProps) {
  return (
    <span className={`feature ${on ? 's-ok' : 's-dim'}`}>
      {on ? '●' : '○'} {children}
    </span>
  );
}
