import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'dangerFilled' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

/*
 * Re-plumbing of the legacy `.button` / `.icon-button` recipes: same padding,
 * gap, weight, and radius, with the DS-4 ramp for text and the tighter control
 * heights (30 / 34 / 36 / 32-square). Every size keeps a 40px coarse-pointer
 * minimum through the `touch:` variant so the narrow e2e sweep stays green.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-hover',
  {
    variants: {
      variant: {
        primary:
          'border border-primary bg-primary text-primary-fg hover:border-primary-hover hover:bg-primary-hover',
        secondary: 'border border-border-control bg-bg text-fg hover:bg-bg-line',
        danger: 'border border-danger-border bg-bg text-danger hover:bg-danger-bg',
        dangerFilled: 'border border-danger-border bg-danger-bg text-danger',
        ghost: 'bg-transparent text-fg-mid hover:bg-bg-hover',
      },
      size: {
        sm: 'min-h-[30px] px-2.5 text-xs touch:min-h-10',
        md: 'min-h-[34px] px-3 text-md touch:min-h-10',
        lg: 'min-h-9 px-3 text-md touch:min-h-10',
        icon: 'size-8 touch:size-10 touch:min-h-10 touch:min-w-10',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, ...props },
  ref,
) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (asChild) return <Slot className={classes} ref={ref} {...props} />;
  return <button type="button" className={classes} ref={ref} {...props} />;
});
