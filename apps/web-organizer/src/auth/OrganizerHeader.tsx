'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Loader2, LogOut } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface OrganizerHeaderProps {
  title: string;
  subtitle?: string;
  backHref?: string;
  backLabel?: string;
  userEmail?: string | null;
  userName?: string | null;
  onSignOut: () => Promise<void> | void;
}

function computeInitials(name?: string | null, email?: string | null): string {
  const source = name?.trim() || email?.trim() || 'U';
  if (!source) return 'U';

  if (source.includes(' ')) {
    const parts = source.split(' ').filter(Boolean);
    const first = parts[0]?.[0] ?? '';
    const second = parts[1]?.[0] ?? '';
    return `${first}${second}`.toUpperCase() || 'U';
  }

  return source[0]?.toUpperCase() ?? 'U';
}

export function OrganizerHeader({
  title,
  subtitle,
  backHref,
  backLabel = 'Dashboard',
  userEmail,
  userName,
  onSignOut
}: OrganizerHeaderProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const displayName = useMemo(() => {
    const metaName = userName?.trim();
    if (metaName) return metaName;
    if (userEmail) return userEmail.split('@')[0] ?? 'Organizer';
    return 'Organizer';
  }, [userEmail, userName]);

  const initials = useMemo(() => computeInitials(displayName, userEmail), [displayName, userEmail]);

  useEffect(() => {
    function handleOutsideClick(event: MouseEvent) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    }

    if (isMenuOpen) {
      document.addEventListener('mousedown', handleOutsideClick);
    }

    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
    };
  }, [isMenuOpen]);

  async function handleSignOutClick() {
    try {
      setIsSigningOut(true);
      await onSignOut();
    } finally {
      setIsSigningOut(false);
      setIsMenuOpen(false);
    }
  }

  return (
    <header className="border-b bg-white/80 backdrop-blur-sm">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4">
        <div className="flex items-center gap-3 min-w-0">
          {backHref ? (
            <Button
              variant="ghost"
              size="icon"
              asChild
              className="h-9 w-9 rounded-full"
              aria-label={backLabel}
            >
              <Link href={backHref}>
                <ArrowLeft className="h-4 w-4" />
                <span className="sr-only">{backLabel}</span>
              </Link>
            </Button>
          ) : null}
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">{title}</h1>
            {subtitle ? <p className="truncate text-sm text-muted-foreground">{subtitle}</p> : null}
          </div>
        </div>

        <div ref={menuRef} className="relative">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsMenuOpen((current) => !current)}
            className="h-9 w-9 rounded-full p-0"
            aria-expanded={isMenuOpen}
            aria-label="Open profile menu"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              {initials}
            </span>
          </Button>

          {isMenuOpen ? (
            <div className="absolute right-0 z-40 mt-2 w-64 rounded-md border bg-white p-2 shadow-lg">
              <div className="rounded-md bg-muted/40 px-3 py-2">
                <p className="text-sm font-medium">{displayName}</p>
                <p className="text-xs text-muted-foreground">{userEmail ?? 'No email'}</p>
              </div>
              <Button
                variant="ghost"
                className="mt-2 w-full justify-start"
                onClick={() => void handleSignOutClick()}
                disabled={isSigningOut}
              >
                {isSigningOut ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <LogOut className="h-4 w-4" />
                )}
                {isSigningOut ? 'Signing out...' : 'Sign out'}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
