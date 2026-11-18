import { RULES, type RuleId } from '../lib/rules';

interface RulesPopoverProps {
  enabled: ReadonlySet<RuleId>;
  open: boolean;
  onToggleOpen: () => void;
  onToggleRule: (id: RuleId) => void;
}

/** The `rules · N` pill and its popover, pinned to the right of the filters. */
export function RulesPopover({ enabled, open, onToggleOpen, onToggleRule }: RulesPopoverProps) {
  return (
    <div className="rules">
      <button
        type="button"
        className="chip"
        aria-pressed={enabled.size > 0}
        aria-expanded={open}
        onClick={onToggleOpen}
      >
        rules · {enabled.size}
      </button>

      {open ? (
        <div className="rules-pop">
          <div className="rules-head label">HIGHLIGHT RULES</div>
          {RULES.map((rule) => (
            <button
              key={rule.id}
              type="button"
              className="rules-row"
              onClick={() => onToggleRule(rule.id)}
            >
              <span className={enabled.has(rule.id) ? 's-acc' : 's-dim'}>
                {enabled.has(rule.id) ? '■' : '□'}
              </span>
              <span className="rules-swatch" data-tone={rule.tone} />
              <span className="ellipsis">{rule.label}</span>
            </button>
          ))}
          <div className="rules-foot">first matching rule tints the row</div>
        </div>
      ) : null}
    </div>
  );
}
