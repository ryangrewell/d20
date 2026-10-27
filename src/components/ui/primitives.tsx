import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { clsx } from 'clsx';
import { Loader2 } from 'lucide-react';

export const cn = clsx;

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type Size = 'sm' | 'md' | 'lg' | 'icon';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-strong shadow-[0_0_0_1px_rgba(0,0,0,.2),0_6px_20px_-8px_var(--color-accent)]',
  secondary: 'bg-surface-3 text-text hover:bg-[#352f45]',
  ghost: 'text-muted hover:text-text hover:bg-surface-2',
  outline: 'border border-border text-text hover:bg-surface-2',
  danger: 'bg-danger/90 text-white hover:bg-danger',
};
const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-6 text-base gap-2',
  icon: 'h-9 w-9 justify-center',
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'primary', size = 'md', loading, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center rounded-lg font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none select-none whitespace-nowrap',
        variants[variant],
        sizes[size],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

const fieldBase = 'w-full rounded-lg border border-border bg-surface px-3 text-sm text-text placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 transition';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(fieldBase, 'h-10', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(fieldBase, 'py-2 min-h-24', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...rest }, ref) {
  return <select ref={ref} className={cn(fieldBase, 'h-10 pr-8', className)} {...rest} />;
});

export function Field({ label, htmlFor, error, hint, children, className }: { label: string; htmlFor: string; error?: string | undefined; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-text">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border border-border bg-surface/80 backdrop-blur-sm', className)} {...rest} />;
}

export function Badge({ tone = 'neutral', className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: 'neutral' | 'accent' | 'success' | 'danger' | 'info' }) {
  const tones = {
    neutral: 'bg-surface-3 text-muted',
    accent: 'bg-accent/15 text-accent',
    success: 'bg-success/15 text-success',
    danger: 'bg-danger/15 text-danger',
    info: 'bg-info/15 text-info',
  };
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', tones[tone], className)} {...rest} />;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 text-muted text-sm">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      <span>{label}…</span>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-12 text-center">
      {icon && <div className="mb-3 text-accent">{icon}</div>}
      <h3 className="font-semibold">{title}</h3>
      {children && <p className="mt-1 max-w-md text-sm text-muted">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <div role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-text">
      <p>{message}</p>
      {onRetry && (
        <Button size="sm" variant="outline" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
