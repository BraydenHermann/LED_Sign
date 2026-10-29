import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Search, X, RefreshCw, SlidersHorizontal, 
  Image as ImageIcon, Check, ChevronDown, Download
} from 'lucide-react';
import { searchGoogleImages, getGoogleProxyMediaUrl } from './serverApi';

// Official Google 'G' 4-color SVG Logo
export const GoogleLogo = ({ size = 16, className = "", style = {} }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    className={className} 
    style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style }}
  >
    <path 
      fill="#4285F4" 
      d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.17z" 
    />
    <path 
      fill="#34A853" 
      d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.35 24 12 24z" 
    />
    <path 
      fill="#FBBC05" 
      d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.18 0 9.99 0 12s.45 3.82 1.25 5.42l4.03-3.15z" 
    />
    <path 
      fill="#EA4335" 
      d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.35 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98z" 
    />
  </svg>
);

// Google Brand Styling & Gradient (matching the Open Google Images button)
export const GOOGLE_GRADIENT = 'linear-gradient(135deg, #4285F4 0%, #EA4335 33%, #FBBC05 66%, #34A853 100%)';
export const GOOGLE_PILL_ACTIVE_BG = 'linear-gradient(#ffffff, #ffffff) padding-box, linear-gradient(135deg, #4285F4 0%, #EA4335 33%, #FBBC05 66%, #34A853 100%) border-box';
export const GOOGLE_SHADOW = '0 2px 8px rgba(0, 0, 0, 0.2), 0 0 8px rgba(66, 133, 244, 0.35)';

// Category chips defaulted to wide aspect ratio for the LED matrix
const QUICK_TABS = [
  { id: 'all', label: 'All Images', type: '', aspect: 'wide', color: '' },
  { id: 'gif', label: 'GIFs', type: 'animated', aspect: 'wide', color: '' },
  { id: 'wide', label: 'Wide Banner', type: '', aspect: 'wide', color: '' },
  { id: 'trans', label: 'Transparent', type: '', aspect: 'wide', color: 'trans' },
  { id: 'clipart', label: 'Clip Art', type: 'clipart', aspect: 'wide', color: '' },
];

const COLOR_SWATCHES = [
  { id: '', label: 'Any Color', color: 'transparent', border: 'rgba(255,255,255,0.2)' },
  { id: 'trans', label: 'Transparent', color: 'linear-gradient(45deg, #475569 25%, transparent 25%, transparent 75%, #475569 75%, #475569), linear-gradient(45deg, #475569 25%, transparent 25%, transparent 75%, #475569 75%, #475569)' },
  { id: 'gray', label: 'Black & White', color: '#64748b' },
  { id: 'red', label: 'Red', color: '#ef4444' },
  { id: 'orange', label: 'Orange', color: '#f97316' },
  { id: 'yellow', label: 'Yellow', color: '#eab308' },
  { id: 'green', label: 'Green', color: '#22c55e' },
  { id: 'teal', label: 'Teal', color: '#14b8a6' },
  { id: 'blue', label: 'Blue', color: '#3b82f6' },
  { id: 'purple', label: 'Purple', color: '#a855f7' },
  { id: 'pink', label: 'Pink', color: '#ec4899' },
  { id: 'white', label: 'White', color: '#ffffff' },
  { id: 'black', label: 'Black', color: '#000000', border: 'rgba(255,255,255,0.4)' },
];

const TYPE_OPTIONS = [
  { value: '', label: 'Any type' },
  { value: 'animated', label: 'GIF / Animated' },
  { value: 'clipart', label: 'Clip art' },
  { value: 'lineart', label: 'Line drawing' }
];

const ASPECT_OPTIONS = [
  { value: 'wide', label: 'Wide (Sign 3.2:1)' },
  { value: '', label: 'Any aspect' },
  { value: 'square', label: 'Square' },
  { value: 'tall', label: 'Tall / Portrait' }
];

const SIZE_OPTIONS = [
  { value: '', label: 'Any size' },
  { value: 'large', label: 'Large' },
  { value: 'medium', label: 'Medium' },
  { value: 'icon', label: 'Icon / Pixel' }
];

// Custom select dropdown matching Text > Animation dropdown style exactly
function DropdownSelect({ label, value, options, onChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const currentOption = options.find(o => o.value === value) || options[0];

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <label style={{ display: 'block', color: '#94a3b8', fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>
        {label}
      </label>
      <button
        type="button"
        onClick={() => setIsOpen(prev => !prev)}
        style={{
          width: '100%',
          background: '#1a1a1f',
          border: '1px solid rgba(255, 255, 255, 0.15)',
          borderRadius: '14px',
          color: '#ffffff',
          padding: '8px 12px',
          fontSize: '11px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          textAlign: 'left',
          outline: 'none',
          boxShadow: 'none'
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {currentOption?.label}
        </span>
        <ChevronDown 
          size={13} 
          className="text-slate-400 transition-transform duration-200"
          style={{ transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)', flexShrink: 0, marginLeft: 4 }}
        />
      </button>

      {isOpen && (
        <div 
          className="glass-panel"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            width: '100%',
            background: '#1a1a1f',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            borderRadius: '14px',
            overflow: 'hidden',
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.7)',
            zIndex: 60,
            maxHeight: '220px',
            overflowY: 'auto'
          }}
        >
          {options.map(opt => {
            const isSelected = opt.value === value;
            return (
              <div
                key={opt.value}
                onClick={() => {
                  onChange(opt.value);
                  setIsOpen(false);
                }}
                className="hover:bg-white/10 transition-colors"
                style={{
                  padding: '8px 14px',
                  fontSize: '12px',
                  cursor: 'pointer',
                  color: isSelected ? '#34d399' : '#f1f5f9',
                  fontWeight: isSelected ? '600' : 'normal',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between'
                }}
              >
                <span style={{ whiteSpace: 'nowrap' }}>{opt.label}</span>
                {isSelected && <Check size={13} className="text-emerald-400" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// In-memory persistent state so closing and reopening the side panel retains search and filters
let _savedGoogleState = {
  activeTab: QUICK_TABS[0],
  query: '',
  aspectFilter: 'wide',
  typeFilter: '',
  colorFilter: '',
  sizeFilter: '',
  items: [],
  pageIndex: 1,
  hasMore: false,
};

export default function GoogleMediaGallery({
  onClose,
  onSelectMedia,
  onNotify,
  form,
  style = {},
  className = ""
}) {
  const [query, setQuery] = useState(() => _savedGoogleState.query || '');
  const [activeTab, setActiveTab] = useState(() => _savedGoogleState.activeTab || QUICK_TABS[0]);
  const [showFilters, setShowFilters] = useState(false);

  // Filters (Aspect ratio defaults to 'wide' for the sign matrix)
  const [aspectFilter, setAspectFilter] = useState(() => _savedGoogleState.aspectFilter || 'wide');
  const [typeFilter, setTypeFilter] = useState(() => _savedGoogleState.typeFilter || '');
  const [colorFilter, setColorFilter] = useState(() => _savedGoogleState.colorFilter || '');
  const [sizeFilter, setSizeFilter] = useState(() => _savedGoogleState.sizeFilter || '');

  const [items, setItems] = useState(() => _savedGoogleState.items || []);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [pageIndex, setPageIndex] = useState(() => _savedGoogleState.pageIndex || 1);
  const [hasMore, setHasMore] = useState(() => _savedGoogleState.hasMore || false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [importingId, setImportingId] = useState(null);
  const searchInputRef = useRef(null);
  const hasRestoredRef = useRef(_savedGoogleState.items.length > 0);

  // Sync state to memory cache across panel unmounts
  useEffect(() => {
    _savedGoogleState = {
      activeTab,
      query,
      aspectFilter,
      typeFilter,
      colorFilter,
      sizeFilter,
      items,
      pageIndex,
      hasMore
    };
  }, [activeTab, query, aspectFilter, typeFilter, colorFilter, sizeFilter, items, pageIndex, hasMore]);

  // Sync quick tab selection with filters (maintaining wide aspect default)
  const handleSelectTab = (tab) => {
    setActiveTab(tab);
    setTypeFilter(tab.type || '');
    setAspectFilter(tab.aspect || 'wide');
    setColorFilter(tab.color || '');
    setPageIndex(1);
  };

  const fetchImages = useCallback(async (isLoadMore = false, overrideQuery = null) => {
    const q = (overrideQuery !== null ? overrideQuery : query).trim();
    if (!q) {
      setItems([]);
      setError('');
      setIsLoading(false);
      setIsLoadingMore(false);
      setHasMore(false);
      return;
    }

    if (isLoadMore) setIsLoadingMore(true);
    else setIsLoading(true);
    setError('');

    const targetPage = isLoadMore ? pageIndex + 1 : 1;

    try {
      // 24 items per page matching LOY SPACE pagination
      const data = await searchGoogleImages({
        q,
        type: typeFilter || undefined,
        aspect: aspectFilter || undefined,
        color: colorFilter || undefined,
        size: sizeFilter || undefined,
        page: targetPage,
        limit: 24
      });

      let newItems = Array.isArray(data?.items) ? data.items : [];

      // If user requested animated GIFs, ensure we only keep genuine animated GIFs
      if (typeFilter === 'animated') {
        newItems = newItems.filter(item => {
          const isGifUrl = item.originalUrl.toLowerCase().includes('.gif') || item.originalUrl.toLowerCase().includes('giphy.com');
          return Boolean(item.isAnimated || isGifUrl);
        });
      }

      if (isLoadMore) {
        setItems(prev => {
          const existingUrls = new Set(prev.map(p => p.originalUrl));
          const unique = newItems.filter(item => !existingUrls.has(item.originalUrl));
          return [...prev, ...unique];
        });
        setPageIndex(targetPage);
        setHasMore(newItems.length >= 12);
      } else {
        setItems(newItems);
        setPageIndex(1);
        setHasMore(newItems.length >= 12);
      }

      if (!newItems.length && !isLoadMore) {
        setError(`No images found for "${q}". Try adjusting your query or filter controls.`);
      }
    } catch (err) {
      console.error('[GoogleMediaGallery] Search error:', err);
      setError(err?.response?.data?.detail || err?.message || 'Failed to search Google Images.');
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  }, [query, typeFilter, aspectFilter, colorFilter, sizeFilter, pageIndex]);

  // Real-time debounced auto-search matching LOY SPACE behavior
  useEffect(() => {
    if (hasRestoredRef.current) {
      hasRestoredRef.current = false;
      return;
    }

    if (!query.trim()) {
      setItems([]);
      setError('');
      setIsLoading(false);
      return;
    }

    const timer = setTimeout(() => {
      fetchImages(false);
    }, 400);

    return () => clearTimeout(timer);
  }, [query, typeFilter, aspectFilter, colorFilter, sizeFilter]);

  const handleClearSearch = () => {
    setQuery('');
    setError('');
    setItems([]);
    if (searchInputRef.current) {
      searchInputRef.current.focus();
    }
  };

  const handleItemClick = async (item) => {
    if (!item?.originalUrl) return;
    setSelectedId(item.id);
    setImportingId(item.id);
    try {
      if (onSelectMedia) {
        await onSelectMedia(item);
      }
      if (onNotify) {
        onNotify(`Applied ${item.isAnimated ? 'GIF' : 'Image'} from Google Images!`);
      }
    } catch (err) {
      console.error('[GoogleMediaGallery] Error importing media:', err);
      // Remove any item that fails to load or returns corrupt format error from the list!
      setItems(prev => prev.filter(i => i.id !== item.id));
      if (onNotify) {
        onNotify(`Removed unsupported image: ${item.title || 'media'}`);
      }
    } finally {
      setImportingId(null);
    }
  };

  const hasActiveFilters = Boolean(typeFilter || (aspectFilter && aspectFilter !== 'wide') || colorFilter || sizeFilter);

  const clearAllFilters = () => {
    setTypeFilter('');
    setAspectFilter('wide');
    setColorFilter('');
    setSizeFilter('');
    setActiveTab(QUICK_TABS[0]);
    setPageIndex(1);
  };

  const handleLoadMore = () => {
    if (isLoadingMore || !hasMore) return;
    fetchImages(true);
  };

  return (
    <div 
      data-google-side-panel="true"
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
      {/* Header matching LOY SPACE & Gemini text size and close button */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <GoogleLogo size={20} />
          <div>
            <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 800, color: '#f8fafc', letterSpacing: '-0.01em' }}>
              Google Images
            </h4>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* Tools / Filters Toggle styled with Google colors */}
          <button
            type="button"
            onClick={() => setShowFilters(prev => !prev)}
            style={{
              height: '28px',
              padding: '0 11px',
              borderRadius: '20px',
              background: showFilters || hasActiveFilters
                ? GOOGLE_PILL_ACTIVE_BG
                : 'rgba(255, 255, 255, 0.04)',
              border: showFilters || hasActiveFilters
                ? '2px solid transparent'
                : '1px solid rgba(255, 255, 255, 0.08)',
              color: showFilters || hasActiveFilters ? '#0f172a' : '#94a3b8',
              fontSize: '11px',
              fontWeight: showFilters || hasActiveFilters ? 700 : 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
              boxShadow: showFilters || hasActiveFilters ? GOOGLE_SHADOW : 'none',
              transition: 'all 0.18s ease'
            }}
            title="Google Images Filter Controls"
          >
            <SlidersHorizontal size={12} />
            <span>Tools</span>
            {hasActiveFilters && (
              <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#4285F4' }} />
            )}
          </button>

          {/* Refresh button */}
          <button
            type="button"
            onClick={() => fetchImages(false)}
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
            title="Refresh Google Images"
          >
            <RefreshCw size={15} className={isLoading ? "animate-spin" : ""} />
          </button>

          {/* X button matching LOY SPACE */}
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
              title="Close Google Images"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Search Input Bar (matching LOY SPACE search style; Enter does not save preset) */}
      <div style={{ marginBottom: '14px', flexShrink: 0, position: 'relative' }}>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Search 
            size={14} 
            style={{ 
              position: 'absolute', 
              left: '12px', 
              color: query ? '#94a3b8' : '#64748b', 
              pointerEvents: 'none' 
            }} 
          />
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                fetchImages(false);
              }
            }}
            placeholder="Search Google Images, GIFs, graphics (e.g. neon car, pixel cat)..."
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
      </div>

      {/* Category Tabs styled identically to LOY SPACE "Eye" tab with Google colors */}
      <div 
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
        className="no-scrollbar"
      >
        {QUICK_TABS.map(tab => {
          const isActive = (
            (tab.type || '') === (typeFilter || '') &&
            (tab.aspect || 'wide') === (aspectFilter || 'wide') &&
            (tab.color || '') === (colorFilter || '') &&
            !sizeFilter
          );
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => handleSelectTab(tab)}
              style={{
                height: '29px',
                padding: '0 13px',
                fontSize: '11px',
                fontWeight: isActive ? 700 : 500,
                whiteSpace: 'nowrap',
                borderRadius: '20px',
                border: isActive ? '2px solid transparent' : '1px solid rgba(255, 255, 255, 0.08)',
                background: isActive 
                  ? GOOGLE_PILL_ACTIVE_BG
                  : 'rgba(255, 255, 255, 0.04)',
                color: isActive ? '#0f172a' : '#94a3b8',
                cursor: 'pointer',
                transition: 'all 0.18s ease',
                boxShadow: isActive ? GOOGLE_SHADOW : 'none',
                flexShrink: 0
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Expandable Filter Controls Drawer */}
      {showFilters && (
        <div 
          style={{
            background: 'rgba(255, 255, 255, 0.03)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: '16px',
            padding: '12px',
            marginBottom: '12px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            flexShrink: 0
          }}
        >
          {/* Dropdown Filters row */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <DropdownSelect 
              label="Aspect" 
              value={aspectFilter} 
              options={ASPECT_OPTIONS} 
              onChange={(val) => {
                setAspectFilter(val);
                setPageIndex(1);
              }} 
            />
            <DropdownSelect 
              label="Type" 
              value={typeFilter} 
              options={TYPE_OPTIONS} 
              onChange={(val) => {
                setTypeFilter(val);
                setPageIndex(1);
              }} 
            />
            <DropdownSelect 
              label="Size" 
              value={sizeFilter} 
              options={SIZE_OPTIONS} 
              onChange={(val) => {
                setSizeFilter(val);
                setPageIndex(1);
              }} 
            />
          </div>

          {/* Color Swatch Filters */}
          <div>
            <label style={{ display: 'block', color: '#94a3b8', fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>
              Color Tint
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
              {COLOR_SWATCHES.map(sw => {
                const isSelected = colorFilter === sw.id;
                return (
                  <button
                    key={sw.id}
                    type="button"
                    onClick={() => {
                      setColorFilter(isSelected ? '' : sw.id);
                      setPageIndex(1);
                    }}
                    title={sw.label}
                    style={{
                      width: '20px',
                      height: '20px',
                      borderRadius: '50%',
                      background: sw.color,
                      border: isSelected 
                        ? '2px solid #ffffff' 
                        : (sw.border || '1px solid rgba(255, 255, 255, 0.2)'),
                      transform: isSelected ? 'scale(1.2)' : 'scale(1)',
                      boxShadow: isSelected ? '0 0 8px rgba(255, 255, 255, 0.6)' : 'none',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease'
                    }}
                  />
                );
              })}
            </div>
          </div>

          {/* Action Row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingTop: '4px' }}>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearAllFilters}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#94a3b8',
                  fontSize: '11px',
                  cursor: 'pointer',
                  padding: '2px 6px',
                  textDecoration: 'underline'
                }}
              >
                Reset filters
              </button>
            )}
          </div>
        </div>
      )}

      {/* Error Notice */}
      {error && query.trim() && (
        <div style={{
          background: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid rgba(239, 68, 68, 0.25)',
          color: '#f87171',
          padding: '8px 12px',
          borderRadius: '8px',
          fontSize: '11px',
          marginBottom: '10px',
          flexShrink: 0
        }}>
          {error}
        </div>
      )}

      {/* Media Grid Container with vertical slider from LOY SPACE (loy-gallery-scroll) */}
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
        {/* Loading state colored same as LOY SPACE Loading media... (#94a3b8) */}
        {isLoading && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '36px 0', gap: '12px' }}>
            <RefreshCw size={24} className="animate-spin" style={{ color: '#94a3b8' }} />
            <span style={{ fontSize: '12px', color: '#94a3b8' }}>Searching Google Images...</span>
          </div>
        )}

        {/* Empty state */}
        {!isLoading && (!query.trim() || items.length === 0) && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '36px 0', gap: '10px', textAlign: 'center' }}>
            <ImageIcon size={32} style={{ color: '#475569' }} />
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#94a3b8' }}>
              {!query.trim() ? "Search Google Images" : "No images found"}
            </span>
            <span style={{ fontSize: '11px', color: '#64748b', maxWidth: '280px' }}>
              {!query.trim() 
                ? 'Type in the search bar above or choose a category chip to search Google.' 
                : 'Try adjusting your search terms or filter controls to find graphics.'}
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
              const isImporting = importingId === item.id;

              // If it's an animated GIF, use the proxy media URL so that multi-frame animated GIFs actually animate in the preview card
              const displaySrc = item.isAnimated
                ? getGoogleProxyMediaUrl(item.originalUrl)
                : (item.thumbnailUrl || item.originalUrl);

              return (
                <div
                  key={item.id}
                  onClick={() => !isImporting && handleItemClick(item)}
                  style={{
                    position: 'relative',
                    borderRadius: '16px',
                    border: isSelected 
                      ? '2px solid transparent' 
                      : '1px solid rgba(255, 255, 255, 0.08)',
                    background: isSelected
                      ? 'linear-gradient(rgba(20, 20, 25, 0.95), rgba(20, 20, 25, 0.95)) padding-box, ' + GOOGLE_GRADIENT + ' border-box'
                      : 'rgba(255, 255, 255, 0.03)',
                    boxShadow: isSelected
                      ? '0 0 16px rgba(66, 133, 244, 0.35), 0 4px 12px rgba(0, 0, 0, 0.4)'
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
                      src={displaySrc}
                      alt={item.title}
                      loading="lazy"
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'contain',
                        display: 'block'
                      }}
                      onError={() => {
                        // Immediately remove corrupt or unsupported image format from the list
                        setItems(prev => prev.filter(i => i.id !== item.id));
                      }}
                    />

                    {/* Dimensions Badge */}
                    {item.width > 0 && item.height > 0 && (
                      <span style={{
                        position: 'absolute',
                        bottom: '5px',
                        right: '5px',
                        background: 'rgba(0, 0, 0, 0.75)',
                        color: '#cbd5e1',
                        fontSize: '9px',
                        fontWeight: 600,
                        padding: '1px 5px',
                        borderRadius: '4px'
                      }}>
                        {item.width}×{item.height}
                      </span>
                    )}

                    {/* Loading Overlay without Applying... label */}
                    {isImporting && (
                      <div style={{
                        position: 'absolute',
                        inset: 0,
                        background: 'rgba(0, 0, 0, 0.7)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}>
                        <RefreshCw size={16} className="animate-spin text-white" />
                      </div>
                    )}
                  </div>

                  {/* Card Info matching LOY SPACE cards */}
                  <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    <p style={{
                      fontSize: '11px',
                      fontWeight: 700,
                      color: isSelected ? '#ffffff' : '#f1f5f9',
                      margin: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}>
                      {item.title}
                    </p>
                    {item.sourceDomain && (
                      <span style={{ fontSize: '9px', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.sourceDomain}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Load More Button copied from LOY SPACE flow */}
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
    </div>
  );
}
