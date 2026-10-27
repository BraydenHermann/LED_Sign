import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Search, X, RefreshCw, Download, Check, Eye, Heart, 
  AlertCircle, Image as ImageIcon 
} from 'lucide-react';
import { getLoyCategories, getLoyMaterials, getLoyProxyMediaUrl } from './serverApi';

// Official LOY SPACE Brand Colors & Gradient (from user-provided LOY SPACE logo)
export const LOY_GRADIENT = 'linear-gradient(135deg, #D80204 0%, #FB8D00 20%, #FADC02 40%, #1CAB1E 60%, #017FD6 80%, #843FB3 100%)';
export const LOY_SHADOW = '0 0 0 1px rgba(255, 255, 255, 0.2), 0 2px 10px rgba(216, 2, 4, 0.3)';

// Official LOY SPACE SVG Logo
export const LoySpaceLogo = ({ size = 16, className = "", gradient = false, style = {} }) => {
  const gradId = "loyspace-brand-grad";
  return (
    <svg 
      width={size} 
      height={size} 
      viewBox="0 0 1024 1024" 
      fill={gradient ? `url(#${gradId})` : "currentColor"} 
      className={className} 
      style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style }}
    >
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#D80204" />
          <stop offset="20%" stopColor="#FB8D00" />
          <stop offset="40%" stopColor="#FADC02" />
          <stop offset="60%" stopColor="#1CAB1E" />
          <stop offset="80%" stopColor="#017FD6" />
          <stop offset="100%" stopColor="#843FB3" />
        </linearGradient>
      </defs>
      <path 
        fillRule="evenodd" 
        clipRule="evenodd" 
        d="M 218 806 L 219 820 L 225 830 L 231 835 L 396 928 L 424 945 L 433 949 L 442 955 L 452 959 L 462 959 L 473 955 L 481 947 L 517 885 L 521 876 L 533 857 L 540 843 L 548 831 L 554 818 L 554 805 L 550 796 L 540 787 L 531 784 L 241 784 L 234 786 L 228 790 L 221 798 Z M 606 646 L 607 680 L 643 680 L 643 674 L 614 673 L 615 665 L 631 665 L 631 660 L 616 660 L 614 658 L 615 651 L 642 651 L 642 646 Z M 549 651 L 549 675 L 552 679 L 555 680 L 582 680 L 585 679 L 588 676 L 588 668 L 580 667 L 579 674 L 557 673 L 558 651 L 580 652 L 580 657 L 588 656 L 588 650 L 586 647 L 584 646 L 553 646 Z M 488 680 L 495 680 L 501 672 L 524 673 L 528 680 L 537 680 L 516 646 L 507 646 L 498 663 L 492 671 Z M 510 653 L 513 653 L 520 666 L 504 666 L 504 664 Z M 439 680 L 447 680 L 448 666 L 474 666 L 476 665 L 478 662 L 478 650 L 477 648 L 474 646 L 439 646 Z M 448 651 L 468 651 L 470 653 L 470 659 L 468 661 L 447 660 Z M 383 649 L 383 662 L 387 665 L 414 666 L 413 674 L 388 673 L 388 670 L 381 671 L 381 675 L 384 679 L 386 680 L 415 680 L 420 677 L 421 675 L 421 664 L 419 661 L 417 660 L 391 660 L 389 658 L 390 651 L 413 652 L 418 654 L 420 653 L 420 649 L 417 646 L 386 646 Z M 794 626 L 781 621 L 774 621 L 763 625 L 754 634 L 751 641 L 747 646 L 736 667 L 698 731 L 671 780 L 664 790 L 655 808 L 648 818 L 641 832 L 611 883 L 610 886 L 610 900 L 615 910 L 624 918 L 633 921 L 641 921 L 646 920 L 654 916 L 659 912 L 678 902 L 700 888 L 709 884 L 717 878 L 724 875 L 734 868 L 736 868 L 741 864 L 789 837 L 794 833 L 801 830 L 847 802 L 849 802 L 863 793 L 872 783 L 875 773 L 874 760 L 804 638 Z M 609 436 L 652 521 L 653 588 L 679 588 L 679 522 L 722 436 L 691 437 L 669 485 L 666 489 L 657 473 L 640 436 Z M 336 436 L 337 588 L 402 588 L 401 560 L 364 560 L 364 436 Z M 503 412 L 482 416 L 469 421 L 454 430 L 437 445 L 428 457 L 419 474 L 413 495 L 412 519 L 414 532 L 419 549 L 430 569 L 443 584 L 460 597 L 477 605 L 496 610 L 518 611 L 533 609 L 551 603 L 566 595 L 578 586 L 585 579 L 595 566 L 605 546 L 610 527 L 611 504 L 608 486 L 602 469 L 591 451 L 577 436 L 558 423 L 541 416 L 528 413 Z M 500 449 L 523 449 L 534 452 L 547 459 L 564 476 L 570 487 L 574 500 L 575 508 L 574 523 L 571 534 L 564 547 L 551 561 L 544 566 L 534 571 L 516 575 L 500 574 L 487 570 L 475 563 L 464 553 L 458 545 L 452 533 L 449 521 L 450 497 L 452 490 L 460 475 L 470 464 L 478 458 L 487 453 Z M 104 407 L 96 416 L 93 424 L 93 679 L 97 688 L 106 697 L 116 701 L 266 701 L 275 697 L 282 691 L 286 684 L 288 677 L 287 665 L 142 414 L 135 407 L 126 403 L 113 403 Z M 752 325 L 746 329 L 740 336 L 737 342 L 736 351 L 738 360 L 754 389 L 769 413 L 777 429 L 781 434 L 881 609 L 888 616 L 896 620 L 906 621 L 918 617 L 926 609 L 929 604 L 931 590 L 931 398 L 930 392 L 931 388 L 930 387 L 931 384 L 930 357 L 931 350 L 928 338 L 918 327 L 908 323 L 758 323 Z M 403 110 L 395 106 L 390 105 L 379 106 L 372 109 L 302 150 L 297 154 L 164 231 L 154 240 L 150 249 L 150 263 L 151 266 L 222 390 L 232 400 L 240 403 L 255 402 L 261 399 L 268 392 L 275 381 L 286 360 L 302 334 L 309 320 L 321 301 L 413 140 L 414 135 L 413 124 L 409 116 Z M 469 207 L 469 219 L 473 228 L 482 236 L 489 239 L 496 240 L 780 240 L 789 238 L 796 234 L 801 229 L 806 219 L 806 206 L 801 196 L 791 188 L 756 169 L 582 69 L 569 64 L 558 65 L 552 68 L 542 78 L 471 201 Z" 
      />
    </svg>
  );
};

// Default fallback categories in exact requested order
const DEFAULT_CATEGORIES = [
  { id: 48, name: "Newest", type: 0 },
  { id: 13, name: "Eye", type: 1 },
  { id: 14, name: "Motorcycle", type: 1 },
  { id: 1, name: "Exclusive", type: 1 },
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

export default function LoySpaceGallery({
  onClose,
  onSelectMedia,
  onNotify,
  style = {},
  className = ""
}) {
  const [categories, setCategories] = useState(DEFAULT_CATEGORIES);
  const [activeTab, setActiveTab] = useState(DEFAULT_CATEGORIES[0]);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [items, setItems] = useState([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [importingId, setImportingId] = useState(null);
  const tabsScrollRef = useRef(null);
  const searchInputRef = useRef(null);

  // Cache for loaded categories: { [tabId]: { items, pageIndex, hasMore } }
  const cacheRef = useRef({});

  // Fetch categories on mount
  useEffect(() => {
    let isMounted = true;
    getLoyCategories()
      .then(cats => {
        if (isMounted && Array.isArray(cats) && cats.length > 0) {
          setCategories(cats);
        }
      })
      .catch(err => {
        console.warn('[LoySpaceGallery] Could not load live categories, using defaults:', err);
      });
    return () => { isMounted = false; };
  }, []);

  // Fetch materials for current tab or search
  const loadMaterials = useCallback(async (tab, search = '', page = 0, isAppend = false) => {
    if (page === 0) {
      setIsLoading(true);
      setError('');
    } else {
      setIsLoadingMore(true);
    }

    try {
      const res = await getLoyMaterials({
        tagId: tab.id,
        tagType: tab.type,
        pageIndex: page,
        pageCount: 24,
        search: search
      });

      if (res.status === 0) {
        const newItems = res.data || [];
        setItems(prev => (isAppend ? [...prev, ...newItems] : newItems));
        setHasMore(res.has_more || false);
        setPageIndex(page);

        // Update cache for current category if not searching
        if (!search) {
          cacheRef.current[tab.id] = {
            items: isAppend ? [...(cacheRef.current[tab.id]?.items || []), ...newItems] : newItems,
            pageIndex: page,
            hasMore: res.has_more || false
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

  // Trigger load when tab or activeSearch changes
  useEffect(() => {
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
    setActiveTab(tab);
    if (activeSearch) {
      setActiveSearch('');
      setSearchQuery('');
    }
  };

  // Handle Search submit
  const handleSearchSubmit = (e) => {
    if (e) e.preventDefault();
    const query = searchQuery.trim();
    if (!query) {
      setActiveSearch('');
    } else {
      setActiveSearch(query);
    }
  };

  // Clear search
  const handleClearSearch = () => {
    setSearchQuery('');
    setActiveSearch('');
  };

  // Refresh current view
  const handleRefresh = () => {
    if (!activeSearch) {
      delete cacheRef.current[activeTab.id];
    }
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

  return (
    <div 
      className={`glass-panel flex flex-col ${className}`}
      style={{
        position: 'relative',
        background: 'var(--card-bg)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        color: '#f8fafc',
        overflow: 'hidden',
        height: '100%',
        maxHeight: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        ...style
      }}
    >
      {/* Header matching Gemini pop-up */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div 
            style={{ 
              width: '28px', 
              height: '28px', 
              borderRadius: '8px', 
              background: 'linear-gradient(#ffffff, #ffffff) padding-box, ' + LOY_GRADIENT + ' border-box',
              border: '2px solid transparent',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25), 0 0 6px rgba(251, 141, 0, 0.25)',
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center',
              color: '#0f172a',
              overflow: 'hidden'
            }}
          >
            <LoySpaceLogo size={16} gradient={true} />
          </div>
          <div>
            <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 800, color: '#f8fafc' }}>
              LOY SPACE
            </h4>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
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
              border: activeSearch 
                ? '1px solid rgba(251, 141, 0, 0.65)' 
                : '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '12px',
              outline: 'none',
              boxShadow: activeSearch ? '0 0 10px rgba(251, 141, 0, 0.25)' : 'none'
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

      {/* Active Search Banner */}
      {activeSearch && (
        <div 
          style={{ 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'space-between',
            padding: '6px 12px',
            marginBottom: '12px',
            borderRadius: '10px',
            background: 'rgba(251, 141, 0, 0.12)',
            border: '1px solid rgba(251, 141, 0, 0.3)',
            fontSize: '11px',
            color: '#fdba74',
            flexShrink: 0
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span>Searching:</span>
            <span style={{ fontWeight: 700, color: '#ffffff' }}>"{activeSearch}"</span>
            <span>({items.length} items)</span>
          </div>
          <button
            type="button"
            onClick={handleClearSearch}
            style={{
              background: 'none',
              border: 'none',
              color: '#fb923c',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '11px',
              textDecoration: 'underline'
            }}
          >
            Back to Categories
          </button>
        </div>
      )}

      {/* Category Tabs: Newest, Eye, Motorcycle, Exclusive, Driver, Expression, Warning, Picture, Pixel, Word, Auto Logos, Holidays, Creativity, Public Welfare, Business */}
      <div 
        ref={tabsScrollRef}
        style={{
          display: 'flex',
          gap: '6px',
          overflowX: 'auto',
          paddingBottom: '8px',
          marginBottom: '12px',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          flexShrink: 0
        }}
      >
        {categories.map(tab => {
          const isActive = !activeSearch && activeTab.id === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => handleTabClick(tab)}
              style={{
                padding: '6px 13px',
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

      {/* Media Grid Container */}
      <div 
        className="loy-gallery-scroll"
        style={{ 
          flex: '1 1 0%', 
          minHeight: 0, 
          maxHeight: '100%',
          overflowY: 'auto', 
          overflowX: 'hidden',
          paddingRight: '6px',
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
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 0', gap: '12px' }}>
            <RefreshCw size={24} className="animate-spin text-amber-500" />
            <span style={{ fontSize: '12px', color: '#94a3b8' }}>Loading media...</span>
          </div>
        )}

        {!isLoading && items.length === 0 && !error && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 0', gap: '10px', textAlign: 'center' }}>
            <ImageIcon size={32} style={{ color: '#475569' }} />
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#94a3b8' }}>No 64 × 20 media found</span>
            <span style={{ fontSize: '11px', color: '#64748b', maxWidth: '280px' }}>
              {activeSearch ? `No results for "${activeSearch}". Try another keyword.` : 'This category does not have 64×20 material uploaded yet.'}
            </span>
            {activeSearch && (
              <button
                type="button"
                onClick={handleClearSearch}
                className="btn-styled text-xs px-3 py-1.5"
                style={{ borderRadius: '8px', marginTop: '4px' }}
              >
                Clear Search
              </button>
            )}
          </div>
        )}

        {!isLoading && items.length > 0 && (
          <div 
            style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(2, 1fr)', 
              gap: '12px' 
            }}
          >
            {items.map((item) => {
              const isImporting = importingId === item.id;
              const isSelected = selectedId === item.id;
              return (
                <div
                  key={item.id}
                  onClick={() => handleItemSelect(item)}
                  style={{
                    position: 'relative',
                    borderRadius: '14px',
                    overflow: 'hidden',
                    background: isSelected 
                      ? `linear-gradient(#0b0f19, #0b0f19) padding-box, ${LOY_GRADIENT} border-box` 
                      : 'rgba(0, 0, 0, 0.3)',
                    border: isSelected 
                      ? '2px solid transparent' 
                      : '1px solid rgba(255, 255, 255, 0.08)',
                    cursor: isImporting ? 'wait' : 'pointer',
                    transition: 'all 0.2s ease',
                    boxShadow: isSelected 
                      ? '0 0 16px rgba(216, 2, 4, 0.35), 0 0 12px rgba(1, 127, 214, 0.35)' 
                      : 'none',
                    display: 'flex',
                    flexDirection: 'column'
                  }}
                  className="group hover:border-pink-500/50 hover:scale-[1.01]"
                  title={`Click to load "${item.name}"`}
                >
                  {/* Media Preview Box (Strictly 64x20 Aspect Ratio = 3.2:1) */}
                  <div 
                    style={{ 
                      position: 'relative', 
                      width: '100%', 
                      paddingTop: '31.25%', // 20 / 64 = 31.25%
                      background: '#090d16',
                      backgroundImage: 'radial-gradient(rgba(255, 255, 255, 0.07) 1px, transparent 1px)',
                      backgroundSize: '8px 8px',
                      overflow: 'hidden'
                    }}
                  >
                    <img
                      src={item.url_pre || item.url}
                      alt={item.name}
                      loading="lazy"
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                        objectFit: 'contain',
                        imageRendering: 'pixelated'
                      }}
                      onError={(e) => {
                        if (!e.target.dataset.triedProxy) {
                          e.target.dataset.triedProxy = "true";
                          e.target.src = getLoyProxyMediaUrl(item.url);
                        }
                      }}
                    />

                    {/* Importing Spinner Overlay */}
                    {isImporting && (
                      <div 
                        style={{ 
                          position: 'absolute', 
                          inset: 0, 
                          background: 'rgba(0, 0, 0, 0.7)', 
                          display: 'flex', 
                          alignItems: 'center', 
                          justifyContent: 'center',
                          gap: '6px',
                          color: '#ffffff',
                          fontSize: '11px',
                          fontWeight: 600
                        }}
                      >
                        <RefreshCw size={14} className="animate-spin text-amber-500" />
                        <span>Importing...</span>
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

        {/* Load More Button */}
        {hasMore && !isLoading && (
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
                  <RefreshCw size={13} className="animate-spin text-amber-500" />
                  <span>Loading more items...</span>
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
