import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { 
  Search, X, RefreshCw, Download, Eye, Heart, 
  AlertCircle, Image as ImageIcon, LogIn, LogOut, Upload
} from 'lucide-react';
import { 
  getLoyCategories, getLoyMaterials, getLoyProxyMediaUrl,
  getLoyAuthStatus, loyLogin, loyLogout, uploadLoyMaterial,
  getLoyMyMaterials 
} from './serverApi';

// Official LOY SPACE Brand Colors & Gradient (from user-provided LOY SPACE logo)
export const LOY_GRADIENT = 'linear-gradient(135deg, #D80204 0%, #FB8D00 20%, #FADC02 40%, #1CAB1E 60%, #017FD6 80%, #843FB3 100%)';
export const LOY_SHADOW = '0 0 0 1px rgba(255, 255, 255, 0.2), 0 2px 10px rgba(216, 2, 4, 0.3)';

// Official LOY SPACE Logo Image (using authentic photo)
export const LoySpaceLogo = ({ size = 20, className = "", style = {} }) => (
  <img 
    src="/loyspace.png" 
    alt="LOY SPACE" 
    width={size} 
    height={size} 
    className={className} 
    style={{ objectFit: 'contain', display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style }} 
  />
);

// Default fallback categories in exact LOY SPACE get_config (tags_type=2) order
const DEFAULT_CATEGORIES = [
  { id: 13, name: "Eye", type: 1 },
  { id: 48, name: "New", type: 0 },
  { id: 14, name: "Motorcycle", type: 1 },
  { id: 1, name: "Exclusive", type: 1 },
  { id: 49, name: "Hot", type: 2 },
  { id: 5, name: "Driver", type: 1 },
  { id: 3, name: "Expression", type: 1 },
  { id: 10, name: "Warning", type: 1 },
  { id: 12, name: "Picture", type: 1 },
  { id: 7, name: "Pixel", type: 1 },
  { id: 8, name: "Word", type: 1 },
  { id: 11, name: "Auto Logos", type: 1 },
  { id: 2, name: "Holidays", type: 1 },
  { id: 9, name: "Creativity", type: 1 },
  { id: 4, name: "Public Welfare", type: 1 },
  { id: 6, name: "Business", type: 1 }
];

const MY_UPLOADS_TAB = { id: 'my_uploads', name: 'Uploads', type: 'uploads' };

// In-memory persistent state so closing the side panel preserves search, active tab, and loaded cards
let _persistedLoyState = {
  activeTab: DEFAULT_CATEGORIES[0],
  searchQuery: '',
  activeSearch: '',
  items: [],
  pageIndex: 0,
  hasMore: false,
};

export default function LoySpaceGallery({
  onClose,
  onSelectMedia,
  onNotify,
  form,
  imageObjRef,
  style = {},
  className = ""
}) {
  const [categories, setCategories] = useState(DEFAULT_CATEGORIES);
  const [activeTab, setActiveTab] = useState(() => _persistedLoyState.activeTab || DEFAULT_CATEGORIES[0]);
  const [searchQuery, setSearchQuery] = useState(() => _persistedLoyState.searchQuery || '');
  const [activeSearch, setActiveSearch] = useState(() => _persistedLoyState.activeSearch || '');
  const [items, setItems] = useState(() => _persistedLoyState.items || []);
  const [pageIndex, setPageIndex] = useState(() => _persistedLoyState.pageIndex || 0);
  const [hasMore, setHasMore] = useState(() => _persistedLoyState.hasMore || false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [importingId, setImportingId] = useState(null);
  const hasRestoredInitialRef = useRef(_persistedLoyState.items.length > 0);
  const galleryRef = useRef(null);
  const tabsScrollRef = useRef(null);
  const searchInputRef = useRef(null);
  const [modalCenter, setModalCenter] = useState(null);

  const updateModalCenter = useCallback(() => {
    if (galleryRef.current) {
      const rect = galleryRef.current.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setModalCenter({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2
        });
      }
    }
  }, []);

  // Authentication & Guest State
  const [authInfo, setAuthInfo] = useState({ logged_in: false, is_guest: true, nickname: 'Guest' });
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [loginUser, setLoginUser] = useState('');
  const [loginPwd, setLoginPwd] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [authError, setAuthError] = useState('');

  // Upload Canvas State
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadName, setUploadName] = useState('');
  const [uploadMark, setUploadMark] = useState('custom, 64x20');
  const [uploadTagId, setUploadTagId] = useState(13);
  const [uploadPreviewUrl, setUploadPreviewUrl] = useState(null);
  const [uploadBlob, setUploadBlob] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');

  // User Uploads State
  const [hasUploads, setHasUploads] = useState(false);
  const [userUploadCount, setUserUploadCount] = useState(0);

  // Cache for loaded categories: { [tabId]: { items, pageIndex, hasMore } }
  const cacheRef = useRef({});

  // Check if current canvas shown in MediaView is empty
  const isCanvasEmpty = useMemo(() => {
    if (!form) return true;
    if (form.mode === 'image') {
      return !form.imgSrc;
    }
    if (form.mode === 'draw') {
      if (!Array.isArray(form.pixels) || form.pixels.length === 0) return true;
      return form.pixels.every(p => !p || p === 0 || p === '#000000' || p === '#000' || p === 'rgb(0,0,0)');
    }
    if (form.imgSrc) return false;
    if (Array.isArray(form.pixels) && form.pixels.some(p => p && p !== 0 && p !== '#000000' && p !== '#000')) {
      return false;
    }
    return true;
  }, [form]);

  // Check if current user session (guest or signed-in) has any uploads
  const checkUserUploads = useCallback(async () => {
    try {
      const res = await getLoyMyMaterials({ pageIndex: 0, pageCount: 1 });
      if (res && res.status === 0) {
        const count = typeof res.total_count === 'number' 
          ? res.total_count 
          : (Array.isArray(res.data) ? res.data.length : 0);
        setUserUploadCount(count);
        const has = count > 0;
        setHasUploads(has);
        return has;
      } else {
        setUserUploadCount(0);
        setHasUploads(false);
        return false;
      }
    } catch (err) {
      console.warn('[LoySpaceGallery] Could not check user uploads:', err);
      setUserUploadCount(0);
      setHasUploads(false);
      return false;
    }
  }, []);

  // Fetch categories, auth status, and user uploads on mount
  useEffect(() => {
    let isMounted = true;
    getLoyCategories()
      .then(cats => {
        if (isMounted && Array.isArray(cats) && cats.length > 0) {
          setCategories(cats);
          setActiveTab(prev => {
            if (prev.id === 'my_uploads') return prev;
            return cats.find(c => c.id === prev.id) || cats[0];
          });
        }
      })
      .catch(err => {
        console.warn('[LoySpaceGallery] Could not load live categories, using defaults:', err);
      });

    getLoyAuthStatus()
      .then(info => {
        if (isMounted && info) setAuthInfo(info);
      })
      .catch(err => {
        console.warn('[LoySpaceGallery] Could not check auth status:', err);
      });

    checkUserUploads();

    return () => { isMounted = false; };
  }, [checkUserUploads]);

  // Fallback to first category tab if on Uploads tab but user has no uploads
  useEffect(() => {
    if (!hasUploads && activeTab.id === 'my_uploads') {
      setActiveTab(categories[0] || DEFAULT_CATEGORIES[0]);
    }
  }, [hasUploads, activeTab, categories]);

  // Keep portal modals centered over the LOY SPACE Downloads pop-up
  useEffect(() => {
    if (!showAuthModal && !showUploadModal) return;
    updateModalCenter();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateModalCenter) : null;
    if (ro && galleryRef.current) {
      ro.observe(galleryRef.current);
    }
    window.addEventListener('resize', updateModalCenter);
    window.addEventListener('scroll', updateModalCenter, true);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', updateModalCenter);
      window.removeEventListener('scroll', updateModalCenter, true);
    };
  }, [showAuthModal, showUploadModal, updateModalCenter, items.length, isLoading]);

  // Fetch materials for current tab or search
  const loadMaterials = useCallback(async (tab, search = '', page = 0, isAppend = false) => {
    if (page === 0) {
      setIsLoading(true);
      setItems([]);
      setHasMore(false);
      setError('');
    } else {
      setIsLoadingMore(true);
    }

    try {
      let res;
      if (tab.id === 'my_uploads') {
        res = await getLoyMyMaterials({
          pageIndex: page,
          pageCount: 24
        });
      } else {
        res = await getLoyMaterials({
          tagId: tab.id,
          tagType: tab.type,
          pageIndex: page,
          pageCount: 24,
          search: search
        });
      }

      if (res.status === 0) {
        const newItems = res.data || [];
        setItems(prev => (isAppend ? [...prev, ...newItems] : newItems));
        const moreAvailable = newItems.length > 0 && Boolean(res.has_more);
        setHasMore(moreAvailable);
        setPageIndex(page);

        if (tab.id === 'my_uploads') {
          const total = typeof res.total_count === 'number' ? res.total_count : newItems.length;
          setUserUploadCount(total);
          setHasUploads(total > 0);
        }

        // Update cache for current category if not searching
        if (!search) {
          cacheRef.current[tab.id] = {
            items: isAppend ? [...(cacheRef.current[tab.id]?.items || []), ...newItems] : newItems,
            pageIndex: page,
            hasMore: moreAvailable
          };
        }
      } else {
        setError(res.error || 'Failed to load materials from LOY SPACE');
        if (!isAppend) setItems([]);
      }
    } catch (err) {
      console.error('[LoySpaceGallery] Fetch error:', err);
      setError(err?.response?.data?.detail || err.message || 'Error connecting to LOY SPACE');
      if (!isAppend) setItems([]);
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  }, []);

  // Sync persisted state whenever active tab, search, or items change
  useEffect(() => {
    _persistedLoyState = {
      activeTab,
      searchQuery,
      activeSearch,
      items,
      pageIndex,
      hasMore
    };
  }, [activeTab, searchQuery, activeSearch, items, pageIndex, hasMore]);

  // Trigger load when tab or activeSearch changes
  useEffect(() => {
    if (hasRestoredInitialRef.current) {
      hasRestoredInitialRef.current = false;
      return;
    }
    if (activeSearch) {
      loadMaterials(activeTab, activeSearch, 0, false);
    } else {
      // Check cache first
      const cached = cacheRef.current[activeTab.id];
      if (cached && cached.items.length > 0) {
        setItems(cached.items);
        setPageIndex(cached.pageIndex);
        setHasMore(cached.hasMore);
        setIsLoading(false);
        setError('');
      } else {
        loadMaterials(activeTab, '', 0, false);
      }
    }
  }, [activeTab, activeSearch, loadMaterials]);

  // Handle tab click
  const handleTabClick = (tab) => {
    if (tab.id === activeTab.id && !activeSearch) return;
    const cached = cacheRef.current[tab.id];
    if (cached && cached.items.length > 0) {
      setItems(cached.items);
      setPageIndex(cached.pageIndex);
      setHasMore(cached.hasMore);
      setIsLoading(false);
      setError('');
    } else {
      setItems([]);
      setHasMore(false);
      setIsLoading(true);
      setError('');
    }
    setActiveTab(tab);
    if (activeSearch) {
      setActiveSearch('');
      setSearchQuery('');
    }
  };

  // Real-time debounced auto-search as user types (matching Google Images)
  useEffect(() => {
    if (hasRestoredInitialRef.current) {
      hasRestoredInitialRef.current = false;
      return;
    }

    const timer = setTimeout(() => {
      setActiveSearch(searchQuery.trim());
    }, 400);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Handle Search submit
  const handleSearchSubmit = (e) => {
    if (e) e.preventDefault();
    setActiveSearch(searchQuery.trim());
  };

  // Clear search
  const handleClearSearch = () => {
    setSearchQuery('');
    setActiveSearch('');
  };

  // Refresh current view and re-sync categories from LOY SPACE
  const handleRefresh = () => {
    if (!activeSearch) {
      delete cacheRef.current[activeTab.id];
    }
    getLoyCategories({ refresh: true })
      .then((cats) => {
        if (Array.isArray(cats) && cats.length > 0) {
          setCategories(cats);
        }
      })
      .catch(() => {});
    loadMaterials(activeTab, activeSearch, 0, false);
  };

  // Load more items
  const handleLoadMore = () => {
    if (isLoadingMore || !hasMore) return;
    loadMaterials(activeTab, activeSearch, pageIndex + 1, true);
  };

  // Import media into preset
  const handleItemSelect = async (item) => {
    if (importingId) return;
    setImportingId(item.id);
    setSelectedId(item.id);

    try {
      if (onSelectMedia) {
        await onSelectMedia(item);
      }
    } catch (err) {
      console.error('[LoySpaceGallery] Select error:', err);
      if (onNotify) onNotify(`Failed to load ${item.name}: ${err.message}`);
    } finally {
      setImportingId(null);
    }
  };

  // Sign In / Sign Out click handler (styled same as Today's Schedule)
  const handleAuthClick = async () => {
    if (authInfo?.logged_in && !authInfo?.is_guest) {
      try {
        await loyLogout();
        const guestInfo = await getLoyAuthStatus();
        setAuthInfo(guestInfo || { logged_in: false, is_guest: true, nickname: 'Guest' });
        delete cacheRef.current[MY_UPLOADS_TAB.id];
        await checkUserUploads();
        if (onNotify) onNotify("Signed out of LOY SPACE. Reverted to Guest Mode.");
      } catch (err) {
        console.error('[LoySpaceGallery] Logout error:', err);
      }
    } else {
      updateModalCenter();
      setAuthError('');
      setShowAuthModal(true);
    }
  };

  // Submit Sign In form
  const handleLoginSubmit = async (e) => {
    if (e) e.preventDefault();
    if (!loginUser.trim() || !loginPwd) {
      setAuthError('Please enter your username and password.');
      return;
    }
    setIsLoggingIn(true);
    setAuthError('');
    try {
      const res = await loyLogin({ user: loginUser.trim(), pwd: loginPwd });
      if (res.status === 0) {
        setAuthInfo({
          logged_in: true,
          is_guest: false,
          user: res.data?.user || loginUser.trim(),
          userid: res.data?.userid,
          nickname: res.data?.nickname || res.data?.user || loginUser.trim()
        });
        setShowAuthModal(false);
        setLoginPwd('');
        delete cacheRef.current[MY_UPLOADS_TAB.id];
        await checkUserUploads();
        if (onNotify) onNotify(`Signed in to LOY SPACE as ${res.data?.nickname || loginUser.trim()}`);
      } else {
        setAuthError(res.error || 'Login failed. Please check your credentials.');
      }
    } catch (err) {
      console.error('[LoySpaceGallery] Login error:', err);
      setAuthError(err?.response?.data?.detail || err.message || 'Login failed.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  // Capture canvas currently shown in MediaView
  const captureCurrentCanvas = useCallback(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 20;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.imageSmoothingEnabled = false;

    if (form?.mode === 'image' && imageObjRef?.current) {
      ctx.fillStyle = form.bgColor || '#000000';
      ctx.fillRect(0, 0, 64, 20);
      const dw = (form.dwBase || 64) * (form.zoom || 1);
      const dh = (form.dhBase || 20) * (form.zoom || 1);
      ctx.drawImage(imageObjRef.current, form.canvasX || 0, form.canvasY || 0, dw, dh);
    } else if (Array.isArray(form?.pixels) && form.pixels.length === 1280) {
      ctx.fillStyle = form?.bgColor || '#000000';
      ctx.fillRect(0, 0, 64, 20);
      const imgData = ctx.createImageData(64, 20);
      for (let i = 0; i < 1280; i++) {
        const p = form.pixels[i] ?? 0;
        let r = 0, g = 0, b = 0;
        if (typeof p === 'string' && p.startsWith('#')) {
          r = parseInt(p.slice(1, 3), 16) || 0;
          g = parseInt(p.slice(3, 5), 16) || 0;
          b = parseInt(p.slice(5, 7), 16) || 0;
        } else if (typeof p === 'number') {
          r = (p >> 16) & 0xff;
          g = (p >> 8) & 0xff;
          b = p & 0xff;
        }
        imgData.data[i * 4] = r;
        imgData.data[i * 4 + 1] = g;
        imgData.data[i * 4 + 2] = b;
        imgData.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(imgData, 0, 0);
    } else {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, 64, 20);
    }

    return canvas;
  }, [form, imageObjRef]);

  // Open Upload Dialog
  const handleOpenUploadModal = () => {
    if (isCanvasEmpty) return;
    const canvas = captureCurrentCanvas();
    if (!canvas) {
      if (onNotify) onNotify("No canvas available to upload.");
      return;
    }
    const dataUrl = canvas.toDataURL('image/png');
    setUploadPreviewUrl(dataUrl);
    setUploadName(form?.name || 'My LED Creation');
    setUploadMark('custom, 64x20');
    setUploadTagId(activeTab?.type === 1 ? activeTab.id : 13);
    setUploadError('');

    canvas.toBlob((blob) => {
      updateModalCenter();
      setUploadBlob(blob);
      setShowUploadModal(true);
    }, 'image/png');
  };

  // Submit Upload to LOY SPACE
  const handleUploadSubmit = async (e) => {
    if (e) e.preventDefault();
    if (!uploadBlob) {
      setUploadError("Canvas image not captured.");
      return;
    }
    setIsUploading(true);
    setUploadError('');

    try {
      const res = await uploadLoyMaterial({
        fileBlob: uploadBlob,
        name: uploadName.trim() || 'LEDSign Custom',
        mark: uploadMark.trim() || 'custom,64x20',
        tags: uploadTagId
      });

      if (res.status === 0) {
        setShowUploadModal(false);
        setHasUploads(true);
        setUserUploadCount(prev => prev + 1);
        if (onNotify) {
          onNotify(`Uploaded "${uploadName.trim() || 'Custom'}" to LOY SPACE community successfully!`);
        }
        // Clear target category cache so it reflects the new shared item
        delete cacheRef.current[uploadTagId];
        delete cacheRef.current[48]; // New tab
        // Switch to Uploads tab and reload so the new item shows immediately
        setActiveTab(MY_UPLOADS_TAB);
        delete cacheRef.current[MY_UPLOADS_TAB.id];
        loadMaterials(MY_UPLOADS_TAB, '', 0, false);
      } else {
        setUploadError(res.error || 'Upload failed.');
      }
    } catch (err) {
      console.error('[LoySpaceGallery] Upload error:', err);
      setUploadError(err?.response?.data?.detail || err.message || 'Failed to upload canvas.');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div 
      ref={galleryRef}
      className={`glass-panel flex flex-col ${className}`}
      style={{
        position: 'relative',
        background: 'var(--card-bg)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        color: '#f8fafc',
        overflow: 'hidden',
        height: 'auto',
        maxHeight: '92vh',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        ...style
      }}
    >
      {/* Header matching Gemini pop-up */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <LoySpaceLogo size={20} gradient={true} />
          <div>
            <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 800, color: '#f8fafc', letterSpacing: '-0.01em' }}>
              LOY SPACE
            </h4>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* Sign in / Sign out Button (labelled and styled same as Today's Schedule) */}
          <button
            type="button"
            onClick={handleAuthClick}
            className="btn-styled inactive"
            style={{ 
              padding: '6px 12px', 
              fontSize: 12, 
              display: 'flex', 
              alignItems: 'center', 
              gap: 6,
              cursor: 'pointer'
            }}
            title={authInfo?.logged_in && !authInfo?.is_guest ? `Signed in as ${authInfo?.nickname || authInfo?.user}` : "Sign in to LOY SPACE"}
          >
            {authInfo?.logged_in && !authInfo?.is_guest ? <LogOut size={13} /> : <LogIn size={13} />}
            <span>{authInfo?.logged_in && !authInfo?.is_guest ? 'Sign out' : 'Sign in'}</span>
          </button>

          {/* Refresh */}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isLoading}
            style={{
              background: 'none',
              border: 'none',
              color: '#94a3b8',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              padding: '2px',
              borderRadius: '6px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'color 0.15s ease'
            }}
            onMouseOver={e => e.currentTarget.style.color = '#ffffff'}
            onMouseOut={e => e.currentTarget.style.color = '#94a3b8'}
            title="Refresh LOY SPACE media"
          >
            <RefreshCw size={15} className={isLoading ? "animate-spin" : ""} />
          </button>

          {/* Close */}
          {onClose && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              style={{
                background: 'none',
                border: 'none',
                color: '#94a3b8',
                cursor: 'pointer',
                padding: '2px',
                borderRadius: '6px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'color 0.15s ease'
              }}
              onMouseOver={e => e.currentTarget.style.color = '#ffffff'}
              onMouseOut={e => e.currentTarget.style.color = '#94a3b8'}
              title="Close LOY SPACE"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Search Bar at Top */}
      <form 
        onSubmit={handleSearchSubmit} 
        style={{ marginBottom: '14px', flexShrink: 0, position: 'relative' }}
      >
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Search 
            size={14} 
            style={{ 
              position: 'absolute', 
              left: '12px', 
              color: searchQuery ? '#94a3b8' : '#64748b', 
              pointerEvents: 'none' 
            }} 
          />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search LOY SPACE media (e.g. eye, bike, car, smile)..."
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
          {searchQuery && (
            <button
              type="button"
              onClick={handleClearSearch}
              style={{
                position: 'absolute',
                right: '10px',
                background: 'none',
                border: 'none',
                color: '#94a3b8',
                cursor: 'pointer',
                padding: '4px',
                display: 'flex',
                alignItems: 'center'
              }}
              title="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </form>

      {/* Category Tabs: Upload Button -> Uploads Tab -> Newest -> Categories */}
      <div 
        ref={tabsScrollRef}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          overflowX: 'auto',
          paddingBottom: '8px',
          marginBottom: '12px',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          flexShrink: 0
        }}
      >
        {/* Upload Button: icon only, disabled if canvas empty */}
        <button
          type="button"
          onClick={handleOpenUploadModal}
          disabled={isCanvasEmpty}
          style={{
            height: '29px',
            padding: '0 10px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '20px',
            background: isCanvasEmpty
              ? 'rgba(255, 255, 255, 0.04)'
              : 'linear-gradient(#ffffff, #ffffff) padding-box, ' + LOY_GRADIENT + ' border-box',
            border: isCanvasEmpty
              ? '1px solid rgba(255, 255, 255, 0.08)'
              : '2px solid transparent',
            color: isCanvasEmpty ? '#64748b' : '#0f172a',
            opacity: isCanvasEmpty ? 0.45 : 1,
            cursor: isCanvasEmpty ? 'not-allowed' : 'pointer',
            transition: 'all 0.18s ease',
            boxShadow: isCanvasEmpty ? 'none' : '0 2px 8px rgba(0, 0, 0, 0.2), 0 0 6px rgba(251, 141, 0, 0.25)',
            flexShrink: 0
          }}
          title={isCanvasEmpty ? "Canvas is empty" : "Upload canvas to LOY community"}
        >
          <Upload size={13} />
        </button>

        {/* Uploads Tab: to the right of Upload (disabled if user has no uploads) */}
        <button
          type="button"
          disabled={!hasUploads}
          onClick={() => {
            if (hasUploads) {
              handleTabClick(MY_UPLOADS_TAB);
            }
          }}
          style={{
            height: '29px',
            padding: '0 13px',
            fontSize: '11px',
            fontWeight: (!activeSearch && activeTab.id === 'my_uploads') ? 700 : 500,
            whiteSpace: 'nowrap',
            borderRadius: '20px',
            border: (!activeSearch && activeTab.id === 'my_uploads')
              ? '2px solid transparent'
              : '1px solid rgba(255, 255, 255, 0.08)',
            background: (!activeSearch && activeTab.id === 'my_uploads')
              ? 'linear-gradient(#ffffff, #ffffff) padding-box, ' + LOY_GRADIENT + ' border-box'
              : 'rgba(255, 255, 255, 0.04)',
            color: (!activeSearch && activeTab.id === 'my_uploads') 
              ? '#0f172a' 
              : hasUploads ? '#94a3b8' : '#64748b',
            opacity: hasUploads ? 1 : 0.45,
            cursor: hasUploads ? 'pointer' : 'not-allowed',
            transition: 'all 0.18s ease',
            boxShadow: (!activeSearch && activeTab.id === 'my_uploads')
              ? '0 2px 8px rgba(0, 0, 0, 0.2), 0 0 8px rgba(251, 141, 0, 0.25)'
              : 'none',
            flexShrink: 0
          }}
          title={hasUploads ? "View your uploads" : "No uploads yet"}
        >
          {MY_UPLOADS_TAB.name}
        </button>

        {/* Categories: Newest, Eye, Motorcycle, etc. */}
        {categories.map(tab => {
          const isActive = !activeSearch && activeTab.id === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => handleTabClick(tab)}
              style={{
                height: '29px',
                padding: '0 13px',
                fontSize: '11px',
                fontWeight: isActive ? 700 : 500,
                whiteSpace: 'nowrap',
                borderRadius: '20px',
                border: isActive ? '2px solid transparent' : '1px solid rgba(255, 255, 255, 0.08)',
                background: isActive 
                  ? 'linear-gradient(#ffffff, #ffffff) padding-box, ' + LOY_GRADIENT + ' border-box' 
                  : 'rgba(255, 255, 255, 0.04)',
                color: isActive ? '#0f172a' : '#94a3b8',
                cursor: 'pointer',
                transition: 'all 0.18s ease',
                boxShadow: isActive ? '0 2px 8px rgba(0, 0, 0, 0.2), 0 0 8px rgba(251, 141, 0, 0.25)' : 'none',
                flexShrink: 0
              }}
            >
              {tab.name}
            </button>
          );
        })}
      </div>

      {/* Media Grid Container (with top/bottom padding to prevent highlight border clipping) */}
      <div 
        className="loy-gallery-scroll"
        style={{ 
          flex: '1 1 auto', 
          minHeight: 0, 
          maxHeight: 'calc(92vh - 170px)',
          overflowY: 'auto', 
          overflowX: 'hidden',
          padding: '6px 6px 12px 6px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px'
        }}
      >
        {error && (
          <div 
            style={{ 
              padding: '16px', 
              borderRadius: '14px', 
              background: 'rgba(239, 68, 68, 0.12)', 
              border: '1px solid rgba(239, 68, 68, 0.3)', 
              color: '#fca5a5', 
              fontSize: '12px', 
              display: 'flex', 
              flexDirection: 'column', 
              alignItems: 'center', 
              gap: '8px', 
              textAlign: 'center' 
            }}
          >
            <AlertCircle size={20} color="#ef4444" />
            <span>{error}</span>
            <button
              type="button"
              onClick={handleRefresh}
              className="btn-styled text-xs px-3 py-1.5"
              style={{ borderRadius: '8px', background: 'rgba(239, 68, 68, 0.25)', color: '#ffffff' }}
            >
              Retry Connection
            </button>
          </div>
        )}

        {isLoading && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '36px 0', gap: '12px' }}>
            <RefreshCw size={24} className="animate-spin" style={{ color: '#94a3b8' }} />
            <span style={{ fontSize: '12px', color: '#94a3b8' }}>Loading media...</span>
          </div>
        )}

        {!isLoading && items.length === 0 && !error && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '36px 0', gap: '10px', textAlign: 'center' }}>
            <ImageIcon size={32} style={{ color: '#475569' }} />
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#94a3b8' }}>
              {activeTab.id === 'my_uploads' ? 'No uploads yet' : 'No media found'}
            </span>
            <span style={{ fontSize: '11px', color: '#64748b', maxWidth: '280px' }}>
              {activeTab.id === 'my_uploads'
                ? 'Upload your first canvas to the LOY community using the upload button to the left.'
                : activeSearch 
                ? 'Try another keyword.' 
                : 'This category does not have 64×20 material uploaded yet.'}
            </span>
          </div>
        )}

        {/* 2-Column Responsive Card Grid (aspect ratio matching preset media canvas 64 / 20) */}
        {!isLoading && items.length > 0 && (
          <div 
            style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', 
              gap: '10px',
              padding: '2px 2px 8px 2px'
            }}
          >
            {items.map((item) => {
              const isSelected = selectedId === item.id;

              return (
                <div
                  key={item.id}
                  onClick={() => handleItemSelect(item)}
                  style={{
                    position: 'relative',
                    borderRadius: '16px',
                    border: isSelected 
                      ? '2px solid transparent' 
                      : '1px solid rgba(255, 255, 255, 0.08)',
                    background: isSelected
                      ? 'linear-gradient(rgba(20, 20, 25, 0.95), rgba(20, 20, 25, 0.95)) padding-box, ' + LOY_GRADIENT + ' border-box'
                      : 'rgba(255, 255, 255, 0.03)',
                    boxShadow: isSelected
                      ? '0 0 16px rgba(251, 141, 0, 0.35), 0 4px 12px rgba(0, 0, 0, 0.4)'
                      : 'none',
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
                  {/* Media Preview Box with 64/20 aspect ratio matching canvas */}
                  <div 
                    style={{ 
                      width: '100%', 
                      aspectRatio: '64 / 20', 
                      background: '#05070e', 
                      display: 'flex', 
                      alignItems: 'center', 
                      justifyContent: 'center',
                      position: 'relative',
                      overflow: 'hidden',
                      borderBottom: '1px solid rgba(255, 255, 255, 0.05)'
                    }}
                  >
                    <img 
                      src={item.url_pre}
                      alt={item.name}
                      loading="lazy"
                      onError={(e) => {
                        const proxyUrl = getLoyProxyMediaUrl(item.url);
                        if (e.currentTarget.src !== proxyUrl) {
                          e.currentTarget.src = proxyUrl;
                        }
                      }}
                      style={{ 
                        width: '100%', 
                        height: '100%', 
                        objectFit: 'contain',
                        imageRendering: 'pixelated'
                      }} 
                    />

                    {/* Spinning Indicator when selecting a card matching Google Images */}
                    {importingId === item.id && (
                      <div style={{
                        position: 'absolute',
                        inset: 0,
                        background: 'rgba(0, 0, 0, 0.7)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 10
                      }}>
                        <RefreshCw size={16} className="animate-spin text-white" />
                      </div>
                    )}
                  </div>

                  {/* Card Footer Details */}
                  <div 
                    style={{ 
                      padding: '8px 10px', 
                      background: 'rgba(255, 255, 255, 0.03)',
                      display: 'flex', 
                      alignItems: 'center', 
                      justifyContent: 'space-between',
                      gap: '6px'
                    }}
                  >
                    <span 
                      style={{ 
                        fontSize: '11px', 
                        fontWeight: 500, 
                        color: '#e2e8f0', 
                        overflow: 'hidden', 
                        textOverflow: 'ellipsis', 
                        whiteSpace: 'nowrap' 
                      }}
                      title={item.name}
                    >
                      {item.name}
                    </span>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px', color: '#64748b', flexShrink: 0 }}>
                      {item.count_use > 0 && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }} title={`${item.count_use} uses`}>
                          <Eye size={10} /> {item.count_use}
                        </span>
                      )}
                      {item.count_favorite > 0 && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }} title={`${item.count_favorite} favorites`}>
                          <Heart size={10} color="#f43f5e" /> {item.count_favorite}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Load More Button (only rendered when there are items and more to load) */}
        {items.length > 0 && hasMore && !isLoading && (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: '12px', marginBottom: '8px' }}>
            <button
              type="button"
              onClick={handleLoadMore}
              disabled={isLoadingMore}
              className="btn-styled text-xs px-5 py-2 flex items-center gap-2"
              style={{
                borderRadius: '12px',
                background: 'rgba(255, 255, 255, 0.06)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                color: '#e2e8f0',
                cursor: isLoadingMore ? 'not-allowed' : 'pointer'
              }}
            >
              {isLoadingMore ? (
                <>
                  <RefreshCw size={13} className="animate-spin" />
                  <span>Loading media...</span>
                </>
              ) : (
                <>
                  <Download size={13} />
                  <span>Load More</span>
                </>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Sign In Modal Dialog (Rendered in portal with fixed overlay so it is never clipped, centered horizontally on the downloads pop-up) */}
      {showAuthModal && typeof document !== 'undefined' && createPortal(
        <div 
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            zIndex: 100000
          }}
          onClick={() => !isLoggingIn && setShowAuthModal(false)}
        >
          <div 
            style={{
              position: 'fixed',
              left: modalCenter ? `${modalCenter.x}px` : '50%',
              top: modalCenter ? `${modalCenter.y}px` : '50%',
              transform: 'translate(-50%, -50%)',
              width: 'calc(100vw - 40px)',
              maxWidth: '380px',
              background: 'var(--card-bg)',
              backdropFilter: 'blur(24px)',
              WebkitBackdropFilter: 'blur(24px)',
              borderRadius: '24px',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              padding: '24px',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5)',
              color: '#f8fafc'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <LogIn size={18} className="text-amber-500" style={{ flexShrink: 0 }} />
                <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#f8fafc' }}>
                  Sign in to LOY SPACE
                </h3>
              </div>
              <button 
                type="button" 
                onClick={() => setShowAuthModal(false)}
                style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: '4px' }}
                title="Close"
              >
                <X size={16} />
              </button>
            </div>

            <p className="scan-passcode-recovery" style={{ marginBottom: '16px' }}>
              Sign in with your LOY SPACE account from the{' '}
              <a href="https://apps.apple.com/app/loy-space/id1636648229" target="_blank" rel="noopener noreferrer">App Store</a>
              {' '}or{' '}
              <a href="https://play.google.com/store/apps/details?id=com.yskd.loywf" target="_blank" rel="noopener noreferrer">Google Play</a>
              {' '}to link your uploads.
            </p>

            <div style={{ 
              padding: '10px 12px', 
              background: 'rgba(251, 141, 0, 0.08)', 
              border: '1px solid rgba(251, 141, 0, 0.25)', 
              borderRadius: '12px', 
              fontSize: '11px', 
              color: '#fdba74',
              marginBottom: '16px'
            }}>
              <strong>Guest Mode Active:</strong> You can upload, share, and download media without logging in.
            </div>

            {authError && (
              <div style={{ 
                padding: '8px 12px', 
                background: 'rgba(239, 68, 68, 0.15)', 
                border: '1px solid rgba(239, 68, 68, 0.3)', 
                borderRadius: '10px', 
                fontSize: '11px', 
                color: '#fca5a5', 
                marginBottom: '12px' 
              }}>
                {authError}
              </div>
            )}

            <form onSubmit={handleLoginSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
                  Phone Number or Email
                </label>
                <input 
                  className="input-field"
                  type="text" 
                  value={loginUser}
                  onChange={(e) => setLoginUser(e.target.value)}
                  placeholder="e.g. user@example.com"
                  style={{ width: '100%', fontSize: '13px', padding: '10px 14px' }}
                  autoFocus
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
                  Password
                </label>
                <input 
                  className="input-field"
                  type="password" 
                  value={loginPwd}
                  onChange={(e) => setLoginPwd(e.target.value)}
                  placeholder="Enter your account password"
                  style={{ width: '100%', fontSize: '13px', padding: '10px 14px' }}
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
                <button
                  type="button"
                  onClick={() => setShowAuthModal(false)}
                  disabled={isLoggingIn}
                  className="btn-styled inactive"
                  style={{ 
                    height: '36px',
                    padding: '0 16px',
                    borderRadius: '12px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxSizing: 'border-box',
                    fontSize: '12px',
                    lineHeight: '1'
                  }}
                >
                  Stay in Guest Mode
                </button>
                <button
                  type="submit"
                  disabled={isLoggingIn}
                  className="btn-styled"
                  style={{
                    height: '36px',
                    padding: '0 16px',
                    borderRadius: '12px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxSizing: 'border-box',
                    fontSize: '12px',
                    lineHeight: '1',
                    background: 'linear-gradient(#ffffff, #ffffff) padding-box, ' + LOY_GRADIENT + ' border-box',
                    border: '2px solid transparent',
                    color: '#0f172a',
                    fontWeight: 700,
                    gap: '6px',
                    cursor: isLoggingIn ? 'not-allowed' : 'pointer'
                  }}
                >
                  {isLoggingIn ? <RefreshCw size={13} className="animate-spin text-amber-500" /> : <LogIn size={13} />}
                  <span>{isLoggingIn ? 'Signing in...' : 'Sign in'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      {/* Upload Canvas Modal Dialog (Rendered in portal with fixed overlay so it is never clipped, centered horizontally on the downloads pop-up) */}
      {showUploadModal && typeof document !== 'undefined' && createPortal(
        <div 
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            zIndex: 100000
          }}
          onClick={() => !isUploading && setShowUploadModal(false)}
        >
          <div 
            style={{
              position: 'fixed',
              left: modalCenter ? `${modalCenter.x}px` : '50%',
              top: modalCenter ? `${modalCenter.y}px` : '50%',
              transform: 'translate(-50%, -50%)',
              width: 'calc(100vw - 40px)',
              maxWidth: '400px',
              background: 'var(--card-bg)',
              backdropFilter: 'blur(24px)',
              WebkitBackdropFilter: 'blur(24px)',
              borderRadius: '24px',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              padding: '24px',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)',
              color: '#f8fafc'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Upload size={18} className="text-amber-500" />
                <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#f8fafc' }}>
                  Upload Canvas to LOY Community
                </h3>
              </div>
              <button 
                type="button" 
                onClick={() => setShowUploadModal(false)}
                style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: '4px' }}
                title="Close"
              >
                <X size={16} />
              </button>
            </div>

            {/* Live Canvas Preview with 64/20 ratio */}
            <div style={{ marginBottom: '14px' }}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
                64 × 20 Canvas Preview
              </label>
              <div 
                style={{
                  width: '100%',
                  aspectRatio: '64 / 20',
                  background: '#05070e',
                  borderRadius: '12px',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden'
                }}
              >
                {uploadPreviewUrl ? (
                  <img 
                    src={uploadPreviewUrl} 
                    alt="Canvas Preview" 
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'contain',
                      imageRendering: 'pixelated'
                    }}
                  />
                ) : (
                  <span style={{ fontSize: '11px', color: '#64748b' }}>No preview available</span>
                )}
              </div>
            </div>

            {uploadError && (
              <div style={{ 
                padding: '8px 12px', 
                background: 'rgba(239, 68, 68, 0.15)', 
                border: '1px solid rgba(239, 68, 68, 0.3)', 
                borderRadius: '10px', 
                fontSize: '11px', 
                color: '#fca5a5', 
                marginBottom: '12px' 
              }}>
                {uploadError}
              </div>
            )}

            <form onSubmit={handleUploadSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
                  Media Name
                </label>
                <input 
                  className="input-field"
                  type="text" 
                  value={uploadName}
                  onChange={(e) => setUploadName(e.target.value)}
                  placeholder="e.g. Neon Cyber Helmet"
                  style={{ width: '100%', fontSize: '13px', padding: '10px 14px' }}
                  autoFocus
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
                  Category
                </label>
                <select
                  className="input-field"
                  value={uploadTagId}
                  onChange={(e) => setUploadTagId(Number(e.target.value))}
                  style={{ width: '100%', fontSize: '13px', padding: '10px 14px', background: '#1e1e26', color: '#f8fafc' }}
                >
                  {categories.filter((c) => c.type === 1).map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
                  Tags / Keywords
                </label>
                <input 
                  className="input-field"
                  type="text" 
                  value={uploadMark}
                  onChange={(e) => setUploadMark(e.target.value)}
                  placeholder="e.g. eye, bike, animation, pixel"
                  style={{ width: '100%', fontSize: '13px', padding: '10px 14px' }}
                />
              </div>

              <div style={{
                padding: '10px 14px',
                borderRadius: '12px',
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.06)',
                fontSize: '11px',
                color: '#94a3b8'
              }}>
                <span>Attribution: </span>
                <span style={{ color: '#ffffff', fontWeight: 600 }}>
                  {authInfo?.logged_in && !authInfo?.is_guest 
                    ? `${authInfo?.nickname || authInfo?.user}` 
                    : `Guest Mode (${authInfo?.nickname || 'Tourist'})`}
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px', marginTop: '6px' }}>
                <button
                  type="button"
                  onClick={() => setShowUploadModal(false)}
                  disabled={isUploading}
                  className="btn-styled inactive"
                  style={{ 
                    height: '36px',
                    padding: '0 16px',
                    borderRadius: '12px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxSizing: 'border-box',
                    fontSize: '12px',
                    lineHeight: '1'
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isUploading}
                  className="btn-styled"
                  style={{
                    height: '36px',
                    padding: '0 16px',
                    borderRadius: '12px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxSizing: 'border-box',
                    fontSize: '12px',
                    lineHeight: '1',
                    background: 'linear-gradient(#ffffff, #ffffff) padding-box, ' + LOY_GRADIENT + ' border-box',
                    border: '2px solid transparent',
                    color: '#0f172a',
                    fontWeight: 700,
                    gap: '6px',
                    cursor: isUploading ? 'not-allowed' : 'pointer'
                  }}
                >
                  {isUploading ? (
                    <>
                      <RefreshCw size={13} className="animate-spin text-amber-500" />
                      <span>Uploading & Sharing...</span>
                    </>
                  ) : (
                    <>
                      <Upload size={13} />
                      <span>Upload & Share</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
