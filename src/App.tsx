import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  FolderLock,
  Images,
  Lock,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Unlock,
  Upload,
} from 'lucide-react';
import type { MediaItem } from './types/media';
import { useTheme } from './hooks/useTheme';
import { useTelegramAuth } from './hooks/useTelegramAuth';
import { useChannelSelector } from './hooks/useChannelSelector';
import { usePhotoTimeline } from './hooks/usePhotoTimeline';
import { useUploader } from './hooks/useUploader';
import { useChannelVaults } from './hooks/useChannelVaults';
import { usePullToRefresh } from './hooks/usePullToRefresh';
import { describeError, telegramService } from './services/telegram/mtprotoClient';
import { filterMedia, groupTimeline } from './lib/timeline';
import { AuthScreen } from './components/AuthScreen';
import { AppNav, type AppView } from './components/AppNav';
import { TopBar } from './components/TopBar';
import { WhatsAppBackupView } from './components/WhatsAppBackupView';
import { PhotoGrid } from './components/PhotoGrid';
import { Lightbox } from './components/Lightbox';
import { ChannelSelectorModal } from './components/ChannelSelectorModal';
import { ChannelVaultBanner } from './components/ChannelVaultBanner';
import { SettingsModal } from './components/SettingsModal';
import { UploadPill } from './components/UploadPill';
import { Button } from './components/ui/Button';
import { SkeletonGrid, Spinner } from './components/ui/Spinner';
import { pruneShareCache, readSharedPayload } from './services/whatsapp/shareTarget';

const ENCRYPT_PREFERENCE_KEY = 'vaultphotos.encrypt';

const readEncryptPreference = (): boolean => {
  try {
    return localStorage.getItem(ENCRYPT_PREFERENCE_KEY) !== 'false';
  } catch {
    return true;
  }
};

interface EmptyPanelProps {
  readonly icon: ReactNode;
  readonly title: string;
  readonly body: ReactNode;
  readonly action?: ReactNode;
  readonly secondaryAction?: ReactNode;
}

function EmptyPanel({ icon, title, body, action, secondaryAction }: EmptyPanelProps) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 pb-24 pt-14 text-center sm:pt-24">
      <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-accent-soft to-surface text-accent">
        {icon}
      </div>
      <h2 className="text-xl font-semibold tracking-tight text-ink">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
      {action ? <div className="mt-6 flex flex-col items-center gap-2 sm:flex-row">{action}</div> : null}
      {secondaryAction ? <div className="mt-4">{secondaryAction}</div> : null}
      <div className="mt-8 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck size={12} /> Stays on your device
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Lock size={12} /> Encrypted vault
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Sparkles size={12} /> Location removed
        </span>
      </div>
    </div>
  );
}

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const auth = useTelegramAuth();
  const ready = auth.status === 'ready';
  const channels = useChannelSelector({ enabled: ready, accountId: auth.account?.id ?? null });

  const [viewChannelId, setViewChannelId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const [encryptUploads, setEncryptUploads] = useState(readEncryptPreference);
  const [dragging, setDragging] = useState(false);
  const [view, setView] = useState<AppView>('photos');
  const [sharedFiles, setSharedFiles] = useState<File[]>([]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const photosRef = useRef<HTMLElement | null>(null);
  const autoOpenedRef = useRef(false);
  const dragDepthRef = useRef(0);

  const timeline = usePhotoTimeline({
    channelIds: channels.selectedIds,
    enabled: ready && channels.selectedIds.length > 0,
  });

  const handleUploadsFinished = useCallback(() => {
    void timeline.reload();
  }, [timeline]);

  const uploader = useUploader(handleUploadsFinished);

  // Per-channel keys so a channel sealed on another device can decrypt here.
  const vaults = useChannelVaults({
    channelIds: channels.selectedIds,
    enabled: ready,
    profile: auth.profile,
  });

  useEffect(() => {
    if (vaults.version === 0) return;
    void timeline.resetScan();
  }, [timeline.resetScan, vaults.version]);


  const pull = usePullToRefresh(
    photosRef,
    () => {
      void timeline.resetScan();
    },
    ready && view === 'photos' && channels.selectedIds.length > 0,
  );

  const targetChannelId = viewChannelId ?? channels.selectedIds[0] ?? null;
  const backupChannelTitle =
    channels.channels.find((channel) => channel.id === targetChannelId)?.title ??
    (targetChannelId ? 'Selected channel' : null);

  const visibleItems = useMemo(() => {
    const filtered = filterMedia(timeline.items, query);
    return viewChannelId ? filtered.filter((item) => item.channelId === viewChannelId) : filtered;
  }, [query, timeline.items, viewChannelId]);

  const groups = useMemo(() => groupTimeline(visibleItems), [visibleItems]);

  const lightboxIndex = lightboxId
    ? visibleItems.findIndex((item) => item.id === lightboxId)
    : -1;
  const lightboxItem = lightboxIndex >= 0 ? visibleItems[lightboxIndex] ?? null : null;

  const activeChannel = channels.channels.find((channel) => channel.id === viewChannelId) ?? null;

  // Web Share Target: the service worker stashes incoming files in CacheStorage
  // and redirects here with `?share=<id>`.
  useEffect(() => {
    void pruneShareCache();
    const params = new URLSearchParams(window.location.search);
    const shareId = params.get('share');
    if (!shareId) return;
    window.history.replaceState({}, '', window.location.pathname + window.location.hash);
    if (shareId === 'empty' || shareId === 'error') {
      setView('whatsapp');
      return;
    }
    void readSharedPayload(shareId).then((payload) => {
      if (!payload || payload.files.length === 0) return;
      setSharedFiles(payload.files);
      setView('whatsapp');
    });
  }, []);

  useEffect(() => {
    if (view !== 'photos') setLightboxId(null);
  }, [view]);

  useEffect(() => {
    if (viewChannelId && !channels.selectedIds.includes(viewChannelId)) {
      setViewChannelId(null);
    }
  }, [channels.selectedIds, viewChannelId]);

  useEffect(() => {
    if (!ready) {
      setSelectorOpen(false);
      setSettingsOpen(false);
      setLightboxId(null);
      autoOpenedRef.current = false;
    }
  }, [ready]);

  useEffect(() => {
    if (
      ready &&
      !channels.loading &&
      channels.channels.length > 0 &&
      channels.needsSelection &&
      !autoOpenedRef.current
    ) {
      autoOpenedRef.current = true;
      setSelectorOpen(true);
    }
  }, [channels.channels.length, channels.loading, channels.needsSelection, ready]);

  useEffect(() => {
    if (lightboxId && lightboxIndex === -1) setLightboxId(null);
  }, [lightboxId, lightboxIndex]);

  const toggleEncrypt = useCallback((value: boolean) => {
    setEncryptUploads(value);
    try {
      localStorage.setItem(ENCRYPT_PREFERENCE_KEY, value ? 'true' : 'false');
    } catch {
      // Preference persistence is optional.
    }
  }, []);

  const handleFiles = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return;
      if (!targetChannelId) {
        setSelectorOpen(true);
        return;
      }
      // Any file type is accepted: photos and videos get previews, everything
      // else is encrypted and stored as a downloadable document.
      void uploader.upload(files, targetChannelId, encryptUploads);
    },
    [encryptUploads, targetChannelId, uploader],
  );

  const openFilePicker = (): void => {
    if (!targetChannelId) {
      setSelectorOpen(true);
      return;
    }
    fileInputRef.current?.click();
  };

  const handleDelete = useCallback(
    async (item: MediaItem) => {
      if (item.packed) {
        try {
          await telegramService.deleteMessages(item.channelId, [
            item.packed.bundleMessageId,
            item.packed.bundleIndexMessageId,
          ]);
        } catch (caught) {
          throw new Error(describeError(caught));
        }
        const bundleId = item.packed.bundleMessageId;
        const siblings = visibleItems.filter(
          (entry) => entry.packed?.bundleMessageId === bundleId,
        );
        timeline.removeItems(siblings.map((entry) => entry.id));
        setLightboxId(null);
        return;
      }

      const ids =
        item.thumbMessageId !== undefined
          ? [item.messageId, item.thumbMessageId]
          : [item.messageId];
      try {
        await telegramService.deleteMessages(item.channelId, ids);
      } catch (caught) {
        throw new Error(describeError(caught));
      }

      const remaining = visibleItems.filter((entry) => entry.id !== item.id);
      timeline.removeItems([item.id]);
      if (remaining.length === 0) {
        setLightboxId(null);
        return;
      }
      const position = Math.min(Math.max(lightboxIndex, 0), remaining.length - 1);
      setLightboxId(remaining[position]?.id ?? null);
    },
    [lightboxIndex, timeline, visibleItems],
  );

  const handleLock = useCallback(() => {
    setSettingsOpen(false);
    setSelectorOpen(false);
    setLightboxId(null);
    void auth.lock();
  }, [auth]);

  const handleReset = useCallback(() => {
    setSettingsOpen(false);
    setSelectorOpen(false);
    setLightboxId(null);
    void auth.reset();
  }, [auth]);

  const onDragEnter = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    if (view !== 'photos') return;
    dragDepthRef.current += 1;
    setDragging(true);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    if (view !== 'photos') return;
    event.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    if (view !== 'photos') return;
    dragDepthRef.current = 0;
    setDragging(false);
    handleFiles(Array.from(event.dataTransfer.files));
  };

  if (!ready) {
    return <AuthScreen auth={auth} theme={theme} onToggleTheme={toggleTheme} />;
  }

  const errorMessage = channels.error ?? timeline.error;
  const hasChannels = channels.channels.length > 0;
  const showSelectPrompt = hasChannels && channels.needsSelection;
  const countLabel = `${visibleItems.length.toLocaleString()} ${
    visibleItems.length === 1 ? 'item' : 'items'
  }`;

  return (
    <div
      className="min-h-screen bg-app"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {pull.distance > 0 ? (
        <div
          className="pointer-events-none fixed left-1/2 top-16 z-40 -translate-x-1/2"
          style={{ opacity: Math.min(1, pull.distance / 60) }}
        >
          <div className="flex items-center gap-2 rounded-full border border-line bg-elevated px-3.5 py-1.5 text-xs font-medium text-muted shadow-lg">
            <RefreshCw
              size={13}
              className={pull.pulled ? 'text-accent' : ''}
              style={{ transform: `rotate(${Math.round(pull.distance * 3)}deg)` }}
            />
            {pull.pulled ? 'Release to refresh' : 'Pull to refresh'}
          </div>
        </div>
      ) : null}

      <TopBar
        query={query}
        onQueryChange={setQuery}
        selectedChannels={channels.selectedChannels}
        onOpenChannels={() => setSelectorOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onUpload={openFilePicker}
        uploadDisabled={!targetChannelId}
        accountName={auth.account?.displayName ?? 'Vault'}
        syncing={timeline.loading || channels.loading || uploader.progress !== null}
        mode={view}
      />

      <div className="flex">
        <AppNav view={view} onChange={setView} />

        <div className="min-w-0 flex-1">
          {view === 'photos' ? (
          <main ref={photosRef} className="pb-20 md:pb-0">
        <div className="mx-auto flex max-w-[1800px] flex-wrap items-end justify-between gap-4 px-4 pb-1 pt-6 sm:px-6">
          <div className="min-w-0">
            <h1 className="truncate text-[26px] font-semibold tracking-tight text-ink sm:text-[30px]">
              {activeChannel?.title ?? 'Photos'}
            </h1>
            <p className="mt-1 text-xs text-muted">
              {countLabel}
              {query ? ' matching your search' : ''}
              {channels.selectedIds.length > 1 && !viewChannelId
                ? ` · ${channels.selectedIds.length} chats`
                : ''}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => toggleEncrypt(!encryptUploads)}
              aria-pressed={encryptUploads}
              className={`flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors ${
                encryptUploads
                  ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                  : 'border-line bg-elevated text-muted hover:text-ink'
              }`}
              title={
                encryptUploads
                  ? 'New uploads are encrypted before leaving this device'
                  : 'New uploads are posted as normal Telegram media'
              }
            >
              {encryptUploads ? <Lock size={13} /> : <Unlock size={13} />}
              {encryptUploads ? 'Encrypted uploads' : 'Direct uploads'}
            </button>

            <button
              type="button"
              onClick={() => void timeline.resetScan()}
              aria-label="Sync channels"
              title="Sync channels"
              className="flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-surface hover:text-ink"
            >
              {timeline.loading ? <Spinner size={16} /> : <RefreshCw size={16} />}
            </button>
          </div>
        </div>

        {errorMessage ? (
          <div className="mx-auto mt-3 max-w-[1800px] px-4 sm:px-6">
            <div className="rounded-xl border border-danger/25 bg-danger/5 px-3.5 py-2.5 text-xs text-danger">
              {errorMessage}
            </div>
          </div>
        ) : null}

        <ChannelVaultBanner
          channels={vaults.lockedIds.map((id) => ({
            id,
            title: channels.channels.find((channel) => channel.id === id)?.title ?? 'Channel',
          }))}
          candidates={channels.selectedChannels.map((channel) => ({
            id: channel.id,
            title: channel.title,
          }))}
          settled={vaults.settled}
          skipped={timeline.skipped}
          error={vaults.error}
          onUnlock={vaults.unlock}
        />

        {channels.loading && !hasChannels ? (
          <div className="mx-auto max-w-[1800px] px-3 pb-24 pt-6 sm:px-6">
            <div className="mb-4 h-7 w-40 rounded bg-surface/70" />
            <SkeletonGrid count={12} />
          </div>
        ) : null}

        {!channels.loading && !hasChannels ? (
          <EmptyPanel
            icon={<FolderLock size={34} />}
            title="No channels available"
            body="Create a private channel to use as your encrypted library, or refresh if you just joined one. Every channel and group you belong to is listed."
            action={
              <>
                <Button onClick={() => setSelectorOpen(true)} leadingIcon={<FolderLock size={16} />}>
                  Create a vault channel
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => void channels.refresh()}
                  leadingIcon={<RefreshCw size={16} />}
                >
                  Refresh
                </Button>
              </>
            }
          />
        ) : null}

        {showSelectPrompt ? (
          <EmptyPanel
            icon={<Images size={34} />}
            title="Choose your photo channels"
            body="Pick the channels that hold your library. PicPocket will only ever read and write inside those channels — everything else stays untouched."
            action={
              <Button onClick={() => setSelectorOpen(true)} leadingIcon={<FolderLock size={16} />}>
                Select channels
              </Button>
            }
          />
        ) : null}

        {channels.selectedIds.length > 0 ? (
          <div className="pt-2">
            <PhotoGrid
              groups={groups}
              loading={timeline.loading}
              loadingMore={timeline.loadingMore}
              hasMore={timeline.hasMore}
              onLoadMore={() => void timeline.loadMore()}
              onOpen={(item) => setLightboxId(item.id)}
              emptyState={
                <EmptyPanel
                  icon={<Upload size={32} />}
                  title={query ? 'No matches' : 'This library is empty'}
                  body={
                    query
                      ? 'Try a different file name, caption, or channel name.'
                      : encryptUploads
                        ? 'Drop any files here — photos, videos, PDFs, archives. They are cleaned up, previewed where possible, encrypted, then saved to your Telegram channel.'
                        : 'Drop files anywhere on this page, or use the upload button. They stay as regular Telegram photos and files.'
                  }
                  action={
                    query ? (
                      <Button variant="secondary" onClick={() => setQuery('')}>
                        Clear search
                      </Button>
                    ) : (
                      <Button onClick={openFilePicker} leadingIcon={<Upload size={16} />}>
                        Upload files
                      </Button>
                    )
                  }
                />
              }
            />
          </div>
        ) : null}
          </main>
          ) : (
            <WhatsAppBackupView
              channelId={targetChannelId}
              channelTitle={backupChannelTitle}
              onChooseChannel={() => setSelectorOpen(true)}
              sharedFiles={sharedFiles}
              onSharedConsumed={() => setSharedFiles([])}
            />
          )}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          // `input.files` is a live FileList: copy it BEFORE clearing the value,
          // otherwise resetting the input empties the list and the upload is lost.
          const selected = event.target.files ? Array.from(event.target.files) : [];
          event.target.value = '';
          if (selected.length > 0) handleFiles(selected);
        }}
      />

      {dragging ? (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-app/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-accent px-10 py-8 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-accent-ink">
              <Upload size={26} />
            </span>
            <p className="text-sm font-semibold text-ink">
              Drop {encryptUploads ? 'to encrypt & upload' : 'to upload'}
            </p>
            <p className="text-xs text-muted">
              {activeChannel?.title ?? channels.channels.find((c) => c.id === targetChannelId)?.title ?? 'Select a channel first'}
            </p>
          </div>
        </div>
      ) : null}

      {uploader.progress ? (
        <UploadPill
          progress={uploader.progress}
          result={uploader.result}
          encrypted={encryptUploads}
          onCancel={uploader.cancel}
          onDismiss={uploader.dismiss}
        />
      ) : null}

      {/* Mobile Floating Action Button (FAB): only when library has media items */}
      {view === 'photos' && visibleItems.length > 0 && targetChannelId ? (
        <button
          type="button"
          onClick={openFilePicker}
          aria-label="Upload files"
          className="fixed bottom-20 right-5 z-20 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[#1a73e8] to-[#0d9488] text-white shadow-xl shadow-accent/25 transition-transform active:scale-95 sm:hidden"
        >
          <Plus size={26} />
        </button>
      ) : null}

      <ChannelSelectorModal
        open={selectorOpen}
        onClose={() => setSelectorOpen(false)}
        channels={channels.channels}
        selectedIds={channels.selectedIds}
        loading={channels.loading}
        onToggle={channels.toggleChannel}
        onCreate={channels.createVaultChannel}
        onRefresh={() => void channels.refresh()}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        account={auth.account}
        profile={auth.profile}
        channelCount={channels.selectedIds.length}
        theme={theme}
        onToggleTheme={toggleTheme}
        encryptUploads={encryptUploads}
        onToggleEncrypt={toggleEncrypt}
        onManageChannels={() => {
          setSettingsOpen(false);
          setSelectorOpen(true);
        }}
        onLock={handleLock}
        onReset={handleReset}
      />

      {lightboxItem ? (
        <Lightbox
          items={visibleItems}
          index={lightboxIndex}
          onIndexChange={(nextIndex) => {
            setLightboxId(visibleItems[nextIndex]?.id ?? null);
          }}
          onClose={() => setLightboxId(null)}
          onDelete={handleDelete}
        />
      ) : null}
    </div>
  );
}
