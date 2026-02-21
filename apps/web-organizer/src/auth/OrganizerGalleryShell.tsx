'use client';

import { MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Eye,
  Filter,
  Image,
  Loader2,
  RefreshCw,
  X
} from 'lucide-react';
import {
  ApiClientError,
  type EventDetail,
  type GalleryFacetItem,
  type GalleryItem
} from '@poveventcam/api-client';

import { organizerApi } from '../lib/organizer-api';
import { createZipBlob } from '../lib/zip';
import { useAuth } from './AuthProvider';
import { OrganizerHeader } from './OrganizerHeader';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface OrganizerGalleryShellProps {
  eventId: string;
}

interface DownloadProgressState {
  completed: number;
  total: number;
}

const PAGE_SIZE = 100;
const INITIAL_PAGE_LOAD = 30;
const DOWNLOAD_CONCURRENCY = 5;
const FACET_QUERY_LIMIT = 500;
const MAX_UPLOADER_FILTER_SELECTION = 50;
type GalleryFileTypeFilter = 'all' | 'image' | 'video';
type GallerySortBy = 'uploaded_at' | 'uploader' | 'tag';
type GallerySortOrder = 'asc' | 'desc';
type DownloadStatusFilter = 'all' | 'downloaded' | 'not_downloaded';

function extractErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    return `${error.code}: ${error.message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Request failed';
}

function bytesToHuman(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function compactDateForFile(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function sanitizeZipName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'event';
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runnerCount = Math.min(Math.max(concurrency, 1), items.length);

  await Promise.all(
    Array.from({ length: runnerCount }, async () => {
      for (; ;) {
        const currentIndex = cursor;
        cursor += 1;
        if (currentIndex >= items.length) {
          break;
        }
        await worker(items[currentIndex], currentIndex);
      }
    })
  );
}

export function OrganizerGalleryShell({ eventId }: OrganizerGalleryShellProps) {
  const { session, signOut } = useAuth();
  const aliveRef = useRef(true);
  const galleryRequestVersionRef = useRef(0);
  const facetRequestVersionRef = useRef(0);

  const [eventDetail, setEventDetail] = useState<EventDetail | null>(null);
  const [eventError, setEventError] = useState<string | null>(null);

  const [galleryItems, setGalleryItems] = useState<GalleryItem[]>([]);
  const [galleryTotalCount, setGalleryTotalCount] = useState(0);
  const [galleryPage, setGalleryPage] = useState(0);
  const [isGalleryLoading, setIsGalleryLoading] = useState(false);
  const [isPageEagerLoading, setIsPageEagerLoading] = useState(false);
  const [galleryError, setGalleryError] = useState<string | null>(null);

  const [filterFileTypeInput, setFilterFileTypeInput] = useState<GalleryFileTypeFilter>('all');
  const [filterDownloadStatusInput, setFilterDownloadStatusInput] = useState<DownloadStatusFilter>('all');
  const [uploaderFacetSearchInput, setUploaderFacetSearchInput] = useState('');
  const [tagFacetSearchInput, setTagFacetSearchInput] = useState('');
  const [isUploaderFacetDropdownOpen, setIsUploaderFacetDropdownOpen] = useState(false);
  const [isTagFacetDropdownOpen, setIsTagFacetDropdownOpen] = useState(false);
  const [selectedUploaderFilters, setSelectedUploaderFilters] = useState<string[]>([]);
  const [selectedTagFilters, setSelectedTagFilters] = useState<string[]>([]);
  const [uploaderFacetOptions, setUploaderFacetOptions] = useState<GalleryFacetItem[]>([]);
  const [tagFacetOptions, setTagFacetOptions] = useState<GalleryFacetItem[]>([]);
  const [isFacetsLoading, setIsFacetsLoading] = useState(false);
  const [hasFacetCacheLoaded, setHasFacetCacheLoaded] = useState(false);
  const [facetsError, setFacetsError] = useState<string | null>(null);
  const [activeFilterUploaders, setActiveFilterUploaders] = useState<string[]>([]);
  const [activeFilterTags, setActiveFilterTags] = useState<string[]>([]);
  const [activeFilterFileType, setActiveFilterFileType] = useState<'image' | 'video' | ''>('');
  const [activeFilterDownloadStatus, setActiveFilterDownloadStatus] = useState<DownloadStatusFilter>('all');
  const [isFilterDialogOpen, setIsFilterDialogOpen] = useState(false);

  const [activeSortBy, setActiveSortBy] = useState<GallerySortBy>('uploaded_at');
  const [activeSortOrder, setActiveSortOrder] = useState<GallerySortOrder>('desc');
  const [sortByInput, setSortByInput] = useState<GallerySortBy>('uploaded_at');
  const [sortOrderInput, setSortOrderInput] = useState<GallerySortOrder>('desc');
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);

  const [downloadedMediaIds, setDownloadedMediaIds] = useState<Set<string>>(new Set());

  const [selectedMediaIds, setSelectedMediaIds] = useState<Set<string>>(new Set());

  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [isPreviewDownloading, setIsPreviewDownloading] = useState(false);

  const [isBatchDownloading, setIsBatchDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressState | null>(null);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const sortMenuRef = useRef<HTMLDivElement | null>(null);
  const uploaderFacetDropdownRef = useRef<HTMLDivElement | null>(null);
  const tagFacetDropdownRef = useRef<HTMLDivElement | null>(null);

  const heading = useMemo(() => {
    if (!eventDetail) return 'Image Gallery';
    return `${eventDetail.name}`;
  }, [eventDetail]);

  const currentOffset = galleryPage * PAGE_SIZE;
  const currentPageAvailableCount = useMemo(() => {
    const remaining = galleryTotalCount - currentOffset;
    if (remaining <= 0) return 0;
    return Math.min(PAGE_SIZE, remaining);
  }, [currentOffset, galleryTotalCount]);

  const pageCount = useMemo(() => {
    if (galleryTotalCount <= 0) return 1;
    return Math.ceil(galleryTotalCount / PAGE_SIZE);
  }, [galleryTotalCount]);

  const visibleGalleryItems = useMemo(() => {
    if (activeFilterDownloadStatus === 'all') {
      return galleryItems;
    }
    if (activeFilterDownloadStatus === 'downloaded') {
      return galleryItems.filter((item) => downloadedMediaIds.has(item.media_id));
    }
    return galleryItems.filter((item) => !downloadedMediaIds.has(item.media_id));
  }, [activeFilterDownloadStatus, downloadedMediaIds, galleryItems]);

  const previewItem = useMemo(() => {
    if (previewIndex === null || previewIndex < 0 || previewIndex >= visibleGalleryItems.length) {
      return null;
    }
    return visibleGalleryItems[previewIndex];
  }, [previewIndex, visibleGalleryItems]);

  const selectedVisibleCount = useMemo(() => {
    return visibleGalleryItems.reduce(
      (count, item) => (selectedMediaIds.has(item.media_id) ? count + 1 : count),
      0
    );
  }, [selectedMediaIds, visibleGalleryItems]);

  const allVisibleSelected =
    visibleGalleryItems.length > 0 && selectedVisibleCount === visibleGalleryItems.length;
  const hasSelection = selectedMediaIds.size > 0;
  const hasActiveFilters = Boolean(
    activeFilterUploaders.length > 0 ||
    activeFilterTags.length > 0 ||
    activeFilterFileType ||
    activeFilterDownloadStatus !== 'all'
  );
  const filteredUploaderFacetOptions = useMemo(() => {
    const search = uploaderFacetSearchInput.trim().toLowerCase();
    if (!search) {
      return uploaderFacetOptions;
    }
    return uploaderFacetOptions.filter((option) => option.value.toLowerCase().includes(search));
  }, [uploaderFacetOptions, uploaderFacetSearchInput]);
  const filteredTagFacetOptions = useMemo(() => {
    const search = tagFacetSearchInput.trim().toLowerCase();
    if (!search) {
      return tagFacetOptions;
    }
    return tagFacetOptions.filter((option) => option.value.toLowerCase().includes(search));
  }, [tagFacetOptions, tagFacetSearchInput]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (previewIndex === null) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setPreviewIndex(null);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setPreviewIndex((prev) => (prev !== null && prev > 0 ? prev - 1 : prev));
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        setPreviewIndex((prev) =>
          prev !== null && prev < visibleGalleryItems.length - 1 ? prev + 1 : prev
        );
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [previewIndex, visibleGalleryItems.length]);

  useEffect(() => {
    if (previewIndex !== null) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [previewIndex]);

  useEffect(() => {
    if (!isSortMenuOpen) return;

    function handlePointerDown(event: globalThis.MouseEvent) {
      if (!sortMenuRef.current) return;
      const target = event.target as Node | null;
      if (target && !sortMenuRef.current.contains(target)) {
        setIsSortMenuOpen(false);
      }
    }

    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [isSortMenuOpen]);

  useEffect(() => {
    if (!isUploaderFacetDropdownOpen && !isTagFacetDropdownOpen) return;

    function handlePointerDown(event: globalThis.MouseEvent) {
      const target = event.target as Node | null;
      if (!target) return;

      if (
        isUploaderFacetDropdownOpen &&
        uploaderFacetDropdownRef.current &&
        !uploaderFacetDropdownRef.current.contains(target)
      ) {
        setIsUploaderFacetDropdownOpen(false);
      }

      if (
        isTagFacetDropdownOpen &&
        tagFacetDropdownRef.current &&
        !tagFacetDropdownRef.current.contains(target)
      ) {
        setIsTagFacetDropdownOpen(false);
      }
    }

    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [isTagFacetDropdownOpen, isUploaderFacetDropdownOpen]);

  const loadGalleryFacets = useCallback(
    async (params?: { uploaderQuery?: string; tagQuery?: string }) => {
      const requestVersion = facetRequestVersionRef.current + 1;
      facetRequestVersionRef.current = requestVersion;
      setIsFacetsLoading(true);
      setFacetsError(null);

      try {
        const response = await organizerApi.getGalleryFacets(eventId, {
          limit: FACET_QUERY_LIMIT,
          uploader_q: params?.uploaderQuery || undefined,
          tag_q: params?.tagQuery || undefined
        });

        if (!aliveRef.current || requestVersion !== facetRequestVersionRef.current) {
          return;
        }

        setUploaderFacetOptions(response.uploaders);
        setTagFacetOptions(response.tags);
        setHasFacetCacheLoaded(true);
      } catch (nextError) {
        if (!aliveRef.current || requestVersion !== facetRequestVersionRef.current) {
          return;
        }
        setFacetsError(extractErrorMessage(nextError));
      } finally {
        if (requestVersion === facetRequestVersionRef.current) {
          setIsFacetsLoading(false);
        }
      }
    },
    [eventId]
  );

  const loadEvent = useCallback(async () => {
    setEventError(null);
    try {
      const payload = await organizerApi.getEvent(eventId);
      if (!aliveRef.current) return;
      setEventDetail(payload.event);
    } catch (nextError) {
      if (!aliveRef.current) return;
      setEventError(extractErrorMessage(nextError));
    }
  }, [eventId]);

  const loadGalleryPage = useCallback(
    async (pageIndex: number) => {
      const requestVersion = galleryRequestVersionRef.current + 1;
      galleryRequestVersionRef.current = requestVersion;
      setIsGalleryLoading(true);
      setGalleryError(null);
      setDownloadError(null);
      setDownloadMessage(null);

      try {
        const offset = pageIndex * PAGE_SIZE;
        const response = await organizerApi.getGallery(eventId, {
          cursor: String(offset),
          limit: INITIAL_PAGE_LOAD,
          sort: activeSortBy === 'uploaded_at' ? (activeSortOrder === 'asc' ? 'oldest' : 'newest') : undefined,
          sort_by: activeSortBy,
          sort_order: activeSortOrder,
          filter_uploader: activeFilterUploaders.length > 0 ? activeFilterUploaders.join(',') : undefined,
          filter_tag: activeFilterTags.length > 0 ? activeFilterTags.join(',') : undefined,
          filter_file_type: activeFilterFileType || undefined
        });

        if (!aliveRef.current || requestVersion !== galleryRequestVersionRef.current) {
          return;
        }

        const maxPage = response.total_count > 0 ? Math.ceil(response.total_count / PAGE_SIZE) - 1 : 0;
        if (pageIndex > maxPage) {
          setGalleryPage(maxPage);
          return;
        }

        setGalleryItems(response.media);
        setGalleryTotalCount(response.total_count);
        setSelectedMediaIds(new Set());
        setPreviewIndex(null);
      } catch (nextError) {
        if (!aliveRef.current || requestVersion !== galleryRequestVersionRef.current) {
          return;
        }
        setGalleryError(extractErrorMessage(nextError));
      } finally {
        if (requestVersion === galleryRequestVersionRef.current) {
          setIsGalleryLoading(false);
          setIsPageEagerLoading(false);
        }
      }
    },
    [activeFilterFileType, activeFilterTags, activeFilterUploaders, activeSortBy, activeSortOrder, eventId]
  );

  const loadRemainingForCurrentPage = useCallback(async (): Promise<GalleryItem[]> => {
    if (isPageEagerLoading || isGalleryLoading) {
      return galleryItems;
    }

    const currentRequestVersion = galleryRequestVersionRef.current;
    const offset = galleryPage * PAGE_SIZE;
    const targetCount = Math.min(PAGE_SIZE, Math.max(0, galleryTotalCount - offset));
    if (targetCount <= 0 || galleryItems.length >= targetCount) {
      return galleryItems;
    }

    setIsPageEagerLoading(true);
    setGalleryError(null);

    try {
      const response = await organizerApi.getGallery(eventId, {
        cursor: String(offset + galleryItems.length),
        limit: targetCount - galleryItems.length,
        sort: activeSortBy === 'uploaded_at' ? (activeSortOrder === 'asc' ? 'oldest' : 'newest') : undefined,
        sort_by: activeSortBy,
        sort_order: activeSortOrder,
        filter_uploader: activeFilterUploaders.length > 0 ? activeFilterUploaders.join(',') : undefined,
        filter_tag: activeFilterTags.length > 0 ? activeFilterTags.join(',') : undefined,
        filter_file_type: activeFilterFileType || undefined
      });

      if (!aliveRef.current || currentRequestVersion !== galleryRequestVersionRef.current) {
        return galleryItems;
      }

      const existingIds = new Set(galleryItems.map((item) => item.media_id));
      const merged = [
        ...galleryItems,
        ...response.media.filter((item) => !existingIds.has(item.media_id))
      ];

      setGalleryItems(merged);
      setGalleryTotalCount(response.total_count);
      return merged;
    } catch (nextError) {
      if (aliveRef.current && currentRequestVersion === galleryRequestVersionRef.current) {
        setGalleryError(extractErrorMessage(nextError));
      }
      return galleryItems;
    } finally {
      if (currentRequestVersion === galleryRequestVersionRef.current) {
        setIsPageEagerLoading(false);
      }
    }
  }, [
    activeFilterFileType,
    activeFilterTags,
    activeFilterUploaders,
    activeSortBy,
    activeSortOrder,
    eventId,
    galleryItems,
    galleryPage,
    galleryTotalCount,
    isGalleryLoading,
    isPageEagerLoading
  ]);

  useEffect(() => {
    void loadEvent();
  }, [loadEvent]);

  useEffect(() => {
    void loadGalleryPage(galleryPage);
  }, [galleryPage, loadGalleryPage]);

  useEffect(() => {
    if (!isFilterDialogOpen || hasFacetCacheLoaded || isFacetsLoading) {
      return;
    }
    void loadGalleryFacets();
  }, [hasFacetCacheLoaded, isFacetsLoading, isFilterDialogOpen, loadGalleryFacets]);

  useEffect(() => {
    if (isGalleryLoading || isPageEagerLoading) return;
    if (galleryItems.length === 0) return;
    if (galleryItems.length >= currentPageAvailableCount) return;

    function maybeEagerLoad() {
      const nearBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 600;
      if (nearBottom) {
        void loadRemainingForCurrentPage();
      }
    }

    window.addEventListener('scroll', maybeEagerLoad, { passive: true });
    maybeEagerLoad();
    return () => window.removeEventListener('scroll', maybeEagerLoad);
  }, [
    currentPageAvailableCount,
    galleryItems.length,
    isGalleryLoading,
    isPageEagerLoading,
    loadRemainingForCurrentPage
  ]);

  function handleApplyFilters() {
    setActiveFilterUploaders(selectedUploaderFilters);
    setActiveFilterTags(selectedTagFilters);
    setActiveFilterFileType(filterFileTypeInput === 'all' ? '' : filterFileTypeInput);
    setActiveFilterDownloadStatus(filterDownloadStatusInput);
    setSelectedMediaIds(new Set());
    setPreviewIndex(null);
    setIsUploaderFacetDropdownOpen(false);
    setIsTagFacetDropdownOpen(false);
    setIsFilterDialogOpen(false);
    setGalleryPage(0);
  }

  function handleResetFilters() {
    setFilterFileTypeInput('all');
    setFilterDownloadStatusInput('all');
    setUploaderFacetSearchInput('');
    setTagFacetSearchInput('');
    setSelectedUploaderFilters([]);
    setSelectedTagFilters([]);
    setActiveFilterUploaders([]);
    setActiveFilterTags([]);
    setActiveFilterFileType('');
    setActiveFilterDownloadStatus('all');
    setSelectedMediaIds(new Set());
    setPreviewIndex(null);
    setIsUploaderFacetDropdownOpen(false);
    setIsTagFacetDropdownOpen(false);
    setIsFilterDialogOpen(false);
    setGalleryPage(0);
  }

  function toggleSelectedUploaderFilter(name: string) {
    const normalized = name.trim();
    if (!normalized) return;

    setSelectedUploaderFilters((current) => {
      const exists = current.some((value) => value.toLowerCase() === normalized.toLowerCase());
      if (exists) {
        return current.filter((value) => value.toLowerCase() !== normalized.toLowerCase());
      }
      if (current.length >= MAX_UPLOADER_FILTER_SELECTION) {
        return current;
      }
      return [...current, normalized];
    });
  }

  function toggleSelectedTagFilter(tag: string) {
    setSelectedTagFilters((current) => {
      if (current.includes(tag)) {
        return current.filter((value) => value !== tag);
      }
      return [...current, tag];
    });
  }

  function handleSortChange() {
    setActiveSortBy(sortByInput);
    setActiveSortOrder(sortOrderInput);
    setIsSortMenuOpen(false);
    setGalleryPage(0);
  }

  function invalidateFacetCache() {
    setHasFacetCacheLoaded(false);
    setFacetsError(null);
    setUploaderFacetOptions([]);
    setTagFacetOptions([]);
    setUploaderFacetSearchInput('');
    setTagFacetSearchInput('');
    setIsUploaderFacetDropdownOpen(false);
    setIsTagFacetDropdownOpen(false);
  }

  function handleRefreshGallery() {
    invalidateFacetCache();
    void loadGalleryPage(galleryPage);
    if (isFilterDialogOpen) {
      void loadGalleryFacets();
    }
  }

  function toggleSelectMedia(mediaId: string) {
    setSelectedMediaIds((previous) => {
      const next = new Set(previous);
      if (next.has(mediaId)) {
        next.delete(mediaId);
      } else {
        next.add(mediaId);
      }
      return next;
    });
  }

  async function toggleSelectAllCurrentPage() {
    if (allVisibleSelected) {
      setSelectedMediaIds(new Set());
      return;
    }

    const loadedItems =
      galleryItems.length < currentPageAvailableCount
        ? await loadRemainingForCurrentPage()
        : galleryItems;

    const selectableItems =
      activeFilterDownloadStatus === 'all'
        ? loadedItems
        : activeFilterDownloadStatus === 'downloaded'
          ? loadedItems.filter((item) => downloadedMediaIds.has(item.media_id))
          : loadedItems.filter((item) => !downloadedMediaIds.has(item.media_id));
    setSelectedMediaIds(new Set(selectableItems.map((item) => item.media_id)));
  }

  function clearSelection() {
    setSelectedMediaIds(new Set());
  }

  async function handleDownloadMedia(mediaId: string, isPreview = false) {
    if (isPreview) {
      setIsPreviewDownloading(true);
    }
    setGalleryError(null);

    try {
      const payload = await organizerApi.getMediaDownloadUrl(eventId, mediaId);
      window.open(payload.download_url, '_blank', 'noopener,noreferrer');
      setDownloadedMediaIds((previous) => {
        const next = new Set(previous);
        next.add(mediaId);
        return next;
      });
    } catch (nextError) {
      setGalleryError(extractErrorMessage(nextError));
    } finally {
      if (isPreview) {
        setIsPreviewDownloading(false);
      }
    }
  }

  async function handleDownloadSelected() {
    if (!selectedMediaIds.size) return;
    if (selectedMediaIds.size > PAGE_SIZE) {
      setDownloadError(`You can only download up to ${PAGE_SIZE} images at once.`);
      return;
    }

    setIsBatchDownloading(true);
    setDownloadError(null);
    setDownloadMessage(null);
    setDownloadProgress({
      completed: 0,
      total: selectedMediaIds.size
    });

    const selectedIds = Array.from(selectedMediaIds);
    const zipEntries: Array<{ fileName: string; data: Uint8Array }> = [];
    const successfulIds: string[] = [];
    const failedIds: string[] = [];

    try {
      const payload = await organizerApi.getMediaDownloadUrls(eventId, {
        media_ids: selectedIds
      });

      setDownloadProgress({
        completed: 0,
        total: payload.items.length
      });

      await runWithConcurrency(payload.items, DOWNLOAD_CONCURRENCY, async (item) => {
        try {
          const response = await fetch(item.download_url);
          if (!response.ok) {
            throw new Error(`Failed (${response.status})`);
          }

          const blob = await response.blob();
          const data = new Uint8Array(await blob.arrayBuffer());
          zipEntries.push({
            fileName: item.file_name,
            data
          });
          successfulIds.push(item.media_id);
        } catch (_error) {
          failedIds.push(item.media_id);
        } finally {
          setDownloadProgress((current) => {
            if (!current) return current;
            return {
              total: current.total,
              completed: Math.min(current.completed + 1, current.total)
            };
          });
        }
      });

      if (!successfulIds.length) {
        throw new Error('No files were downloaded. Please retry.');
      }

      setDownloadMessage('Packaging zip file...');
      const zipBlob = createZipBlob(zipEntries);

      const link = document.createElement('a');
      const downloadUrl = URL.createObjectURL(zipBlob);
      const eventSlug = sanitizeZipName(eventDetail?.slug ?? eventId);
      link.href = downloadUrl;
      link.download = `${eventSlug}-page-${galleryPage + 1}-${compactDateForFile()}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(downloadUrl);

      setDownloadedMediaIds((previous) => {
        const next = new Set(previous);
        for (const mediaId of successfulIds) {
          next.add(mediaId);
        }
        return next;
      });
      setSelectedMediaIds(new Set());

      if (failedIds.length > 0) {
        setDownloadMessage(`Downloaded ${successfulIds.length}/${payload.items.length}. ${failedIds.length} failed.`);
      } else {
        setDownloadMessage(`Downloaded ${successfulIds.length} image(s).`);
      }
    } catch (nextError) {
      setDownloadError(extractErrorMessage(nextError));
    } finally {
      setIsBatchDownloading(false);
      setDownloadProgress(null);
    }
  }

  function goToPreviousPage() {
    if (galleryPage <= 0) return;
    setGalleryPage((current) => Math.max(0, current - 1));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function goToNextPage() {
    if (galleryPage >= pageCount - 1) return;
    setGalleryPage((current) => Math.min(pageCount - 1, current + 1));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function handleTouchStart(mediaId: string) {
    longPressTriggeredRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      toggleSelectMedia(mediaId);
      if (navigator.vibrate) {
        navigator.vibrate(50);
      }
    }, 500);
  }

  function handleTouchEnd() {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function handleTouchMove() {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function handleImageClick(index: number, mediaId: string) {
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false;
      return;
    }

    if (hasSelection) {
      toggleSelectMedia(mediaId);
      return;
    }
    setPreviewIndex(index);
  }

  function handlePreviewClick(event: MouseEvent, index: number) {
    event.stopPropagation();
    setPreviewIndex(index);
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <OrganizerHeader
        title={heading}
        backHref="/"
        backLabel="Dashboard"
        userEmail={session?.user.email}
        userName={session?.user.user_metadata?.name ?? session?.user.user_metadata?.full_name}
        onSignOut={signOut}
      />

      <div className="mx-auto max-w-7xl space-y-6 px-4 py-6">
        {eventError && (
          <Alert variant="destructive">
            <AlertDescription>{eventError}</AlertDescription>
          </Alert>
        )}

        <Card className="mb-2">
          <CardHeader className="pb-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Image className="h-5 w-5" />
                  Gallery
                </CardTitle>
                <CardDescription>
                  {galleryTotalCount} image(s) • Page {galleryPage + 1} of {pageCount}
                </CardDescription>
              </div>
              <div ref={sortMenuRef} className="relative flex w-full flex-wrap gap-2 sm:w-auto">
                <Button
                  type="button"
                  variant="outline"
                  className="min-w-28"
                  onClick={() => {
                    setSelectedTagFilters(activeFilterTags);
                    setSelectedUploaderFilters(activeFilterUploaders);
                    setFilterDownloadStatusInput(activeFilterDownloadStatus);
                    setFilterFileTypeInput(activeFilterFileType || 'all');
                    setUploaderFacetSearchInput('');
                    setTagFacetSearchInput('');
                    setIsFilterDialogOpen(true);
                  }}
                >
                  <Filter className="h-4 w-4" />
                  Filter
                </Button>

                <Button
                  type="button"
                  variant="outline"
                  className="min-w-28"
                  onClick={() => {
                    setSortByInput(activeSortBy);
                    setSortOrderInput(activeSortOrder);
                    setIsSortMenuOpen((current) => !current);
                  }}
                >
                  <ArrowUpDown className="h-4 w-4" />
                  Sort
                </Button>

                <Button
                  variant="outline"
                  onClick={handleRefreshGallery}
                  disabled={isGalleryLoading}
                >
                  <RefreshCw className={`h-4 w-4 ${isGalleryLoading ? 'animate-spin' : ''}`} />
                </Button>

                {isSortMenuOpen && (
                  <div className="absolute right-0 top-[calc(100%+0.5rem)] z-30 w-full rounded-lg border bg-popover p-3 shadow-md sm:w-72">
                    <div className="space-y-3">
                      <div className="space-y-1">
                        <Label htmlFor="sort-by">Sort by</Label>
                        <Select
                          value={sortByInput}
                          onValueChange={(value: string) => setSortByInput(value as GallerySortBy)}
                        >
                          <SelectTrigger id="sort-by">
                            <SelectValue placeholder="Sort by" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="uploaded_at">Uploaded date</SelectItem>
                            <SelectItem value="uploader">Guest name</SelectItem>
                            <SelectItem value="tag">Tag</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="sort-direction">Order</Label>
                        <Select
                          value={sortOrderInput}
                          onValueChange={(value: string) => setSortOrderInput(value as GallerySortOrder)}
                        >
                          <SelectTrigger id="sort-direction">
                            <SelectValue placeholder="Order" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="desc">Descending</SelectItem>
                            <SelectItem value="asc">Ascending</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid grid-cols-2 gap-2 pt-1">
                        <Button type="button" variant="outline" size="sm" onClick={() => setIsSortMenuOpen(false)}>
                          Cancel
                        </Button>
                        <Button type="button" size="sm" onClick={handleSortChange}>
                          Apply
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </CardHeader>

        </Card>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {activeFilterUploaders.slice(0, 3).map((uploader) => (
              <Badge key={uploader} variant="secondary">
                Uploader: {uploader}
              </Badge>
            ))}
            {activeFilterUploaders.length > 3 && (
              <Badge variant="outline">+{activeFilterUploaders.length - 3} more uploaders</Badge>
            )}
            {activeFilterTags.slice(0, 3).map((tag) => (
              <Badge key={tag} variant="secondary">
                Tag: {tag}
              </Badge>
            ))}
            {activeFilterTags.length > 3 && (
              <Badge variant="outline">+{activeFilterTags.length - 3} more tags</Badge>
            )}
            {activeFilterFileType && <Badge variant="secondary">Type: {activeFilterFileType}</Badge>}
            {activeFilterDownloadStatus !== 'all' && (
              <Badge variant="secondary">
                Download Status: {activeFilterDownloadStatus === 'downloaded' ? 'Downloaded' : 'Not Downloaded'}
              </Badge>
            )}
            <Badge variant="outline">
              Sort: {activeSortBy === 'uploaded_at' ? 'Uploaded date' : activeSortBy === 'uploader' ? 'Guest name' : 'Tag'}{' '}
              ({activeSortOrder === 'asc' ? 'asc' : 'desc'})
            </Badge>
          </div>

          {downloadProgress && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Downloading {downloadProgress.completed}/{downloadProgress.total}...
              </p>
              <div className="h-2 w-full rounded-full bg-muted">
                <div
                  className="h-2 rounded-full bg-primary transition-all"
                  style={{
                    width: `${Math.max(
                      4,
                      Math.round((downloadProgress.completed / Math.max(downloadProgress.total, 1)) * 100)
                    )}%`
                  }}
                />
              </div>
            </div>
          )}

          {downloadMessage && (
            <Alert variant="info">
              <AlertDescription>{downloadMessage}</AlertDescription>
            </Alert>
          )}
          {downloadError && (
            <Alert variant="destructive">
              <AlertDescription>{downloadError}</AlertDescription>
            </Alert>
          )}
        </div>

        <Dialog
          open={isFilterDialogOpen}
          onOpenChange={(open: boolean) => {
            setIsFilterDialogOpen(open);
            if (!open) {
              setIsUploaderFacetDropdownOpen(false);
              setIsTagFacetDropdownOpen(false);
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Filter gallery</DialogTitle>
              <DialogDescription>
                Filter by tags, guest name, file type, and download status.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-1">
                <Label>Guest name</Label>
                <div className="relative" ref={uploaderFacetDropdownRef}>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-between"
                    onClick={() => {
                      setIsUploaderFacetDropdownOpen((current) => {
                        const next = !current;
                        if (next) {
                          setIsTagFacetDropdownOpen(false);
                        }
                        return next;
                      });
                    }}
                  >
                    <span className="truncate">
                      {selectedUploaderFilters.length > 0
                        ? `(${selectedUploaderFilters.length}/${MAX_UPLOADER_FILTER_SELECTION} selected)`
                        : 'Select guest names'}
                    </span>
                    <ChevronDown
                      className={`h-4 w-4 text-muted-foreground transition-transform ${isUploaderFacetDropdownOpen ? 'rotate-180' : ''}`}
                    />
                  </Button>

                  {isUploaderFacetDropdownOpen && (
                    <div className="absolute left-0 right-0 top-full z-50 mt-1 space-y-2 rounded-md border bg-background p-2 shadow-md">
                      <Input
                        id="filter-uploader-search"
                        type="text"
                        placeholder="Search guest names..."
                        value={uploaderFacetSearchInput}
                        onChange={(next) => setUploaderFacetSearchInput(next.target.value)}
                      />
                      <div className="max-h-44 space-y-1 overflow-y-auto">
                        {isFacetsLoading && filteredUploaderFacetOptions.length === 0 ? (
                          <p className="text-sm text-muted-foreground">Loading guest options...</p>
                        ) : filteredUploaderFacetOptions.length > 0 ? (
                          filteredUploaderFacetOptions.map((option) => {
                            const isSelected = selectedUploaderFilters.some(
                              (value) => value.toLowerCase() === option.value.toLowerCase()
                            );
                            const disableNewSelection =
                              !isSelected &&
                              selectedUploaderFilters.length >= MAX_UPLOADER_FILTER_SELECTION;
                            return (
                              <button
                                key={option.value}
                                type="button"
                                className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent ${isSelected ? 'bg-accent' : ''} ${disableNewSelection ? 'cursor-not-allowed opacity-50 hover:bg-transparent' : ''}`}
                                onClick={() => toggleSelectedUploaderFilter(option.value)}
                                disabled={disableNewSelection}
                              >
                                <span className="mr-2 flex h-4 w-4 items-center justify-center">
                                  {isSelected ? <Check className="h-4 w-4 text-primary" /> : null}
                                </span>
                                <span className="flex-1 truncate">{option.value}</span>
                                <span className="ml-2 text-xs text-muted-foreground">{option.count}</span>
                              </button>
                            );
                          })
                        ) : (
                          <p className="text-sm text-muted-foreground">No matching guest names found.</p>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        ({selectedUploaderFilters.length}/{MAX_UPLOADER_FILTER_SELECTION} selected)
                      </p>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {selectedUploaderFilters.length > 0 ? (
                    selectedUploaderFilters.map((name) => (
                      <Badge key={name} variant="secondary" className="gap-1">
                        {name}
                        <button
                          type="button"
                          className="rounded-sm p-0.5 hover:bg-black/10"
                          onClick={() => toggleSelectedUploaderFilter(name)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">No guest selected.</p>
                  )}
                </div>

                {facetsError && (
                  <p className="text-xs text-destructive">{facetsError}</p>
                )}
              </div>

              <div className="space-y-1">
                <Label>Tags</Label>
                <div className="relative" ref={tagFacetDropdownRef}>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-between"
                    onClick={() => {
                      setIsTagFacetDropdownOpen((current) => {
                        const next = !current;
                        if (next) {
                          setIsUploaderFacetDropdownOpen(false);
                        }
                        return next;
                      });
                    }}
                  >
                    <span className="truncate">
                      {selectedTagFilters.length > 0
                        ? `${selectedTagFilters.length} tag${selectedTagFilters.length > 1 ? 's' : ''} selected`
                        : 'Select tags'}
                    </span>
                    <ChevronDown
                      className={`h-4 w-4 text-muted-foreground transition-transform ${isTagFacetDropdownOpen ? 'rotate-180' : ''}`}
                    />
                  </Button>

                  {isTagFacetDropdownOpen && (
                    <div className="absolute left-0 right-0 top-full z-50 mt-1 space-y-2 rounded-md border bg-background p-2 shadow-md">
                    <Input
                      id="filter-tag-search"
                      type="text"
                      placeholder="Search tags..."
                      value={tagFacetSearchInput}
                      onChange={(next) => setTagFacetSearchInput(next.target.value)}
                    />
                    <div className="max-h-44 space-y-1 overflow-y-auto">
                        {isFacetsLoading && filteredTagFacetOptions.length === 0 ? (
                          <p className="text-sm text-muted-foreground">Loading tag options...</p>
                        ) : filteredTagFacetOptions.length > 0 ? (
                          filteredTagFacetOptions.map((option) => {
                            const isSelected = selectedTagFilters.includes(option.value);
                            return (
                              <button
                                key={option.value}
                                type="button"
                                className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent ${isSelected ? 'bg-accent' : ''}`}
                                onClick={() => toggleSelectedTagFilter(option.value)}
                              >
                                <span className="mr-2 flex h-4 w-4 items-center justify-center">
                                  {isSelected ? <Check className="h-4 w-4 text-primary" /> : null}
                                </span>
                                <span className="flex-1 truncate">{option.value}</span>
                                <span className="ml-2 text-xs text-muted-foreground">{option.count}</span>
                              </button>
                            );
                          })
                        ) : (
                          <p className="text-sm text-muted-foreground">No matching tags found.</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap gap-1">
                  {selectedTagFilters.length > 0 ? (
                    selectedTagFilters.map((tag) => (
                      <Badge key={tag} variant="secondary" className="gap-1">
                        {tag}
                        <button
                          type="button"
                          className="rounded-sm p-0.5 hover:bg-black/10"
                          onClick={() => toggleSelectedTagFilter(tag)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">No tags selected.</p>
                  )}
                </div>

                {facetsError && (
                  <p className="text-xs text-destructive">{facetsError}</p>
                )}
              </div>

              <div className="space-y-1">
                <Label htmlFor="filter-file-type">File type</Label>
                <Select
                  value={filterFileTypeInput}
                  onValueChange={(value: string) => setFilterFileTypeInput(value as GalleryFileTypeFilter)}
                >
                  <SelectTrigger id="filter-file-type">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="image">Image</SelectItem>
                    <SelectItem value="video">Video</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label htmlFor="filter-download-status">Download Status</Label>
                <Select
                  value={filterDownloadStatusInput}
                  onValueChange={(value: string) => setFilterDownloadStatusInput(value as DownloadStatusFilter)}
                >
                  <SelectTrigger id="filter-download-status">
                    <SelectValue placeholder="Select download status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Show All</SelectItem>
                    <SelectItem value="downloaded">Downloaded</SelectItem>
                    <SelectItem value="not_downloaded">Not Downloaded</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleResetFilters}>
                Clear filters
              </Button>
              <Button onClick={handleApplyFilters}>Apply filters</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {galleryError && (
          <Alert variant="destructive">
            <AlertDescription>{galleryError}</AlertDescription>
          </Alert>
        )}

        {isGalleryLoading && galleryItems.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : visibleGalleryItems.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Image className="mx-auto h-12 w-12 text-muted-foreground/50" />
              {activeFilterDownloadStatus !== 'all' && galleryItems.length > 0 ? (
                <p className="mt-4 text-muted-foreground">
                  No images match the selected download status on this page.
                </p>
              ) : (
                <p className="mt-4 text-muted-foreground">
                  No images found {hasActiveFilters ? 'for this filter' : 'yet'}.
                </p>
              )}
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-1">
              <div className="flex flex-wrap gap-1">
                {hasSelection && (
                  <>
                    <Button
                      size="sm"
                      onClick={() => void handleDownloadSelected()}
                      disabled={isBatchDownloading}
                    >
                      {isBatchDownloading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4" />
                      )}
                      Download Selected ({selectedMediaIds.size})
                    </Button>
                    <Button className="" variant="ghost" size="sm" onClick={clearSelection}>
                      <X className="h-4 w-4" />
                      Clear
                    </Button>
                  </>
                )}
              </div>
              {visibleGalleryItems.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => void toggleSelectAllCurrentPage()}>
                  <Check className="h-4 w-4" />
                  {allVisibleSelected ? 'Deselect All' : 'Select All'}
                </Button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {visibleGalleryItems.map((item, index) => {
                const isSelected = selectedMediaIds.has(item.media_id);
                const isDownloaded = downloadedMediaIds.has(item.media_id);
                const tags = item.tags ?? [];
                return (
                  <Card
                    key={item.media_id}
                    className={`group cursor-pointer overflow-hidden transition-all ${isSelected ? 'ring-2 ring-primary ring-offset-2' : ''
                      }`}
                  >
                    <div
                      className="relative aspect-square select-none bg-muted"
                      onClick={() => handleImageClick(index, item.media_id)}
                      onTouchStart={() => handleTouchStart(item.media_id)}
                      onTouchEnd={handleTouchEnd}
                      onTouchMove={handleTouchMove}
                      onTouchCancel={handleTouchEnd}
                    >
                      <img
                        src={item.thumb_url}
                        alt="Event upload preview"
                        loading="lazy"
                        draggable={false}
                        className="h-full w-full object-cover transition-transform group-hover:scale-105"
                        onError={(event) => {
                          const image = event.currentTarget;
                          if (image.dataset.originalFallbackApplied === 'true') {
                            return;
                          }
                          image.dataset.originalFallbackApplied = 'true';
                          image.src = item.original_url;
                        }}
                      />
                      {hasSelection && <div className="pointer-events-none absolute inset-0 bg-black/20" />}

                      <div
                        className={`absolute left-2 top-2 transition-opacity ${isSelected || hasSelection ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                          }`}
                        onClick={(event) => event.stopPropagation()}
                        onTouchStart={(event) => event.stopPropagation()}
                      >
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleSelectMedia(item.media_id)}
                          className={`h-5 w-5 shadow-md data-[state=checked]:border-primary data-[state=checked]:bg-primary ${hasSelection ? 'border-2 border-gray-500 bg-white' : 'border-2 border-gray-400 bg-white/90'
                            }`}
                        />
                      </div>

                      {/* <button
                        className="absolute right-2 top-2 rounded-full bg-black/50 p-1.5 text-white opacity-0 transition-opacity hover:bg-black/70 active:bg-black/80 group-hover:opacity-100"
                        onClick={(event) => handlePreviewClick(event, index)}
                        onTouchStart={(event) => event.stopPropagation()}
                      >
                        <Eye className="h-4 w-4" />
                      </button> */}
                    </div>
                    <CardContent className="p-3">
                      <p className="truncate text-sm font-medium">{item.uploaded_by || 'Unknown'}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {new Date(item.uploaded_at).toLocaleDateString()}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{bytesToHuman(item.size_bytes)}</p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {isDownloaded && (
                          <Badge variant="success" className="text-xs py-0">
                            Downloaded
                          </Badge>
                        )}
                        {tags.slice(0, 2).map((tag) => (
                          <Badge key={tag} variant="secondary" className="text-xs py-0">
                            {tag}
                          </Badge>
                        ))}
                        {tags.length > 2 && (
                          <Badge variant="outline" className="text-xs py-0">
                            +{tags.length - 2}
                          </Badge>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            <div className="flex flex-col items-center justify-between gap-3 pt-4 sm:flex-row">
              <div className="text-sm text-muted-foreground">
                Loaded {galleryItems.length}/{currentPageAvailableCount || 0} on this page
                {isPageEagerLoading ? ' • Loading more...' : ''}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={goToPreviousPage} disabled={galleryPage === 0 || isGalleryLoading}>
                  <ChevronLeft className="h-4 w-4" />
                  Prev
                </Button>
                <div className="text-sm text-muted-foreground">
                  Page {galleryPage + 1} of {pageCount}
                </div>
                <Button
                  variant="outline"
                  onClick={goToNextPage}
                  disabled={galleryPage >= pageCount - 1 || isGalleryLoading}
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      {previewItem && previewIndex !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90" onClick={() => setPreviewIndex(null)}>
          {previewIndex > 0 && (
            <button
              className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full p-3 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
              onClick={(event) => {
                event.stopPropagation();
                setPreviewIndex(previewIndex - 1);
              }}
            >
              <ChevronLeft className="h-8 w-8" />
            </button>
          )}

          {previewIndex < visibleGalleryItems.length - 1 && (
            <button
              className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full p-3 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
              onClick={(event) => {
                event.stopPropagation();
                setPreviewIndex(previewIndex + 1);
              }}
            >
              <ChevronRight className="h-8 w-8" />
            </button>
          )}

          <div className="flex h-[92vh] w-full max-w-[96vw] flex-col gap-3 px-4" onClick={(event) => event.stopPropagation()}>
            <div className="sticky top-0 z-20 rounded-lg bg-white/10 px-4 py-3 text-white backdrop-blur-sm">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="truncate font-medium">{previewItem.uploaded_by || 'Unknown'}</p>
                  <p className="truncate text-sm text-white/70">
                    {new Date(previewItem.uploaded_at).toLocaleString()} • {bytesToHuman(previewItem.size_bytes)}
                  </p>
                  {(previewItem.tags ?? []).length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {(previewItem.tags ?? []).map((tag) => (
                        <Badge key={tag} variant="secondary" className="border-0 bg-white/20 text-xs text-white">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => window.open(previewItem.original_url, '_blank', 'noopener,noreferrer')}
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void handleDownloadMedia(previewItem.media_id, true)}
                    disabled={isPreviewDownloading}
                  >
                    {isPreviewDownloading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                    Download
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setPreviewIndex(null)}>
                    Close
                  </Button>
                </div>
              </div>
            </div>

            <div className="flex min-h-0 flex-1 items-center justify-center">
              <img
                src={previewItem.original_url}
                alt="Preview"
                className="max-h-full max-w-full rounded-lg object-contain"
              />
            </div>

            <div className="text-center text-sm text-white/50">
              {previewIndex + 1} of {visibleGalleryItems.length} • Use ← → to navigate, ESC to close
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
