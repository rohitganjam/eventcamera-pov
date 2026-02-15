'use client';

import { FormEvent, useState } from 'react';
import { Camera, Loader2 } from 'lucide-react';

import { supabase } from '../lib/supabase';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

type AuthIntent = 'sign-in' | 'sign-up';

export function SignInForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [intent, setIntent] = useState<AuthIntent>('sign-in');
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setIsLoading(true);

    try {
      if (intent === 'sign-up') {
        const redirectTo =
          process.env.NEXT_PUBLIC_ORGANIZER_REDIRECT_URL ?? window.location.origin;

        const { error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: redirectTo
          }
        });

        if (signUpError) throw signUpError;
        setMessage('Sign-up successful. Check your inbox to verify your account.');
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password
        });

        if (signInError) throw signInError;
        setMessage('Signed in successfully.');
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Authentication failed.');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <Camera className="h-6 w-6 text-primary" />
        </div>
        <CardTitle className="text-2xl">
          {intent === 'sign-up' ? 'Create Account' : 'Welcome Back'}
        </CardTitle>
        <CardDescription>
          POV EventCamera Organizer Dashboard
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Intent Toggle */}
        <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted p-1" role="tablist" aria-label="Auth intent">
          <button
            type="button"
            role="tab"
            aria-selected={intent === 'sign-in'}
            className={cn(
              'rounded-md px-3 py-2 text-sm font-medium transition-colors',
              intent === 'sign-in'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
            onClick={() => setIntent('sign-in')}
          >
            Sign In
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={intent === 'sign-up'}
            className={cn(
              'rounded-md px-3 py-2 text-sm font-medium transition-colors',
              intent === 'sign-up'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
            onClick={() => {
              setIntent('sign-up');
            }}
          >
            Sign Up
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="email"
              placeholder="organizer@example.com"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoComplete={intent === 'sign-up' ? 'new-password' : 'current-password'}
              placeholder="Enter your password"
            />
          </div>

          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isLoading
              ? 'Please wait...'
              : intent === 'sign-up'
                ? 'Create Account'
                : 'Sign In'}
          </Button>
        </form>

        {/* Messages */}
        {message && (
          <Alert variant="success">
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
