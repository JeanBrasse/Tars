interface ToggleProps {
  enabled: boolean;
  onChange: () => void;
  disabled?: boolean;
  /** What the switch turns on, for assistive technology: the words beside it are not its label. */
  label?: string;
}

/** Hard-cornered switch: tangerine when on, flat surface when off. */
export const Toggle = ({ enabled, onChange, disabled, label }: ToggleProps) => (
  <button
    role="switch"
    aria-checked={enabled}
    aria-label={label}
    onClick={onChange}
    disabled={disabled}
    className={`w-[30px] h-4 border transition-colors relative shrink-0 ${
      enabled ? 'bg-primary border-primary' : 'bg-secondary border-border'
    } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
  >
    <span
      className={`block w-3 h-3 transition-all absolute top-[1px] ${
        enabled ? 'bg-knob left-[16px]' : 'bg-muted-foreground left-[2px]'
      }`}
    />
  </button>
);
