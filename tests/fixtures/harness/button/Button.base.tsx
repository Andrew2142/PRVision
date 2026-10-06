import clsx from "clsx";
import type { ButtonHTMLAttributes } from "react";
import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
}

export function Button({ variant = "primary", size = "md", children, ...rest }: ButtonProps) {
  return (
    <button className={clsx(styles.button, styles[variant], styles[size])} {...rest}>
      <span>{children}</span>
    </button>
  );
}
