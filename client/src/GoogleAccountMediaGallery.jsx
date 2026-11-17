import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Search, X, RefreshCw, Image as ImageIcon, Download, LogIn, LogOut, Plus, AlertCircle
} from 'lucide-react';
import {
  getGoogleAccountStatus, getGoogleSignInUrl, googleSignOut,
  listGoogleDriveImages, getGoogleDriveThumbnailUrl, getGoogleDriveFileUrl,
  createGooglePhotosSession, getGooglePhotosSession, listGooglePhotosItems, getGooglePhotosMediaUrl
} from './serverApi';
import { GOOGLE_GRADIENT, GOOGLE_PILL_ACTIVE_BG, GOOGLE_SHADOW } from './GoogleMediaGallery';

// Google Photos pinwheel mark
export const GooglePhotosLogo = ({ size = 16, style = {} }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style }} aria-hidden="true">
    <path fill="#EA4335" d="M12 12V2.5A4.75 4.75 0 0 1 12 12Z" />
    <path fill="#4285F4" d="M12 12H21.5A4.75 4.75 0 0 1 12 12Z" />
    <path fill="#34A853" d="M12 12V21.5A4.75 4.75 0 0 1 12 12Z" />
    <path fill="#FBBC05" d="M12 12H2.5A4.75 4.75 0 0 1 12 12Z" />
  </svg>
);

// Google Drive triangle mark
export const GoogleDriveLogo = ({ size = 16, style = {} }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style }} aria-hidden="true">
    <path fill="#0F9D58" d="M8 3L1 15l3.5 6 7-12z" />
    <path fill="#F4B400" d="M8 3h8l7 12h-7z" />
    <path fill="#4285F4" d="M4.5 21h15l3.5-6H8z" />
  </svg>
);

const isRemoteHost = () => {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]';
};

const DRIVE_TABS = [
  { id: 'all', label: 'All Images' },
  { id: 'gif', label: 'GIFs' },
  { id: 'starred', label: 'Starred' },
  { id: 'shared', label: 'Shared with me' },
];

const SOURCES = {
  drive: { title: 'Google Drive', Logo: GoogleDriveLogo },
  photos: { title: 'Google Photos', Logo: GooglePhotosLogo },
};

const SIGN_IN_POLL_MS = 2000;
const SIGN_IN_TIMEOUT_MS = 3 * 60 * 1000;

// Survives closing and reopening the side panel.
const _saved = {
  drive: { query: '', category: 'all', items: [], nextPageToken: null },
  photos: { items: [] },
};

const readIssue = (err) => {
  const detail = err?.response?.data?.detail;
  if (detail && typeof detail === 'object' && detail.reason) return detail;
  return { reason: 'error', message: (typeof detail === 'string' && detail) || err?.message || 'Something went wrong.' };
};

const iconButtonStyle = (disabled) => ({
  background: 'none',
  border: 'none',
  color: '#94a3b8',
  cursor: disabled ? 'not-allowed' : 'pointer',
  padding: '2px',
  borderRadius: '6px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'color 0.15s ease'
});

const pillStyle = (isActive) => ({
  height: '29px',
  padding: '0 13px',
  fontSize: '11px',
  fontWeight: isActive ? 700 : 500,
  whiteSpace: 'nowrap',
  borderRadius: '20px',
  border: isActive ? '2px solid transparent' : '1px solid rgba(255, 255, 255, 0.08)',
  background: isActive ? GOOGLE_PILL_ACTIVE_BG : 'rgba(255, 255, 255, 0.04)',
  color: isActive ? '#0f172a' : '#94a3b8',
  cursor: 'pointer',
  transition: 'all 0.18s ease',
  boxShadow: isActive ? GOOGLE_SHADOW : 'none',
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '6px'
});

function EmptyState({ icon, title, text, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '36px 0', gap: '10px', textAlign: 'center' }}>
      {icon}
      <span style={{ fontSize: '13px', fontWeight: 600, color: '#94a3b8' }}>{title}</span>
      {text && <span style={{ fontSize: '11px', color: '#64748b', maxWidth: '300px' }}>{text}</span>}
      {children}
    </div>
  );
}

export default function GoogleAccountMediaGallery({
  source = 'drive',
  onClose,
  onSelectMedia,
  onNotify,
  style = {},
  className = ""
}) {
  const { title, Logo } = SOURCES[source] || SOURCES.drive;
  const isDrive = source === 'drive';
  const saved = _saved[isDrive ? 'drive' : 'photos'];

  const [account, setAccount] = useState(null); // { signed_in, token_updated }
  const [issue, setIssue] = useState(null); // { reason, message }
  const [waitingForSignIn, setWaitingForSignIn] = useState(false);

  const [query, setQuery] = useState(() => saved.query || '');
  const [category, setCategory] = useState(() => saved.category || 'all');
  const [items, setItems] = useState(() => saved.items || []);
  const [nextPageToken, setNextPageToken] = useState(() => saved.nextPageToken || null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [importingId, setImportingId] = useState(null);
  const [isPicking, setIsPicking] = useState(false);

  const searchInputRef = useRef(null);
  const signInPollRef = useRef(null);
  const pickerRef = useRef({ cancelled: false, timer: null, win: null });
  const requestIdRef = useRef(0);
  const skipNextSearchRef = useRef(isDrive && (saved.items || []).length > 0);

  const signedIn = Boolean(account?.signed_in);

  useEffect(() => {
    if (isDrive) Object.assign(_saved.drive, { query, category, items, nextPageToken });
    else _saved.photos.items = items;
  }, [isDrive, query, category, items, nextPageToken]);

  const refreshAccount = useCallback(async () => {
    try {
      const info = await getGoogleAccountStatus();
      setAccount(info);
      if (!info?.signed_in) setIssue(null);
      return info;
    } catch (err) {
      console.warn('[GoogleAccountMediaGallery] Could not check Google sign-in:', err);
      return null;
    }
  }, []);

  useEffect(() => {
    refreshAccount();
    const onFocus = () => refreshAccount();
    window.addEventListener('focus', onFocus);
    const picker = pickerRef.current;
    return () => {
      window.removeEventListener('focus', onFocus);
      if (signInPollRef.current) clearInterval(signInPollRef.current);
      picker.cancelled = true;
      if (picker.timer) clearTimeout(picker.timer);
    };
  }, [refreshAccount]);

  const handleIssue = useCallback((err) => {
    const next = readIssue(err);
    if (next.reason === 'signed_out') {
      setAccount(prev => ({ ...(prev || {}), signed_in: false }));
    }
    setIssue(next);
  }, []);

  // ---- Google Drive ---------------------------------------------------------

  const fetchDrive = useCallback(async (loadMore = false) => {
    const requestId = ++requestIdRef.current;
    if (loadMore) setIsLoadingMore(true);
    else setIsLoading(true);
    try {
      const data = await listGoogleDriveImages({
        q: query.trim(),
        category,
        pageToken: loadMore ? nextPageToken : undefined,
        limit: 24
      });
      if (requestId !== requestIdRef.current) return;
      const newItems = Array.isArray(data?.items) ? data.items : [];
      setItems(prev => {
        if (!loadMore) return newItems;
        const seen = new Set(prev.map(p => p.id));
        return [...prev, ...newItems.filter(i => !seen.has(i.id))];
      });
      setNextPageToken(data?.nextPageToken || null);
      setIssue(null);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      console.error('[GoogleAccountMediaGallery] Drive error:', err);
      handleIssue(err);
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    }
  }, [query, category, nextPageToken, handleIssue]);

  // Debounced auto-search once signed in (matches Google Images & LOY SPACE)
  useEffect(() => {
    if (!isDrive || !signedIn) return;
    if (skipNextSearchRef.current) {
      skipNextSearchRef.current = false;
      return;
    }
    const timer = setTimeout(() => fetchDrive(false), 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDrive, signedIn, query, category, account?.token_updated]);

  // ---- Google Photos (Picker) -----------------------------------------------

  const stopPicking = useCallback(() => {
    const picker = pickerRef.current;
    picker.cancelled = true;
    if (picker.timer) clearTimeout(picker.timer);
    picker.timer = null;
    try { picker.win?.close(); } catch { /* cross-origin window */ }
    picker.win = null;
    setIsPicking(false);
  }, []);

  const loadPickedItems = useCallback(async (sessionId) => {
    setIsLoading(true);
    try {
      const picked = [];
      let skippedVideos = 0;
      let pageToken;
      do {
        const data = await listGooglePhotosItems({ sessionId, pageToken });
        picked.push(...(data?.items || []));
        skippedVideos += data?.skippedVideos || 0;
        pageToken = data?.nextPageToken;
      } while (pageToken);
      setItems(prev => {
        const ids = new Set(picked.map(p => p.id));
        return [...picked, ...prev.filter(p => !ids.has(p.id))];
      });
      setIssue(null);
      if (onNotify) {
        const parts = [`Added ${picked.length} photo${picked.length === 1 ? '' : 's'} from Google Photos`];
        if (skippedVideos) parts.push(`skipped ${skippedVideos} video${skippedVideos === 1 ? '' : 's'}`);
        onNotify(parts.join(', '));
      }
    } catch (err) {
      console.error('[GoogleAccountMediaGallery] Photos items error:', err);
      handleIssue(err);
    } finally {
      setIsLoading(false);
    }
  }, [handleIssue, onNotify]);

  const handleChooseFromPhotos = async () => {
    if (isPicking) return;
    // Open the window during the click so pop-up blockers allow it.
    const win = window.open('', '_blank');
    const picker = { cancelled: false, timer: null, win };
    pickerRef.current = picker;
    setIsPicking(true);
    setIssue(null);
    try {
      const session = await createGooglePhotosSession();
      if (picker.cancelled) return;
      const pickerUrl = `${session.pickerUri.replace(/\/$/, '')}/autoclose`;
      if (win && !win.closed) win.location.href = pickerUrl;
      else picker.win = window.open(pickerUrl, '_blank');

      let closedChecks = 0;
      const poll = async () => {
        if (picker.cancelled) return;
        try {
          const state = await getGooglePhotosSession(session.id);
          if (picker.cancelled) return;
          if (state.mediaItemsSet) {
            picker.cancelled = true;
            setIsPicking(false);
            await loadPickedItems(session.id);
            return;
          }
          // Picker window closed without picking: check twice more, then stop.
          if (picker.win?.closed && ++closedChecks > 2) {
            stopPicking();
            return;
          }
          picker.timer = setTimeout(poll, session.pollIntervalMs || 3000);
        } catch (err) {
          if (picker.cancelled) return;
          stopPicking();
          handleIssue(err);
        }
      };
      picker.timer = setTimeout(poll, session.pollIntervalMs || 3000);
    } catch (err) {
      console.error('[GoogleAccountMediaGallery] Photos picker error:', err);
      stopPicking();
      handleIssue(err);
    }
  };

  // ---- Sign in / Sign out (same header button as LOY SPACE) -----------------

  const startSignIn = async () => {
    if (waitingForSignIn) return;
    const win = window.open('', '_blank');
    setIssue(null);
    try {
      const url = await getGoogleSignInUrl();
      if (win && !win.closed) win.location.href = url;
      else window.open(url, '_blank');
    } catch (err) {
      try { win?.close(); } catch { /* ignore */ }
      setIssue(readIssue(err));
      return;
    }
    const before = account?.token_updated || 0;
    const startedAt = Date.now();
    setWaitingForSignIn(true);
    if (signInPollRef.current) clearInterval(signInPollRef.current);
    signInPollRef.current = setInterval(async () => {
      const info = await refreshAccount();
      const done = info?.signed_in && info.token_updated && info.token_updated !== before;
      if (done || Date.now() - startedAt > SIGN_IN_TIMEOUT_MS) {
        clearInterval(signInPollRef.current);
        signInPollRef.current = null;
        setWaitingForSignIn(false);
        if (done) setIssue(null);
        if (done && onNotify) onNotify(`Signed in to Google. Showing your ${title}.`);
      }
    }, SIGN_IN_POLL_MS);
  };

  const handleAuthClick = async () => {
    if (signedIn) {
      try {
        stopPicking();
        await googleSignOut();
        setAccount({ signed_in: false, token_updated: 0 });
        setItems([]);
        setNextPageToken(null);
        setIssue(null);
        if (onNotify) onNotify('Signed out of Google.');
      } catch (err) {
        console.error('[GoogleAccountMediaGallery] Sign out error:', err);
        setIssue(readIssue(err));
      }
    } else {
      startSignIn();
    }
  };

  // ---- Media ------------------------------------------------------------------

  const fileUrlFor = (item) => (isDrive ? getGoogleDriveFileUrl(item.id) : getGooglePhotosMediaUrl(item.id));
  const thumbUrlFor = (item) => {
    if (item.previewFull || !item.hasThumbnail) return fileUrlFor(item);
    return isDrive ? getGoogleDriveThumbnailUrl(item.id) : getGooglePhotosMediaUrl(item.id, true);
  };

  const handleItemClick = async (item) => {
    setSelectedId(item.id);
    setImportingId(item.id);
    try {
      if (onSelectMedia) await onSelectMedia({ ...item, fileUrl: fileUrlFor(item), source });
      if (onNotify) onNotify(`Applied ${item.isAnimated ? 'GIF' : 'Image'} from ${title}!`);
    } catch (err) {
      console.error('[GoogleAccountMediaGallery] Error importing media:', err);
      if (!isDrive) setItems(prev => prev.filter(i => i.id !== item.id));
      if (onNotify) onNotify(isDrive ? `Could not use ${item.title || 'that file'}` : `That photo link expired. Choose it from Google Photos again.`);
    } finally {
      setImportingId(null);
    }
  };

  const handleRefresh = async () => {
    const info = await refreshAccount();
    if (info?.signed_in && isDrive) fetchDrive(false);
  };

  const showSignOut = signedIn && !isRemoteHost();
  const needsPermission = issue?.reason === 'needs_permission';

  return (
    <div
      data-google-account-side-panel={source}
      className={`glass-panel flex flex-col ${className}`}
      style={{
        position: 'relative',
        background: 'var(--card-bg)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        color: '#f8fafc',
        height: 'auto',
        maxHeight: '92vh',
        minHeight: 0,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        ...style
      }}
    >
      {/* Header matching Google Images & LOY SPACE */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Logo size={20} />
          <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 800, color: '#f8fafc', letterSpacing: '-0.01em' }}>
            {title}
          </h4>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* Sign in / Sign out button (same as LOY SPACE) */}
          {account && (!signedIn || showSignOut) && (
            <button
              type="button"
              onClick={handleAuthClick}
              disabled={waitingForSignIn}
              className="btn-styled inactive"
              style={{ padding: '6px 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, cursor: waitingForSignIn ? 'wait' : 'pointer' }}
              title={signedIn ? 'Sign out of Google (also disconnects Today\'s Schedule and sync)' : `Sign in with Google to browse your ${title}`}
            >
              {waitingForSignIn ? <RefreshCw size={13} className="animate-spin" /> : (signedIn ? <LogOut size={13} /> : <LogIn size={13} />)}
              <span>{waitingForSignIn ? 'Signing in...' : (signedIn ? 'Sign out' : 'Sign in')}</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleRefresh}
            disabled={isLoading}
            style={iconButtonStyle(isLoading)}
            onMouseOver={e => e.currentTarget.style.color = '#ffffff'}
            onMouseOut={e => e.currentTarget.style.color = '#94a3b8'}
            title={`Refresh ${title}`}
          >
            <RefreshCw size={15} className={isLoading ? 'animate-spin' : ''} />
          </button>

          {onClose && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); stopPicking(); onClose(); }}
              style={iconButtonStyle(false)}
              onMouseOver={e => e.currentTarget.style.color = '#ffffff'}
              onMouseOut={e => e.currentTarget.style.color = '#94a3b8'}
              title={`Close ${title}`}
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Drive: search bar + category chips */}
      {isDrive && signedIn && (
        <>
          <div style={{ marginBottom: '14px', flexShrink: 0, position: 'relative', display: 'flex', alignItems: 'center' }}>
            <Search size={14} style={{ position: 'absolute', left: '12px', color: query ? '#94a3b8' : '#64748b', pointerEvents: 'none' }} />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.stopPropagation();
                  fetchDrive(false);
                }
              }}
              placeholder="Search your Google Drive images by name..."
              style={{
                width: '100%',
                padding: '9px 36px 9px 34px',
                fontSize: '12px',
                color: '#f8fafc',
                background: 'rgba(0, 0, 0, 0.25)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: '12px',
                outline: 'none',
                boxShadow: 'none'
              }}
            />
            {query && (
              <button
                type="button"
                onClick={() => { setQuery(''); searchInputRef.current?.focus(); }}
                style={{ position: 'absolute', right: '10px', background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center' }}
                title="Clear search"
              >
                <X size={14} />
              </button>
            )}
          </div>

          <div
            className="no-scrollbar"
            style={{ display: 'flex', alignItems: 'center', gap: '6px', overflowX: 'auto', paddingBottom: '8px', marginBottom: '12px', scrollbarWidth: 'none', msOverflowStyle: 'none', flexShrink: 0 }}
          >
            {DRIVE_TABS.map(tab => (
              <button key={tab.id} type="button" onClick={() => setCategory(tab.id)} style={pillStyle(category === tab.id)}>
                {tab.label}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Photos: choose button */}
      {!isDrive && signedIn && !needsPermission && issue?.reason !== 'api_disabled' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', flexShrink: 0 }}>
          <button type="button" onClick={handleChooseFromPhotos} disabled={isPicking} style={{ ...pillStyle(true), cursor: isPicking ? 'wait' : 'pointer' }}>
            {isPicking ? <RefreshCw size={12} className="animate-spin" /> : <Plus size={12} />}
            <span>{isPicking ? 'Waiting for Google Photos...' : 'Choose from Google Photos'}</span>
          </button>
          {isPicking && (
            <button type="button" onClick={stopPicking} style={pillStyle(false)}>Cancel</button>
          )}
        </div>
      )}

      {/* Notices */}
      {issue && signedIn && (
        <div style={{
          background: needsPermission ? 'rgba(66, 133, 244, 0.1)' : 'rgba(239, 68, 68, 0.1)',
          border: needsPermission ? '1px solid rgba(66, 133, 244, 0.3)' : '1px solid rgba(239, 68, 68, 0.25)',
          color: needsPermission ? '#bfdbfe' : '#f87171',
          padding: '8px 12px',
          borderRadius: '8px',
          fontSize: '11px',
          marginBottom: '10px',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <AlertCircle size={14} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1 }}>{issue.message}</span>
          {needsPermission && (
            <button type="button" onClick={startSignIn} disabled={waitingForSignIn} className="btn-styled inactive" style={{ padding: '4px 10px', fontSize: 11, flexShrink: 0 }}>
              {waitingForSignIn ? 'Waiting...' : 'Allow access'}
            </button>
          )}
        </div>
      )}

      {/* Media grid */}
      <div
        className="loy-gallery-scroll"
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          maxHeight: 'calc(92vh - 160px)',
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '6px 6px 12px 6px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px'
        }}
      >
        {!account && (
          <EmptyState icon={<RefreshCw size={24} className="animate-spin" style={{ color: '#94a3b8' }} />} title="Checking Google sign-in..." />
        )}

        {account && !signedIn && (
          <EmptyState
            icon={<Logo size={32} />}
            title={`Sign in to see your ${title}`}
            text={isRemoteHost()
              ? `Sign in with the Google account used on the LED Sign. ${title} images can then be used as preset media.`
              : `Use the Google account from Today's Schedule. ${isDrive ? 'Images in your Drive' : 'Photos you pick'} can then be used as preset media.`}
          >
            <button type="button" onClick={startSignIn} disabled={waitingForSignIn} style={{ ...pillStyle(true), marginTop: '6px', cursor: waitingForSignIn ? 'wait' : 'pointer' }}>
              {waitingForSignIn ? <RefreshCw size={12} className="animate-spin" /> : <LogIn size={12} />}
              <span>{waitingForSignIn ? 'Waiting for Google sign-in...' : 'Sign in with Google'}</span>
            </button>
          </EmptyState>
        )}

        {signedIn && isLoading && (
          <EmptyState
            icon={<RefreshCw size={24} className="animate-spin" style={{ color: '#94a3b8' }} />}
            title={isDrive ? 'Loading your Google Drive images...' : 'Loading your photos...'}
          />
        )}

        {signedIn && !isLoading && items.length === 0 && !issue && (
          isDrive ? (
            <EmptyState
              icon={<ImageIcon size={32} style={{ color: '#475569' }} />}
              title="No images found"
              text={query.trim() ? 'No Drive images match that name. Try another search.' : 'Images you add to Google Drive will show up here.'}
            />
          ) : (
            <EmptyState
              icon={<ImageIcon size={32} style={{ color: '#475569' }} />}
              title={isPicking ? 'Pick photos in the Google Photos window' : 'No photos chosen yet'}
              text={isPicking
                ? 'Select one or more photos, then press Done. They will appear here.'
                : 'Google only lets apps see the photos you choose. Press "Choose from Google Photos" to pick some.'}
            />
          )
        )}

        {signedIn && !isLoading && items.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px', padding: '2px 2px 8px 2px' }}>
            {items.map((item) => {
              const isSelected = selectedId === item.id;
              const isImporting = importingId === item.id;
              return (
                <div
                  key={item.id}
                  onClick={() => !isImporting && handleItemClick(item)}
                  style={{
                    position: 'relative',
                    borderRadius: '16px',
                    border: isSelected ? '2px solid transparent' : '1px solid rgba(255, 255, 255, 0.08)',
                    background: isSelected
                      ? 'linear-gradient(rgba(20, 20, 25, 0.95), rgba(20, 20, 25, 0.95)) padding-box, ' + GOOGLE_GRADIENT + ' border-box'
                      : 'rgba(255, 255, 255, 0.03)',
                    boxShadow: isSelected ? '0 0 16px rgba(66, 133, 244, 0.35), 0 4px 12px rgba(0, 0, 0, 0.4)' : 'none',
                    overflow: 'hidden',
                    cursor: 'pointer',
                    transition: 'all 0.18s ease',
                    display: 'flex',
                    flexDirection: 'column'
                  }}
                  onMouseOver={(e) => {
                    if (!isSelected) {
                      e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)';
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)';
                      e.currentTarget.style.transform = 'translateY(-1px)';
                    }
                  }}
                  onMouseOut={(e) => {
                    if (!isSelected) {
                      e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.03)';
                      e.currentTarget.style.transform = 'translateY(0)';
                    }
                  }}
                >
                  <div style={{
                    width: '100%',
                    aspectRatio: '64 / 20',
                    background: '#05070e',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    position: 'relative',
                    overflow: 'hidden',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.05)'
                  }}>
                    <img
                      src={thumbUrlFor(item)}
                      alt={item.title}
                      loading="lazy"
                      style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
                    />
                    {item.width > 0 && item.height > 0 && (
                      <span style={{ position: 'absolute', bottom: '5px', right: '5px', background: 'rgba(0, 0, 0, 0.75)', color: '#cbd5e1', fontSize: '9px', fontWeight: 600, padding: '1px 5px', borderRadius: '4px' }}>
                        {item.width}×{item.height}
                      </span>
                    )}
                    {isImporting && (
                      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0, 0, 0, 0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <RefreshCw size={16} className="animate-spin text-white" />
                      </div>
                    )}
                  </div>
                  <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    <p style={{ fontSize: '11px', fontWeight: 700, color: isSelected ? '#ffffff' : '#f1f5f9', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.title}
                    </p>
                    <span style={{ fontSize: '9px', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.isAnimated ? 'GIF' : (item.mimeType || '').replace('image/', '').toUpperCase() || 'Image'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {isDrive && signedIn && items.length > 0 && nextPageToken && !isLoading && (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: '12px', marginBottom: '8px' }}>
            <button
              type="button"
              onClick={() => !isLoadingMore && fetchDrive(true)}
              disabled={isLoadingMore}
              className="btn-styled text-xs px-5 py-2 flex items-center gap-2"
              style={{ borderRadius: '12px', background: 'rgba(255, 255, 255, 0.06)', border: '1px solid rgba(255, 255, 255, 0.08)', color: '#e2e8f0', cursor: isLoadingMore ? 'not-allowed' : 'pointer' }}
            >
              {isLoadingMore ? (<><RefreshCw size={13} className="animate-spin" /><span>Loading media...</span></>) : (<><Download size={13} /><span>Load More</span></>)}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
