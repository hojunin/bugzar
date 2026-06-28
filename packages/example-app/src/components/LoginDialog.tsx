import { Loader2, LogIn } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { type AuthResult, login } from '@/lib/api';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAuthed: (user: AuthResult) => void;
}

export function LoginDialog({ open, onOpenChange, onAuthed }: Props) {
  const [username, setUsername] = React.useState('emilys');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const user = await login(username, password);
      onAuthed(user);
      onOpenChange(false);
      toast.success(`Welcome back, ${user.firstName}!`);
    } catch (err) {
      // Wrong credentials → real 400 from /auth/login → captured by Bugzar.
      console.error('[storefront] login failed', err);
      setError('Invalid username or password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LogIn className="size-5" /> Sign in
          </DialogTitle>
          <DialogDescription>
            Demo account is prefilled — use password{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">emilyspass</code>, or type a
            wrong one to capture a failed login.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="emilyspass"
              autoComplete="current-password"
              aria-invalid={!!error}
            />
          </div>
          {error && <p className="text-sm font-medium text-destructive">{error}</p>}
          <Button type="submit" size="lg" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
