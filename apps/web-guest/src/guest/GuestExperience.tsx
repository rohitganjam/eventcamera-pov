'use client';

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Calendar,
  Camera,
  Upload,
  User,
  RefreshCw,
  X,
  ImageIcon,
  Pencil,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';

import {
  guestApi,
  GuestApiError,
  type EventLookupResponse,
  type GuestSessionPayload,
  type MyUploadItem
} from '../lib/guest-api';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { TagInput } from '@/components/tag-input';

interface GuestExperienceProps {
  slug: string;
}

type DraftStatus = 'queued' | 'uploading' | 'uploaded' | 'failed';

interface UploadDraft {
  id: string;
  file: File;
  previewUrl: string;
  tags: string[];
  status: DraftStatus;
  error: string | null;
}

const COMPRESSED_MAX_LONG_SIDE_PX = 4000;
const COMPRESSED_JPEG_QUALITY = 0.8;
const HEIC_MIME_FRAGMENTS = ['heic', 'heif'] as const;

function formatApiError(error: unknown): string {
  if (error instanceof GuestApiError) {
    return `${error.code}: ${error.message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Request failed';
}

function generateDraftId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `draft_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function createThumbnailBlob(file: File): Promise<Blob | null> {
  if (!file.type.startsWith('image/')) return null;
  if (file.type.includes('heic') || file.type.includes('heif')) return null;

  return new Promise((resolve) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (!width || !height) {
        URL.revokeObjectURL(objectUrl);
        resolve(null);
        return;
      }

      const targetWidth = Math.min(480, width);
      const targetHeight = Math.max(Math.round((targetWidth / width) * height), 1);

      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;

      const context = canvas.getContext('2d');
      if (!context) {
        URL.revokeObjectURL(objectUrl);
        resolve(null);
        return;
      }

      context.drawImage(image, 0, 0, targetWidth, targetHeight);
      canvas.toBlob(
        (blob) => {
          URL.revokeObjectURL(objectUrl);
          resolve(blob ?? null);
        },
        'image/jpeg',
        0.72
      );
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(null);
    };
    image.src = objectUrl;
  });
}

async function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Failed to decode image for compression.'));
    };

    image.src = objectUrl;
  });
}

async function createJpegBlobFromImage(
  image: HTMLImageElement,
  maxLongSidePx: number,
  quality: number
): Promise<Blob> {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) {
    throw new Error('Image dimensions are invalid.');
  }

  const scale = Math.min(1, maxLongSidePx / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Failed to initialize canvas for compression.');
  }

  context.drawImage(image, 0, 0, targetWidth, targetHeight);

  const jpegBlob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', quality);
  });

  if (!jpegBlob) {
    throw new Error('Failed to encode compressed image.');
  }

  return jpegBlob;
}

function toJpegFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed) return 'upload.jpg';
  const base = trimmed.replace(/\.[^/.]+$/, '');
  return `${base || 'upload'}.jpg`;
}

function isHeicLikeFile(file: File): boolean {
  const normalizedType = file.type.toLowerCase();
  return HEIC_MIME_FRAGMENTS.some((fragment) => normalizedType.includes(fragment));
}

async function convertHeicToJpeg(file: File): Promise<File> {
  const module = await import('heic-to');
  const converted = await module.heicTo({
    blob: file,
    type: 'image/jpeg',
    quality: COMPRESSED_JPEG_QUALITY
  });

  if (!(converted instanceof Blob)) {
    throw new Error('HEIC conversion did not return a file blob.');
  }

  return new File([converted], toJpegFileName(file.name), {
    type: 'image/jpeg',
    lastModified: file.lastModified
  });
}

async function prepareUploadFile(file: File, compressionMode: 'compressed' | 'raw'): Promise<File> {
  if (compressionMode !== 'compressed') {
    return file;
  }

  if (!file.type.startsWith('image/')) {
    throw new Error('Only image files are allowed in Standard mode.');
  }

  let sourceFile = file;
  if (isHeicLikeFile(file)) {
    try {
      sourceFile = await convertHeicToJpeg(file);
    } catch (error) {
      console.warn('HEIC conversion failed; uploading original file in compressed mode.', error);
      return file;
    }
  }

  try {
    const image = await loadImageElement(sourceFile);
    const jpegBlob = await createJpegBlobFromImage(
      image,
      COMPRESSED_MAX_LONG_SIDE_PX,
      COMPRESSED_JPEG_QUALITY
    );

    return new File([jpegBlob], toJpegFileName(sourceFile.name), {
      type: 'image/jpeg',
      lastModified: sourceFile.lastModified
    });
  } catch (error) {
    if (isHeicLikeFile(file)) {
      console.warn('HEIC compressed-mode fallback activated; uploading original file.', error);
      return file;
    }
    throw error;
  }
}

async function createDraftPreviewUrl(file: File): Promise<string> {
  const thumbnailBlob = await createThumbnailBlob(file);
  if (thumbnailBlob) {
    return URL.createObjectURL(thumbnailBlob);
  }

  return URL.createObjectURL(file);
}

function getStatusVariant(status: DraftStatus): 'default' | 'secondary' | 'success' | 'warning' | 'destructive' {
  switch (status) {
    case 'queued':
      return 'secondary';
    case 'uploading':
      return 'warning';
    case 'uploaded':
      return 'success';
    case 'failed':
      return 'destructive';
    default:
      return 'default';
  }
}

function formatEventDate(dateString: string): string {
  const date = new Date(dateString + 'T00:00:00');
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

export function GuestExperience({ slug }: GuestExperienceProps) {
  const [eventInfo, setEventInfo] = useState<EventLookupResponse | null>(null);
  const [sessionPayload, setSessionPayload] = useState<GuestSessionPayload | null>(null);
  const [uploads, setUploads] = useState<MyUploadItem[]>([]);
  const [drafts, setDrafts] = useState<UploadDraft[]>([]);
  const [nameTag, setNameTag] = useState('');
  const [pin, setPin] = useState('');
  const [isBooting, setIsBooting] = useState(true);
  const [isSavingName, setIsSavingName] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [isUploadingAll, setIsUploadingAll] = useState(false);
  const [previewUploadIndex, setPreviewUploadIndex] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const draftsRef = useRef<UploadDraft[]>([]);

  const uploadCountLabel = useMemo(() => {
    if (!sessionPayload) return '0 / 0';
    return `${sessionPayload.upload_count} / ${sessionPayload.max_uploads}`;
  }, [sessionPayload]);

  const hasPendingDrafts = useMemo(
    () => drafts.some((draft) => draft.status !== 'uploaded'),
    [drafts]
  );

  const previewUpload = useMemo(() => {
    if (previewUploadIndex === null || previewUploadIndex < 0 || previewUploadIndex >= uploads.length) {
      return null;
    }
    return uploads[previewUploadIndex];
  }, [previewUploadIndex, uploads]);

  useEffect(() => {
    if (previewUpload) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }

    return () => {
      document.body.style.overflow = '';
    };
  }, [previewUpload]);

  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  useEffect(() => {
    return () => {
      for (const draft of draftsRef.current) {
        URL.revokeObjectURL(draft.previewUrl);
      }
    };
  }, []);

  useEffect(() => {
    if (previewUploadIndex === null) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setPreviewUploadIndex(null);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setPreviewUploadIndex((current) =>
          current !== null && current > 0 ? current - 1 : current
        );
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        setPreviewUploadIndex((current) =>
          current !== null && current < uploads.length - 1 ? current + 1 : current
        );
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [previewUploadIndex, uploads.length]);

  const refreshSession = useCallback(async () => {
    const payload = await guestApi.getMySession();
    if (payload.event.slug !== slug) {
      return null;
    }

    setSessionPayload(payload);
    setNameTag(payload.session.display_name ?? '');
    return payload;
  }, [slug]);

  const refreshUploads = useCallback(async () => {
    const payload = await guestApi.getMyUploads();
    setUploads(payload.uploads);
  }, []);

  const bootstrap = useCallback(async () => {
    setIsBooting(true);
    setError(null);
    setMessage(null);

    try {
      // First, try to get existing session for this event
      try {
        const existing = await guestApi.getMySession();
        if (existing.event.slug === slug) {
          setSessionPayload(existing);
          setNameTag(existing.session.display_name ?? '');
          await refreshUploads();
          return;
        }
      } catch (sessionError) {
        // No existing session - that's fine, we'll show the landing page
        if (
          !(sessionError instanceof GuestApiError) ||
          (sessionError.statusCode !== 401 && sessionError.statusCode !== 403)
        ) {
          throw sessionError;
        }
      }

      // No session found - lookup event details to show landing page
      const lookup = await guestApi.lookupEvent({ event_slug: slug });
      setEventInfo(lookup);
    } catch (nextError) {
      setError(formatApiError(nextError));
    } finally {
      setIsBooting(false);
    }
  }, [refreshUploads, slug]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  function patchDraft(draftId: string, patch: Partial<UploadDraft>): void {
    setDrafts((current) =>
      current.map((item) => (item.id === draftId ? { ...item, ...patch } : item))
    );
  }

  function removeDraft(draftId: string): void {
    setDrafts((current) => {
      const target = current.find((item) => item.id === draftId);
      if (!target || target.status === 'uploading') {
        return current;
      }

      URL.revokeObjectURL(target.previewUrl);
      const nextDrafts = current.filter((item) => item.id !== draftId);
      if (!nextDrafts.length) {
        return [];
      }

      if (nextDrafts.every((item) => item.status === 'uploaded')) {
        for (const item of nextDrafts) {
          URL.revokeObjectURL(item.previewUrl);
        }
        return [];
      }

      return nextDrafts;
    });
  }

  async function uploadOne(draft: UploadDraft): Promise<void> {
    if (!sessionPayload) {
      setError('Session not ready. Reload and try again.');
      return;
    }

    if (!sessionPayload.session.display_name) {
      setError('Add your name tag before uploading so files are mapped to you.');
      return;
    }

    patchDraft(draft.id, { status: 'uploading', error: null });
    setError(null);
    setMessage(null);

    try {
      const preparedFile = await prepareUploadFile(
        draft.file,
        sessionPayload.event.compression_mode
      );

      if (!preparedFile.type) {
        patchDraft(draft.id, {
          status: 'failed',
          error: 'File type is missing. Please choose another file.'
        });
        return;
      }

      const createUpload = await guestApi.createUpload({
        file_type: preparedFile.type,
        file_size: preparedFile.size,
        tags: draft.tags
      });

      const originalUpload = await fetch(createUpload.upload_url, {
        method: 'PUT',
        headers: {
          'content-type': preparedFile.type
        },
        body: preparedFile
      });

      if (!originalUpload.ok) {
        throw new Error(`Storage upload failed (${originalUpload.status})`);
      }

      if (createUpload.thumb_upload_url) {
        const thumbBlob = await createThumbnailBlob(preparedFile);
        if (thumbBlob) {
          await fetch(createUpload.thumb_upload_url, {
            method: 'PUT',
            headers: {
              'content-type': 'image/jpeg'
            },
            body: thumbBlob
          });
        }
      }

      await guestApi.completeUpload(createUpload.media_id);
      patchDraft(draft.id, { status: 'uploaded', error: null });

      await Promise.all([refreshSession(), refreshUploads()]);
      setMessage('Upload complete.');
    } catch (nextError) {
      patchDraft(draft.id, {
        status: 'failed',
        error: formatApiError(nextError)
      });
      setError(formatApiError(nextError));
    }
  }

  async function handleJoinEvent(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setIsJoining(true);
    setError(null);
    setMessage(null);

    try {
      const joined = await guestApi.joinEvent({
        event_slug: slug,
        pin: eventInfo?.requires_pin ? pin.trim() : null,
        display_name: nameTag.trim() || null
      });
      setEventInfo(null);
      setSessionPayload(joined);
      setNameTag(joined.session.display_name ?? '');
      setMessage('Joined successfully. You can start uploading now.');
      await refreshUploads();
    } catch (nextError) {
      setError(formatApiError(nextError));
    } finally {
      setIsJoining(false);
    }
  }

  async function handleSaveNameTag(): Promise<void> {
    if (!sessionPayload) return;

    setIsSavingName(true);
    setError(null);
    setMessage(null);

    try {
      const updated = await guestApi.patchMySession(nameTag.trim() || null);
      setSessionPayload(updated);
      setNameTag(updated.session.display_name ?? '');
      setIsEditingName(false);
      setMessage('Name tag saved. It will be attached to new uploads.');
    } catch (nextError) {
      setError(formatApiError(nextError));
    } finally {
      setIsSavingName(false);
    }
  }

  function handleCancelEditName(): void {
    setNameTag(sessionPayload?.session.display_name ?? '');
    setIsEditingName(false);
  }

  function handleSelectFiles(event: ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;

    event.target.value = '';
    void (async () => {
      const nextDrafts = await Promise.all(
        files.map(async (file) => ({
          id: generateDraftId(),
          file,
          previewUrl: await createDraftPreviewUrl(file),
          tags: [],
          status: 'queued' as DraftStatus,
          error: null
        }))
      );

      setDrafts((current) => {
        const pendingDrafts = current.filter((draft) => draft.status !== 'uploaded');
        const uploadedDrafts = current.filter((draft) => draft.status === 'uploaded');
        for (const draft of uploadedDrafts) {
          URL.revokeObjectURL(draft.previewUrl);
        }

        return [...pendingDrafts, ...nextDrafts];
      });
    })();
  }

  async function handleUploadAll(): Promise<void> {
    if (!drafts.length) return;

    setIsUploadingAll(true);
    for (const draft of drafts) {
      if (draft.status === 'uploaded') continue;
      await uploadOne(draft);
    }
    setDrafts((current) => {
      if (!current.length || !current.every((draft) => draft.status === 'uploaded')) {
        return current;
      }

      for (const draft of current) {
        URL.revokeObjectURL(draft.previewUrl);
      }
      return [];
    });
    setIsUploadingAll(false);
  }

  if (isBooting) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-4">
        <div className="mx-auto max-w-2xl">
          <Card className="mt-8">
            <CardContent className="flex min-h-[200px] flex-col items-center justify-center gap-4 p-8">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
              <div className="text-center">
                <h1 className="text-xl font-semibold">Loading event...</h1>
                <p className="mt-1 text-sm text-muted-foreground">Please wait</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    );
  }

  // Error state - event not found or other error
  if (!eventInfo && !sessionPayload && error) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-4">
        <div className="mx-auto max-w-md space-y-4">
          <Card className="mt-8">
            <CardContent className="flex min-h-[200px] flex-col items-center justify-center gap-4 p-8">
              <Camera className="h-12 w-12 text-muted-foreground/50" />
              <div className="text-center">
                <h1 className="text-xl font-semibold">Event Not Available</h1>
                <p className="mt-2 text-sm text-muted-foreground">{error}</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    );
  }

  // Landing page - show event info and join form when not yet registered
  if (eventInfo && !sessionPayload) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-4">
        <div className="mx-auto max-w-md space-y-4">
          {/* Event Info Card */}
          <Card className="border-0 bg-gradient-to-br from-primary/5 via-primary/10 to-primary/5">
            <CardHeader className="text-center pb-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">
                POV EventCamera
              </p>
              <CardTitle className="text-2xl mt-2">
                {eventInfo.name}
              </CardTitle>
              <CardDescription className="flex items-center justify-center gap-2 mt-2">
                <Calendar className="h-4 w-4" />
                {formatEventDate(eventInfo.event_date)}
              </CardDescription>
            </CardHeader>
          </Card>

          {/* Join Event Form */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Join Event</CardTitle>
              <CardDescription>
                Enter your name to start uploading photos
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={(e) => void handleJoinEvent(e)} className="space-y-4">
                <div className="space-y-2">
                  <label htmlFor="name-input" className="text-sm font-medium">
                    Your Name
                  </label>
                  <Input
                    id="name-input"
                    value={nameTag}
                    onChange={(e) => setNameTag(e.target.value)}
                    maxLength={64}
                    placeholder="e.g. Priya, Family Table 3"
                    required
                  />
                </div>
                {eventInfo.requires_pin && (
                  <div className="space-y-2">
                    <label htmlFor="pin-input" className="text-sm font-medium">
                      Event PIN
                    </label>
                    <Input
                      id="pin-input"
                      value={pin}
                      onChange={(e) => setPin(e.target.value)}
                      inputMode="numeric"
                      maxLength={4}
                      placeholder="4-digit PIN"
                      className="text-center text-lg tracking-widest"
                      required
                    />
                  </div>
                )}
                <Button type="submit" className="w-full" disabled={isJoining}>
                  {isJoining ? 'Joining...' : 'Join Event'}
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Error Alert */}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-4 pb-24">
      <div className="mx-auto max-w-2xl space-y-4">
        {/* Hero Card */}
        <Card className="border-0 bg-gradient-to-br from-primary/5 via-primary/10 to-primary/5">
          <CardHeader className="pb-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">
              POV EventCamera
            </p>
            <CardTitle className="text-2xl">
              {sessionPayload?.event.name ?? 'Event'}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Badge variant="secondary" className="gap-1">
              <Camera className="h-3 w-3" />
              {sessionPayload?.event.slug ?? slug}
            </Badge>
            <Badge variant="outline" className="gap-1">
              <ImageIcon className="h-3 w-3" />
              Uploads: {uploadCountLabel}
            </Badge>
          </CardContent>
        </Card>

        {sessionPayload && (
          <>
            {/* Name Tag */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <User className="h-4 w-4" />
                    Your Name Tag
                  </CardTitle>
                  {!isEditingName && sessionPayload.session.display_name && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setIsEditingName(true)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {isEditingName || !sessionPayload.session.display_name ? (
                  <div className="flex gap-2">
                    <Input
                      value={nameTag}
                      onChange={(event) => setNameTag(event.target.value)}
                      maxLength={64}
                      placeholder="e.g. Priya, Family Table 3"
                      className="flex-1"
                    />
                    <Button
                      onClick={() => void handleSaveNameTag()}
                      disabled={isSavingName}
                      variant="secondary"
                    >
                      {isSavingName ? 'Saving...' : 'Save'}
                    </Button>
                    {isEditingName && sessionPayload.session.display_name && (
                      <Button
                        onClick={handleCancelEditName}
                        variant="outline"
                        disabled={isSavingName}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                ) : (
                  <p className="text-base font-medium">
                    {sessionPayload.session.display_name}
                  </p>
                )}
              </CardContent>
            </Card>

            {/* File Picker */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Camera className="h-4 w-4" />
                  Add Photos
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <label className="flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed border-muted-foreground/25 bg-muted/50 p-6 transition-colors hover:border-primary/50 hover:bg-muted">
                  <div className="rounded-full bg-primary/10 p-3">
                    <Upload className="h-6 w-6 text-primary" />
                  </div>
                  <div className="text-center">
                    <p className="font-medium">Tap to select photos</p>
                    <p className="text-sm text-muted-foreground">From camera or gallery</p>
                  </div>
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    capture="environment"
                    onChange={handleSelectFiles}
                    className="hidden"
                  />
                </label>

                {hasPendingDrafts && (
                  <>
                    <Button
                      onClick={() => void handleUploadAll()}
                      disabled={isUploadingAll}
                      className="w-full"
                    >
                      <Upload className="h-4 w-4" />
                      {isUploadingAll ? 'Uploading...' : `Upload All (${drafts.filter(d => d.status !== 'uploaded').length})`}
                    </Button>

                    <div className="space-y-3 border-t pt-4">
                      <div>
                        <h3 className="text-lg font-semibold">Upload Queue</h3>
                        <p className="text-sm text-muted-foreground">
                          {drafts.filter(d => d.status === 'uploaded').length} of {drafts.length} uploaded
                        </p>
                      </div>

                      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        {drafts.map((draft) => (
                          <li
                            key={draft.id}
                            className="overflow-hidden rounded-lg border bg-card"
                          >
                            <div className="relative aspect-square bg-muted">
                              <img
                                src={draft.previewUrl}
                                alt={draft.file.name}
                                className="h-full w-full object-cover"
                              />
                              <Button
                                size="icon"
                                variant="secondary"
                                className="absolute right-2 top-2 h-8 w-8"
                                onClick={() => removeDraft(draft.id)}
                                disabled={draft.status === 'uploading'}
                                aria-label={`Remove ${draft.file.name}`}
                              >
                                <X className="h-4 w-4" />
                              </Button>
                              {draft.status !== 'queued' && (
                                <Badge
                                  variant={getStatusVariant(draft.status)}
                                  className="absolute bottom-2 left-2 capitalize"
                                >
                                  {draft.status}
                                </Badge>
                              )}
                            </div>

                            <div className="space-y-2 p-2">
                              <TagInput
                                label="Tags (comma separated)"
                                value={draft.tags}
                                onChange={(nextTags) => patchDraft(draft.id, { tags: nextTags })}
                                disabled={draft.status === 'uploading'}
                                placeholder="Add tag and press Enter"
                              />
                              <p className="truncate text-xs text-muted-foreground">
                                {draft.file.name}
                              </p>

                              {draft.error && (
                                <Alert variant="destructive">
                                  <AlertDescription>{draft.error}</AlertDescription>
                                </Alert>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* My Uploads */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">My Uploads</CardTitle>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void refreshUploads()}
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {uploads.length > 0 ? (
                  <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {uploads.map((upload, index) => (
                      <li
                        key={upload.media_id}
                        className="overflow-hidden rounded-lg border bg-card"
                      >
                        <button
                          type="button"
                          className="aspect-square w-full cursor-zoom-in"
                          onClick={() => setPreviewUploadIndex(index)}
                        >
                          <img
                            src={upload.thumb_url}
                            alt="Uploaded media preview"
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        </button>
                        <div className="p-2">
                          <p className="truncate text-xs font-medium">
                            {upload.uploader_name ?? 'No name tag'}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {upload.tags?.length ? upload.tags.join(', ') : 'No tags'}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No uploads yet. Add some photos above.
                  </p>
                )}
              </CardContent>
            </Card>
          </>
        )}

        {/* Alerts */}
        {message && (
          <Alert variant="success" className="fixed bottom-4 left-4 right-4 mx-auto max-w-2xl">
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive" className="fixed bottom-4 left-4 right-4 mx-auto max-w-2xl">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Fullscreen preview */}
        {previewUpload && previewUploadIndex !== null && (
          <div
            className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
            onClick={() => setPreviewUploadIndex(null)}
          >
            {previewUploadIndex > 0 && (
              <button
                className="absolute left-4 top-1/2 -translate-y-1/2 text-white/80 hover:text-white p-3 rounded-full hover:bg-white/10 transition-colors"
                onClick={(event) => {
                  event.stopPropagation();
                  setPreviewUploadIndex(previewUploadIndex - 1);
                }}
              >
                <ChevronLeft className="h-8 w-8" />
              </button>
            )}

            {previewUploadIndex < uploads.length - 1 && (
              <button
                className="absolute right-4 top-1/2 -translate-y-1/2 text-white/80 hover:text-white p-3 rounded-full hover:bg-white/10 transition-colors"
                onClick={(event) => {
                  event.stopPropagation();
                  setPreviewUploadIndex(previewUploadIndex + 1);
                }}
              >
                <ChevronRight className="h-8 w-8" />
              </button>
            )}

            <div
              className="w-full max-w-[96vw] h-[92vh] flex flex-col gap-3 px-4"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="sticky top-0 z-20 bg-white/10 backdrop-blur-sm rounded-lg px-4 py-3 text-white">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{previewUpload.uploader_name ?? 'No name tag'}</p>
                    <p className="text-sm text-white/70 truncate">
                      {previewUpload.uploaded_at
                        ? new Date(previewUpload.uploaded_at).toLocaleString()
                        : 'Upload time unavailable'}{' '}
                      • {previewUpload.status}
                    </p>
                    {previewUpload.tags && previewUpload.tags.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {previewUpload.tags.map((tag) => (
                          <Badge
                            key={tag}
                            variant="secondary"
                            className="text-xs bg-white/20 text-white border-0"
                          >
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => setPreviewUploadIndex(null)}
                  >
                    Close
                  </Button>
                </div>
              </div>

              <div className="min-h-0 flex-1 flex items-center justify-center">
                <img
                  src={previewUpload.original_url}
                  alt="Uploaded media full preview"
                  className="max-h-full max-w-full rounded-lg object-contain"
                />
              </div>

              <div className="text-center text-sm text-white/50">
                {previewUploadIndex + 1} of {uploads.length} • Use ← → to navigate, ESC to close
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
