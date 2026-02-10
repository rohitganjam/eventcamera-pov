'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  Plus,
  RefreshCw,
  Image,
  Calendar,
  Users,
  Lock,
  ExternalLink,
  Archive,
  XCircle,
  Loader2,
  Camera
} from 'lucide-react';
import { ApiClientError, type EventSummary } from '@poveventcam/api-client';

import { organizerApi } from '../lib/organizer-api';
import { useAuth } from './AuthProvider';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type CompressionMode = 'compressed' | 'raw';

interface CreateEventFormState {
  name: string;
  eventDate: string;
  startsAt: string;
  maxGuests: string;
  maxUploadsPerGuest: string;
  compressionMode: CompressionMode;
  pin: string;
}

const DEFAULT_FORM: CreateEventFormState = {
  name: '',
  eventDate: new Date().toISOString().slice(0, 10),
  startsAt: '',
  maxGuests: '100',
  maxUploadsPerGuest: '10',
  compressionMode: 'compressed',
  pin: ''
};

function extractErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    return `${error.code}: ${error.message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Request failed';
}

function formatEventStatus(status: EventSummary['status']): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function getStatusVariant(status: EventSummary['status']): 'default' | 'secondary' | 'success' | 'warning' | 'destructive' {
  switch (status) {
    case 'active':
      return 'success';
    case 'draft':
      return 'secondary';
    case 'closed':
      return 'warning';
    case 'archived':
      return 'destructive';
    default:
      return 'default';
  }
}

function formatAmountMinor(amount: number, currency: string): string {
  return `${currency} ${(amount / 100).toFixed(2)}`;
}

function toIsoFromLocalDateTimeInput(value: string): string | null {
  if (!value.trim()) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function OrganizerShell() {
  const { session, signOut } = useAuth();

  const [events, setEvents] = useState<EventSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<CreateEventFormState>(DEFAULT_FORM);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createMessage, setCreateMessage] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  const [actioningEventId, setActioningEventId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const sortedEvents = useMemo(
    () => [...events].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [events]
  );

  async function loadEvents() {
    setIsLoading(true);
    setError(null);

    try {
      const response = await organizerApi.listEvents();
      setEvents(response.events);
    } catch (nextError) {
      setError(extractErrorMessage(nextError));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadEvents();
  }, []);

  function openCreateModal() {
    setForm(DEFAULT_FORM);
    setCreateError(null);
    setCreateMessage(null);
    setIsCreateModalOpen(true);
  }

  function closeCreateModal() {
    setIsCreateModalOpen(false);
    setCreateError(null);
    setCreateMessage(null);
  }

  async function handleCreateEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateError(null);
    setCreateMessage(null);
    setIsCreating(true);

    const maxGuests = Number.parseInt(form.maxGuests, 10);
    const maxUploadsPerGuest = Number.parseInt(form.maxUploadsPerGuest, 10);
    const startsAtIso = toIsoFromLocalDateTimeInput(form.startsAt);

    if (!form.name.trim()) {
      setCreateError('Event name is required.');
      setIsCreating(false);
      return;
    }

    if (!Number.isInteger(maxGuests) || maxGuests < 1) {
      setCreateError('Max guests must be a positive integer.');
      setIsCreating(false);
      return;
    }

    if (!Number.isInteger(maxUploadsPerGuest) || maxUploadsPerGuest < 1) {
      setCreateError('Images per guest must be a positive integer.');
      setIsCreating(false);
      return;
    }

    if (form.pin && !/^\d{4}$/.test(form.pin)) {
      setCreateError('PIN must be exactly 4 digits.');
      setIsCreating(false);
      return;
    }

    try {
      const response = await organizerApi.createEvent({
        name: form.name.trim(),
        event_date: form.eventDate,
        starts_at: startsAtIso,
        max_guests: maxGuests,
        max_uploads_per_guest: maxUploadsPerGuest,
        compression_mode: form.compressionMode,
        pin: form.pin ? form.pin : null
      });

      if ('requires_payment' in response) {
        setCreateMessage(
          `Payment required (${formatAmountMinor(
            response.fee_difference,
            response.currency
          )}). Complete payment: ${response.payment_url}`
        );
        return;
      }

      setEvents((current) => [response.event, ...current]);
      closeCreateModal();
    } catch (nextError) {
      setCreateError(extractErrorMessage(nextError));
    } finally {
      setIsCreating(false);
    }
  }

  async function handleCloseEvent(eventId: string) {
    setActionError(null);
    setActioningEventId(eventId);

    try {
      const response = await organizerApi.closeEvent(eventId);
      setEvents((current) =>
        current.map((item) => (item.id === eventId ? response.event : item))
      );
    } catch (nextError) {
      setActionError(extractErrorMessage(nextError));
    } finally {
      setActioningEventId(null);
    }
  }

  async function handleArchiveEvent(eventId: string) {
    setActionError(null);
    setActioningEventId(eventId);

    try {
      const response = await organizerApi.archiveEvent(eventId);
      setEvents((current) =>
        current.map((item) => (item.id === eventId ? response.event : item))
      );
    } catch (nextError) {
      setActionError(extractErrorMessage(nextError));
    } finally {
      setActioningEventId(null);
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      {/* Header */}
      <header className="border-b bg-white/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Camera className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">Organizer Dashboard</h1>
              <p className="text-sm text-muted-foreground">{session?.user.email}</p>
            </div>
          </div>
          <Button variant="ghost" onClick={() => void signOut()}>
            Sign Out
          </Button>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 py-6 space-y-6">
        {/* Events Panel */}
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>Your Events</CardTitle>
                <CardDescription>Manage your photo collection events</CardDescription>
              </div>
              <div className="flex gap-2">
                <Button onClick={openCreateModal}>
                  <Plus className="h-4 w-4" />
                  New Event
                </Button>
                <Button variant="outline" onClick={() => void loadEvents()} disabled={isLoading}>
                  <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                </Button>
              </div>
            </div>
          </CardHeader>

          <CardContent>
            {error && (
              <Alert variant="destructive" className="mb-4">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {actionError && (
              <Alert variant="destructive" className="mb-4">
                <AlertDescription>{actionError}</AlertDescription>
              </Alert>
            )}

            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : sortedEvents.length === 0 ? (
              <div className="py-12 text-center">
                <Camera className="mx-auto h-12 w-12 text-muted-foreground/50" />
                <p className="mt-4 text-muted-foreground">No events yet. Create your first event to get started.</p>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {sortedEvents.map((item) => (
                  <Card key={item.id} className="overflow-hidden">
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between">
                        <CardTitle className="text-base">{item.name}</CardTitle>
                        <Badge variant={getStatusVariant(item.status)}>
                          {formatEventStatus(item.status)}
                        </Badge>
                      </div>
                      <CardDescription className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {item.event_date}
                      </CardDescription>
                    </CardHeader>

                    <CardContent className="space-y-3">
                      <div className="space-y-1.5 text-sm">
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Users className="h-3.5 w-3.5" />
                          <span>{item.max_guests} guests</span>
                          <span className="text-border">|</span>
                          <Image className="h-3.5 w-3.5" />
                          <span>{item.max_uploads_per_guest} img/guest</span>
                        </div>
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <span className="text-xs">Slug:</span>
                          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{item.slug}</code>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatAmountMinor(item.total_fee, item.currency)} • {item.compression_mode}
                        </div>
                        {item.guest_url && (
                          <a
                            href={item.guest_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-xs text-primary hover:underline"
                          >
                            <ExternalLink className="h-3 w-3" />
                            Guest link
                          </a>
                        )}
                      </div>

                      <div className="flex flex-wrap gap-2 pt-2">
                        <Button size="sm" asChild>
                          <Link href={`/events/${item.id}/gallery`}>
                            <Image className="h-4 w-4" />
                            Gallery
                          </Link>
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void handleCloseEvent(item.id)}
                          disabled={actioningEventId === item.id || item.status === 'archived'}
                        >
                          {actioningEventId === item.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <XCircle className="h-4 w-4" />
                          )}
                          Close
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void handleArchiveEvent(item.id)}
                          disabled={actioningEventId === item.id || item.status === 'archived'}
                        >
                          {actioningEventId === item.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Archive className="h-4 w-4" />
                          )}
                          Archive
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Create Event Modal */}
      <Dialog open={isCreateModalOpen} onOpenChange={setIsCreateModalOpen}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create New Event</DialogTitle>
            <DialogDescription>
              Set up a new photo collection event for your guests
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleCreateEvent} className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="event-name">Event name</Label>
              <Input
                id="event-name"
                type="text"
                value={form.name}
                onChange={(next) => setForm((current) => ({ ...current, name: next.target.value }))}
                placeholder="Rohit and Jyoti Wedding"
                required
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="event-date">Event date</Label>
                <Input
                  id="event-date"
                  type="date"
                  value={form.eventDate}
                  onChange={(next) => setForm((current) => ({ ...current, eventDate: next.target.value }))}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="starts-at">Starts at (optional)</Label>
                <Input
                  id="starts-at"
                  type="datetime-local"
                  value={form.startsAt}
                  onChange={(next) => setForm((current) => ({ ...current, startsAt: next.target.value }))}
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="max-guests">Max guests</Label>
                <Input
                  id="max-guests"
                  type="number"
                  min={1}
                  value={form.maxGuests}
                  onChange={(next) =>
                    setForm((current) => ({ ...current, maxGuests: next.target.value }))
                  }
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="max-uploads-per-guest">Images per guest</Label>
                <Input
                  id="max-uploads-per-guest"
                  type="number"
                  min={1}
                  value={form.maxUploadsPerGuest}
                  onChange={(next) =>
                    setForm((current) => ({ ...current, maxUploadsPerGuest: next.target.value }))
                  }
                  required
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="compression-mode">Compression mode</Label>
                <Select
                  value={form.compressionMode}
                  onValueChange={(value: string) =>
                    setForm((current) => ({
                      ...current,
                      compressionMode: value as CompressionMode
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="compressed">Compressed</SelectItem>
                    <SelectItem value="raw">Raw</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="pin">PIN (optional, 4 digits)</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="pin"
                    type="text"
                    inputMode="numeric"
                    pattern="\d{4}"
                    maxLength={4}
                    value={form.pin}
                    onChange={(next) => setForm((current) => ({ ...current, pin: next.target.value }))}
                    placeholder="1234"
                    className="pl-9"
                  />
                </div>
              </div>
            </div>

            {createMessage && (
              <Alert variant="success">
                <AlertDescription>{createMessage}</AlertDescription>
              </Alert>
            )}
            {createError && (
              <Alert variant="destructive">
                <AlertDescription>{createError}</AlertDescription>
              </Alert>
            )}

            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={closeCreateModal}>
                Cancel
              </Button>
              <Button type="submit" disabled={isCreating}>
                {isCreating && <Loader2 className="h-4 w-4 animate-spin" />}
                {isCreating ? 'Creating...' : 'Create Event'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  );
}
