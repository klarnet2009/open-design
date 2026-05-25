import type { HTMLAttributes, ReactNode } from 'react';

import { joinClassNames } from './class-names';
import styles from './visually-hidden.module.css';

export interface VisuallyHiddenProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
}

export function VisuallyHidden({ children, className, ...props }: VisuallyHiddenProps) {
  return <span className={joinClassNames(styles.visuallyHidden, className)} {...props}>{children}</span>;
}
