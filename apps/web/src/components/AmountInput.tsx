import { settleAmountText } from "@fd/shared";
import type { InputHTMLAttributes, Ref } from "react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> & {
  value: string;
  onChange: (value: string) => void;
  ref?: Ref<HTMLInputElement>;
};

/** An amount field that also takes arithmetic ("12.50*3", "100-4.95") and shows the result once you leave it. */
export function AmountInput({ onBlur, onChange, value, ...rest }: Props) {
  return (
    <input
      inputMode="decimal"
      {...rest}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={(e) => {
        const settled = settleAmountText(value);
        if (settled !== value) onChange(settled);
        onBlur?.(e);
      }}
    />
  );
}
