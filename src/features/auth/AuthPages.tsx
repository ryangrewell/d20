import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { getAuthClient } from '@/lib/auth/authClient';
import { zodResolver } from '@/lib/forms';
import { safeNext, useAuth } from '@/app/auth';
import { Button, Card, Field, Input } from '@/components/ui/primitives';
import { Logo } from '@/components/layout/AppLayout';

function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-atmosphere px-4 py-12">
      <Logo className="mb-8" />
      <Card className="w-full max-w-sm p-6 shadow-2xl">
        <h1 className="font-display text-xl font-semibold tracking-wide">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </Card>
      {footer && <div className="mt-6 text-sm text-muted">{footer}</div>}
    </div>
  );
}

// Held in memory only (never storage) so verification can sign the user straight in.
let pendingPassword: string | null = null;

const Email = z.string().trim().email('Enter a valid email address');
const Password = z.string().min(8, 'Use at least 8 characters');

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
      {message}
    </p>
  );
}

export function SignInPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const form = useForm({ resolver: zodResolver(z.object({ email: Email, password: z.string().min(1, 'Enter your password') })), defaultValues: { email: '', password: '' } });

  const onSubmit = form.handleSubmit(async ({ email, password }) => {
    setError(null);
    try {
      const r = await (await getAuthClient()).signIn(email, password);
      if (r.status === 'CONFIRM_SIGN_UP') {
        navigate(`/verify?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`);
        return;
      }
      await refresh();
      navigate(next, { replace: true });
    } catch (e) {
      setError((e as Error).message);
    }
  });

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to return to your table."
      footer={
        <>
          New here?{' '}
          <Link className="text-accent hover:underline" to={`/sign-up?next=${encodeURIComponent(next)}`}>
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError message={error} />
        <Field label="Email" htmlFor="email" error={form.formState.errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" autoFocus {...form.register('email')} />
        </Field>
        <Field label="Password" htmlFor="password" error={form.formState.errors.password?.message}>
          <Input id="password" type="password" autoComplete="current-password" {...form.register('password')} />
        </Field>
        <Button type="submit" className="w-full justify-center" loading={form.formState.isSubmitting}>
          Sign in
        </Button>
        <Link to="/forgot-password" className="block text-center text-sm text-muted hover:text-text">
          Forgot your password?
        </Link>
      </form>
    </AuthShell>
  );
}

export function SignUpPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const schema = z
    .object({ displayName: z.string().trim().min(1, 'Choose a display name').max(40), email: Email, password: Password, confirm: z.string() })
    .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { displayName: '', email: '', password: '', confirm: '' } });

  const onSubmit = form.handleSubmit(async ({ displayName, email, password }) => {
    setError(null);
    try {
      await (await getAuthClient()).signUp(email, password, displayName);
      pendingPassword = password;
      navigate(`/verify?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`);
    } catch (e) {
      setError((e as Error).message);
    }
  });

  return (
    <AuthShell
      title="Create your account"
      subtitle="Run campaigns or join your friends' tables."
      footer={
        <>
          Already have an account?{' '}
          <Link className="text-accent hover:underline" to={`/sign-in?next=${encodeURIComponent(next)}`}>
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError message={error} />
        <Field label="Display name" htmlFor="displayName" hint="Shown to others at the table." error={form.formState.errors.displayName?.message}>
          <Input id="displayName" autoComplete="nickname" {...form.register('displayName')} />
        </Field>
        <Field label="Email" htmlFor="email" error={form.formState.errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" {...form.register('email')} />
        </Field>
        <Field label="Password" htmlFor="password" error={form.formState.errors.password?.message}>
          <Input id="password" type="password" autoComplete="new-password" {...form.register('password')} />
        </Field>
        <Field label="Confirm password" htmlFor="confirm" error={form.formState.errors.confirm?.message}>
          <Input id="confirm" type="password" autoComplete="new-password" {...form.register('confirm')} />
        </Field>
        <Button type="submit" className="w-full justify-center" loading={form.formState.isSubmitting}>
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}

export function VerifyPage() {
  const [params] = useSearchParams();
  const email = params.get('email') ?? '';
  const next = safeNext(params.get('next'));
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const form = useForm({ resolver: zodResolver(z.object({ code: z.string().trim().min(4, 'Enter the code from your email') })), defaultValues: { code: '' } });

  const onSubmit = form.handleSubmit(async ({ code }) => {
    setError(null);
    try {
      const client = await getAuthClient();
      await client.confirmSignUp(email, code);
      const pending = pendingPassword;
      pendingPassword = null;
      if (pending && (await client.signIn(email, pending)).status === 'SIGNED_IN') {
        await refresh();
        navigate(next, { replace: true });
        return;
      }
      toast.success('Email verified. Please sign in.');
      navigate(`/sign-in?next=${encodeURIComponent(next)}`);
    } catch (e) {
      setError((e as Error).message);
    }
  });

  return (
    <AuthShell title="Check your email" subtitle={`We sent a verification code to ${email || 'your email'}.`}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError message={error} />
        <Field label="Verification code" htmlFor="code" error={form.formState.errors.code?.message}>
          <Input id="code" inputMode="numeric" autoComplete="one-time-code" autoFocus {...form.register('code')} />
        </Field>
        <Button type="submit" className="w-full justify-center" loading={form.formState.isSubmitting}>
          Verify email
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="w-full justify-center"
          onClick={async () => {
            await (await getAuthClient()).resendCode(email).catch(() => undefined);
            toast.message('If the account exists, a new code is on its way.');
          }}
        >
          Resend code
        </Button>
      </form>
    </AuthShell>
  );
}

export function ForgotPasswordPage() {
  const [stage, setStage] = useState<'request' | 'reset'>('request');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const requestForm = useForm({ resolver: zodResolver(z.object({ email: Email })), defaultValues: { email: '' } });
  const resetForm = useForm({ resolver: zodResolver(z.object({ code: z.string().trim().min(4, 'Enter the code'), newPassword: Password })), defaultValues: { code: '', newPassword: '' } });

  if (stage === 'request') {
    return (
      <AuthShell title="Reset your password" subtitle="We'll email you a code if an account exists for that address.">
        <form
          noValidate
          className="space-y-4"
          onSubmit={requestForm.handleSubmit(async (v) => {
            await (await getAuthClient()).forgotPassword(v.email).catch(() => undefined);
            setEmail(v.email);
            setStage('reset');
          })}
        >
          <Field label="Email" htmlFor="email" error={requestForm.formState.errors.email?.message}>
            <Input id="email" type="email" autoComplete="email" {...requestForm.register('email')} />
          </Field>
          <Button type="submit" className="w-full justify-center" loading={requestForm.formState.isSubmitting}>
            Send reset code
          </Button>
        </form>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Choose a new password" subtitle={`If ${email} has an account, a code is on its way.`}>
      <form
        noValidate
        className="space-y-4"
        onSubmit={resetForm.handleSubmit(async (v) => {
          setError(null);
          try {
            await (await getAuthClient()).resetPassword(email, v.code, v.newPassword);
            toast.success('Password updated. Please sign in.');
            navigate('/sign-in');
          } catch (e) {
            setError((e as Error).message);
          }
        })}
      >
        <FormError message={error} />
        <Field label="Code" htmlFor="code" error={resetForm.formState.errors.code?.message}>
          <Input id="code" inputMode="numeric" autoComplete="one-time-code" {...resetForm.register('code')} />
        </Field>
        <Field label="New password" htmlFor="newPassword" error={resetForm.formState.errors.newPassword?.message}>
          <Input id="newPassword" type="password" autoComplete="new-password" {...resetForm.register('newPassword')} />
        </Field>
        <Button type="submit" className="w-full justify-center" loading={resetForm.formState.isSubmitting}>
          Update password
        </Button>
      </form>
    </AuthShell>
  );
}
