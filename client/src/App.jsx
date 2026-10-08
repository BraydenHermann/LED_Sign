import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { savePresetToSign, processVideoMedia } from './serverApi';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Power, Sun, Calendar, Image as ImageIcon, Bluetooth, Wifi,
  Activity, Upload, Clock, ExternalLink, Link2Off, Link2,
  FileSearch, Search, RefreshCw, RotateCcw, StretchHorizontal, StretchVertical, EyeOff, ChevronRight, ChevronDown, X,
  ChevronLeft, AlertCircle, Eraser, Undo2, Redo2, Plus, Pencil, Zap, Gauge, Check,
  Trash2, Pipette, Save, Send, Star, Download, Crosshair, Grid3X3, ScanLine
} from 'lucide-react';

const API_BASE = '';
const DEFAULT_MAC = '';
const SCAN_PAGE_SIZE = 6;
const PANEL_W = 64;
const PANEL_H = 20;

// IndexedDB database storage helper functions to bypass 5MB localStorage limits
const dbName = "LEDSignDB";
const storeName = "presets_store";
const keyName = "presets_list";
const savedPresetsKeyName = "saved_presets_list";

function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName);
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

async function savePresetsToDB(presetsList) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const request = store.put(presetsList, keyName);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = () => { db.close(); reject(tx.error || request.error); };
    tx.onerror = () => reject(tx.error || request.error);
  });
}

async function getPresetsFromDB() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const request = store.get(keyName);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function saveSavedPresetsToDB(savedPresetsList) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const request = store.put(savedPresetsList, savedPresetsKeyName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function getSavedPresetsFromDB() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const request = store.get(savedPresetsKeyName);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

// Stable preview URL — only regenerated when fetchStatus sees a new image
let _lastFrames = -1;

function formatMac(raw) {
  const hex = raw.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  const pairs = hex.match(/.{1,2}/g) || [];
  return pairs.slice(0, 6).join(':');
}

const getColorAtPercent = (pct) => {
  const p = Math.min(Math.max(pct, 0), 1);
  if (p >= 0.95) return '#000000';
  if (p >= 0.90) return '#ffffff';
  const hue = Math.round((p / 0.90) * 300);
  return hslToHex(hue, 100, 50);
};

const getClockPixels = (time, format = '12h') => {
  if (typeof document === 'undefined') return Array(64 * 20).fill(0);
  try {
    const dateObj = (time instanceof Date && !isNaN(time.getTime())) ? time : new Date();
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 20;
    const ctx = canvas.getContext('2d');
    if (!ctx) return Array(64 * 20).fill(0);

    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, 64, 20);
    ctx.fillStyle = 'white';

    const hours = dateObj.getHours();
    const minutes = String(dateObj.getMinutes()).padStart(2, '0');
    let textToDraw = '';
    if (format === '24h') {
      const hoursStr = String(hours).padStart(2, '0');
      textToDraw = `${hoursStr}:${minutes}`;
      ctx.font = '14px Arial, sans-serif';
    } else {
      const ampm = hours >= 12 ? 'PM' : 'AM';
      const displayHours = hours % 12 || 12;
      textToDraw = `${displayHours}:${minutes} ${ampm}`;
      ctx.font = '11px Arial, sans-serif';
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(textToDraw, 32, 10);

    const data = ctx.getImageData(0, 0, 64, 20).data;
    const pixels = [];
    for (let i = 0; i < data.length; i += 4) {
      const brightness = (data[i] + data[i+1] + data[i+2]) / 3;
      pixels.push(brightness / 255);
    }
    return pixels;
  } catch (e) {
    console.error("Failed to generate clock pixels:", e);
    return Array(64 * 20).fill(0);
  }
};

function isEventActive(ev, atTime) {
  if (!ev?.start_iso || !ev?.end_iso) return false;
  const start = new Date(ev.start_iso);
  const end = new Date(ev.end_iso);
  return atTime >= start && atTime <= end;
}

// Returns true if event is active or starts within `leadTimeMs` ms (default 5 minutes)
function isEventInWindow(ev, atTime, leadTimeMs = 5 * 60 * 1000) {
  if (!ev?.start_iso || !ev?.end_iso) return false;
  const start = new Date(ev.start_iso);
  const end = new Date(ev.end_iso);
  const earlyStart = new Date(start.getTime() - leadTimeMs);
  return atTime >= earlyStart && atTime <= end;
}

// Give an imminent meeting priority during its five-minute lead window. Once
// every candidate is already active, the most recently started meeting wins;
// this naturally returns to a still-active earlier event when the newer one ends.
function selectCalendarEvent(events, atTime) {
  const candidates = (events || []).filter(ev => isEventInWindow(ev, atTime) && ev.response_status?.toLowerCase() !== 'declined');
  const upcoming = candidates.filter(ev => new Date(ev.start_iso) > atTime);
  if (upcoming.length) return upcoming.sort((a, b) => new Date(a.start_iso) - new Date(b.start_iso))[0];
  return candidates.sort((a, b) => new Date(b.start_iso) - new Date(a.start_iso))[0] || null;
}

// Strip diacritics/accents and unsupported characters so hardware-limited signs and previews receive pure clean ASCII
// e.g. "Sébastien" → "Sebastien", "naïve" → "naive", "œ" → "oe", "—" → "-"
function normalizeForSign(str) {
  if (!str) return str;
  return str
    .replace(/[œŒ]/g, m => m === 'œ' ? 'oe' : 'OE')
    .replace(/[æÆ]/g, m => m === 'æ' ? 'ae' : 'AE')
    .replace(/[‘’]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function getEventDisplayString(ev) {
  if (!ev) return 'IN A MEETING';
  const summary = ev.summary || 'Untitled Event';
  try {
    const endD = new Date(ev.end_iso);
    const timeFmt = new Intl.DateTimeFormat(undefined, { 
      hour: 'numeric', 
      minute: '2-digit', 
      hour12: true 
    });
    const rawEndTimeStr = timeFmt.format(endD).toLowerCase();
    const shortEndTimeStr = rawEndTimeStr.replace(/\s*(am|pm)/gi, '').trim();

    const maxLen = 25;
    const withAmPm = `${summary} - ${rawEndTimeStr}`;
    const withShort = `${summary} - ${shortEndTimeStr}`;

    let signText;
    if (withAmPm.length <= maxLen) {
      // If the event title and end time fit within the 25 character limit, include the am/pm labels
      signText = withAmPm;
    } else if (withShort.length <= maxLen) {
      // Otherwise, do not include it
      signText = withShort;
    } else if (summary.length + 1 + shortEndTimeStr.length <= maxLen) {
      signText = `${summary} ${shortEndTimeStr}`;
    } else {
      // Need to truncate title — do not include am/pm to save characters
      const suffix = `... ${shortEndTimeStr}`;
      const maxTitleLen = maxLen - suffix.length;
      const truncTitle = summary.slice(0, Math.max(0, maxTitleLen)).trimEnd();
      signText = `${truncTitle}${suffix}`;
    }

    // Internal pipe-delimited format used by handlePush: "display ||| start - end"
    const startD = new Date(ev.start_iso);
    const startTimeStr = timeFmt.format(startD).toLowerCase();
    return `${signText} ||| ${startTimeStr} - ${rawEndTimeStr}`;
  } catch (e) {
    console.error("[calendar] Failed to format end time:", e);
    return summary;
  }
}


const drawCustomTimeCanvas = (ctx, hours, minutes, timeFormat, textColor, showColon = true) => {
  let hourStr = '';
  let minStr = String(minutes).padStart(2, '0');
  let ampmStr = '';
  
  if (timeFormat === '24h') {
    hourStr = String(hours).padStart(2, '0');
    ctx.font = '14px Arial, sans-serif';
  } else {
    const displayHours = hours % 12 || 12;
    hourStr = String(displayHours);
    ampmStr = hours >= 12 ? ' PM' : ' AM';
    ctx.font = '14px Arial, sans-serif';
  }
  
  const hw = ctx.measureText(hourStr).width;
  const mw = ctx.measureText(minStr).width;
  const aw = ampmStr ? ctx.measureText(ampmStr).width : 0;
  
  const gap = 1;
  const cw = 2;
  const totalW = hw + gap + cw + gap + mw + aw;
  const startX = Math.floor((64 - totalW) / 2);
  
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = textColor;
  
  ctx.fillText(hourStr, startX, 10);
  
  const cx = startX + hw + gap;
  if (showColon) {
    ctx.fillRect(cx, 8, 1, 1);
    ctx.fillRect(cx, 12, 1, 1);
  }
  
  const mx = cx + cw + gap;
  ctx.fillText(minStr, mx, 10);
  
  if (ampmStr) {
    const ax = mx + mw;
    ctx.fillText(ampmStr, ax, 10);
  }
};

const FONT_5x14 = {
  '0': [
    " XXX ",
    "X   X",
    "X   X",
    "X   X",
    "X   X",
    "X   X",
    "X   X",
    "X   X",
    "X   X",
    "X   X",
    "X   X",
    "X   X",
    "X   X",
    " XXX "
  ],
  '1': [
    "  X  ",
    " XX  ",
    "  X  ",
    "  X  ",
    "  X  ",
    "  X  ",
    "  X  ",
    "  X  ",
    "  X  ",
    "  X  ",
    "  X  ",
    "  X  ",
    "  X  ",
    "  X  "
  ],
  '2': [
    " XXX ",
    "X   X",
    "    X",
    "    X",
    "    X",
    "    X",
    " XXX ",
    "X    ",
    "X    ",
    "X    ",
    "X    ",
    "X    ",
    "X    ",
    "XXXXX"
  ],
  '3': [
    " XXX ",
    "X   X",
    "    X",
    "    X",
    "    X",
    "    X",
    " XXX ",
    "    X",
    "    X",
    "    X",
    "    X",
    "    X",
    "X   X",
    " XXX "
  ],
  '4': [
    "X   X",
    "X   X",
    "X   X",
    "X   X",
    "X   X",
    "X   X",
    "XXXXX",
    "    X",
    "    X",
    "    X",
    "    X",
    "    X",
    "    X",
    "    X"
  ],
  '5': [
    "XXXXX",
    "X    ",
    "X    ",
    "X    ",
    "X    ",
    "X    ",
    "XXXX ",
    "    X",
    "    X",
    "    X",
    "    X",
    "    X",
    "X   X",
    " XXX "
  ],
  '6': [
    " XXX ",
    "X    ",
    "X    ",
    "X    ",
    "X    ",
    "X    ",
    "XXXX ",
    "X   X",
    "X   X",
    "X   X",
    "X   X",
    "X   X",
    "X   X",
    " XXX "
  ],
  '7': [
    "XXXXX",
    "    X",
    "    X",
    "    X",
    "    X",
    "    X",
    "    X",
    "    X",
    "    X",
    "    X",
    "    X",
    "    X",
    "    X",
    "    X"
  ],
  '8': [
    " XXX ",
    "X   X",
    "X   X",
    "X   X",
    "X   X",
    "X   X",
    " XXX ",
    "X   X",
    "X   X",
    "X   X",
    "X   X",
    "X   X",
    "X   X",
    " XXX "
  ],
  '9': [
    " XXX ",
    "X   X",
    "X   X",
    "X   X",
    "X   X",
    "X   X",
    " XXXX",
    "    X",
    "    X",
    "    X",
    "    X",
    "    X",
    "    X",
    " XXX "
  ]
};

const drawDefaultClockCanvas = (ctx, hours, minutes, textColor, showColon = true) => {
  const hourStr = String(hours).padStart(2, '0');
  const minStr = String(minutes).padStart(2, '0');
  const startX = 16;
  const startY = 2;
  
  ctx.fillStyle = textColor;
  
  const drawDigit = (char, sx) => {
    const bitmap = FONT_5x14[char];
    if (!bitmap) return;
    for (let rowIdx = 0; rowIdx < 14; rowIdx++) {
      for (let colIdx = 0; colIdx < 5; colIdx++) {
        if (bitmap[rowIdx][colIdx] === 'X') {
          ctx.fillRect(sx + colIdx, startY + rowIdx, 1, 1);
        }
      }
    }
  };

  const drawStar = (cx, cy) => {
    ctx.fillRect(cx, cy, 1, 1);
    ctx.fillRect(cx, cy - 1, 1, 1);
    ctx.fillRect(cx, cy + 1, 1, 1);
    ctx.fillRect(cx - 1, cy, 1, 1);
    ctx.fillRect(cx + 1, cy, 1, 1);
  };

  drawDigit(hourStr[0], startX);
  drawDigit(hourStr[1], startX + 6);
  
  if (showColon) {
    drawStar(startX + 15, 5);
    drawStar(startX + 15, 12);
  }
  
  drawDigit(minStr[0], startX + 20);
  drawDigit(minStr[1], startX + 26);
};


const ClockPresetCardPreview = ({ preset, style }) => {
  const canvasRef = useRef(null);

  const drawClock = (dateObj) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const textColor = preset.clockStyle === 'default' ? '#ffffff' : (preset.textColor || '#10B981');
    const showSecs = preset.showSeconds !== false;
    const sec = dateObj.getSeconds();
    const showColon = sec % 2 === 0;

    ctx.fillStyle = preset.bgColor || '#000000';
    ctx.fillRect(0, 0, 64, 20);

    if (preset.clockStyle === 'default') {
      drawDefaultClockCanvas(ctx, dateObj.getHours(), dateObj.getMinutes(), textColor, showColon);
    } else {
      drawCustomTimeCanvas(ctx, dateObj.getHours(), dateObj.getMinutes(), preset.timeFormat, textColor, showColon);
    }

    if (showSecs) {
      ctx.fillStyle = textColor;
      ctx.fillRect(2, 0, sec + 1, 1);
    }

    // Threshold to match hardware
    const imageData = ctx.getImageData(0, 0, 64, 20);
    const data = imageData.data;
    const bg = preset.bgColor || '#000000';
    const bgR = parseInt(bg.slice(1,3), 16) || 0;
    const bgG = parseInt(bg.slice(3,5), 16) || 0;
    const bgB = parseInt(bg.slice(5,7), 16) || 0;
    const tc = textColor;
    const tcR = parseInt(tc.slice(1,3), 16) || 0;
    const tcG = parseInt(tc.slice(3,5), 16) || 0;
    const tcB = parseInt(tc.slice(5,7), 16) || 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== bgR || data[i+1] !== bgG || data[i+2] !== bgB) {
        data[i] = tcR; data[i+1] = tcG; data[i+2] = tcB; data[i+3] = 255;
      }
    }
    ctx.putImageData(imageData, 0, 0);
  };

  useEffect(() => {
    drawClock(new Date());
    
    let intervalId;
    const msToNextSecond = 1000 - new Date().getMilliseconds();
    const timeoutId = setTimeout(() => {
      drawClock(new Date());
      intervalId = setInterval(() => drawClock(new Date()), 1000);
    }, msToNextSecond);

    return () => {
      clearTimeout(timeoutId);
      if (intervalId) clearInterval(intervalId);
    };
  }, [preset.bgColor, preset.textColor, preset.timeFormat, preset.showSeconds, preset.clockStyle]);

  return (
    <canvas 
      ref={canvasRef} 
      width={64} 
      height={20} 
      className="led-preview"
      style={{ width: '100%', height: '100%', objectFit: 'fill', imageRendering: 'pixelated', position: 'absolute', inset: 0, ...(style || {}) }}
    />
  );
};

const AnimatedPresetCardPreview = ({ preset }) => {
  const canvasRef = useRef(null);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const pixels = preset.pixels;
    if (!pixels || pixels.length <= 1280) return;

    const numFrames = pixels.length / 1280;
    const frameWidth = 64;
    const frameHeight = 20;
    const stitchedWidth = frameWidth * numFrames;

    // Pre-parse/extract frame image data to speed up rendering
    const frames = [];
    for (let f = 0; f < numFrames; f++) {
      const imgData = ctx.createImageData(frameWidth, frameHeight);
      for (let r = 0; r < frameHeight; r++) {
        const rowStartInStitched = r * stitchedWidth;
        const rowStartInFrame = r * frameWidth;
        for (let c = 0; c < frameWidth; c++) {
          const p = pixels[rowStartInStitched + f * frameWidth + c];
          const idx = (rowStartInFrame + c) * 4;

          if (p && p !== 0 && typeof p === 'string') {
            const color = p.startsWith('#') ? p : (preset.textColor || '#ffffff');
            const rVal = parseInt(color.slice(1, 3), 16) || 0;
            const gVal = parseInt(color.slice(3, 5), 16) || 0;
            const bVal = parseInt(color.slice(5, 7), 16) || 0;
            imgData.data[idx] = rVal;
            imgData.data[idx+1] = gVal;
            imgData.data[idx+2] = bVal;
            imgData.data[idx+3] = 255;
          } else if (p && p !== 0 && typeof p !== 'string') {
            // Truthy non-string pixel (e.g. integer 1) = foreground color
            const color = preset.textColor || '#ffffff';
            const rVal = parseInt(color.slice(1, 3), 16) || 0;
            const gVal = parseInt(color.slice(3, 5), 16) || 0;
            const bVal = parseInt(color.slice(5, 7), 16) || 0;
            imgData.data[idx] = rVal;
            imgData.data[idx+1] = gVal;
            imgData.data[idx+2] = bVal;
            imgData.data[idx+3] = 255;
          } else {
            const bgCol = preset.bgColor || '#000000';
            const rVal = parseInt(bgCol.slice(1, 3), 16) || 0;
            const gVal = parseInt(bgCol.slice(3, 5), 16) || 0;
            const bVal = parseInt(bgCol.slice(5, 7), 16) || 0;
            imgData.data[idx] = rVal;
            imgData.data[idx+1] = gVal;
            imgData.data[idx+2] = bVal;
            imgData.data[idx+3] = 255;
          }
        }
      }
      frames.push(imgData);
    }

    let currentFrameIdx = 0;
    let animId;

    const presetSpeed = preset.speed || 8;
    const clampedSpeed = Math.max(1, Math.min(15, presetSpeed));
    // Use exact frameDurationMs if stored on preset, otherwise use speed formula
    const defaultDelayMs = preset.frameDurationMs
      ? Math.max(16, preset.frameDurationMs)
      : Math.max(50, (0.4 - (clampedSpeed * 0.025)) * 1000);
    const frameDurationsMs = Array.isArray(preset.frameDurationsMs) ? preset.frameDurationsMs : null;

    const play = () => {
      ctx.putImageData(frames[currentFrameIdx], 0, 0);
      const delayMs = Math.max(16, frameDurationsMs?.[currentFrameIdx] || defaultDelayMs);
      currentFrameIdx = (currentFrameIdx + 1) % numFrames;
      animId = setTimeout(play, delayMs);
    };

    play();

    return () => {
      clearTimeout(animId);
    };
  }, [preset]);

  return (
    <canvas 
      ref={canvasRef} 
      width={64} 
      height={20} 
      className="led-preview" 
      style={{ width: '100%', height: '100%', objectFit: 'fill', imageRendering: 'pixelated', position: 'absolute', inset: 0 }}
    />
  );
};

const PresetCardMedia = ({ preset, now }) => {
  if (!preset) return null;
  const isClock = preset.mode === 'clock' || preset.id === 'clock-default';
  if (isClock) {
    return <ClockPresetCardPreview preset={preset} now={now} />;
  }
  if (preset.mode === 'text') {
    return <TextPresetCardPreview preset={preset} />;
  }
  // Saved media has the exact 64×20 frames sent to the sign. Prefer those for
  // every card type so local, saved, and live previews have identical color,
  // crop, and animation timing.
  if (preset.pixels && preset.pixels.length > 1280) {
    return <AnimatedPresetCardPreview preset={preset} />;
  }
  if (preset.pixels && preset.pixels.length === 1280) {
    return <PixelPresetCardPreview preset={preset} />;
  }
  // Before a new media preset has been saved, fall back to the source decoder
  // so its animation can still be previewed.
  if (preset.mode === 'image' && preset.imgSrc && (preset.fileType === 'gif' || preset.fileType === 'video')) {
    return <MediaPixelPreview
      imgSrc={preset.imgSrc}
      fileType={preset.fileType}
      canvasX={preset.canvasX || 0}
      canvasY={preset.canvasY || 0}
      dw={(preset.dwBase || 64) * (preset.zoom || 1)}
      dh={(preset.dhBase || 20) * (preset.zoom || 1)}
      bgColor={preset.bgColor}
      pixels={null}
      speed={preset.speed}
      frameDurationMs={preset.frameDurationMs}
    />;
  }
  if (preset.fileType === 'video' && preset.imgSrc) {
    return (
      <video 
        src={preset.imgSrc} 
        className="led-preview" 
        autoPlay 
        loop 
        muted 
        playsInline 
        style={{ width: '100%', height: '100%', objectFit: 'fill', imageRendering: 'pixelated' }} 
      />
    );
  }
  if (preset.fileType === 'gif' && preset.imgSrc) {
    return (
      <img 
        src={preset.imgSrc} 
        className="led-preview" 
        draggable={false} 
        alt={preset.name || "GIF"} 
        style={{ width: '100%', height: '100%', objectFit: 'fill', imageRendering: 'pixelated' }} 
      />
    );
  }
  // Animated GIF thumbnail from server (saved presets, live preview)
  if (preset.thumbnail && preset.thumbnail.toLowerCase().includes('.gif')) {
    return (
      <img
        src={preset.thumbnail}
        className="led-preview"
        draggable={false}
        alt={preset.name || "GIF"}
        style={{ width: '100%', height: '100%', objectFit: 'fill', imageRendering: 'pixelated' }}
      />
    );
  }
  if (preset.thumbnail) {
    return (
      <img 
        src={preset.thumbnail} 
        className="led-preview" 
        draggable={false} 
        alt={preset.name || "Thumbnail"} 
        style={{ width: '100%', height: '100%', objectFit: 'fill', imageRendering: 'pixelated' }} 
      />
    );
  }
  if (preset.imgSrc) {
    return (
      <img 
        src={preset.imgSrc} 
        className="led-preview" 
        draggable={false} 
        alt={preset.name || "Media"} 
        style={{ width: '100%', height: '100%', objectFit: 'fill', imageRendering: 'pixelated' }} 
      />
    );
  }
  return (
    <div className="preset-card-content" style={{ background: preset.bgColor || '#000000' }}>
      <p style={{ color: preset.textColor || '#fff', fontSize: 16, fontWeight: 900, transform: `rotate(${preset.rotation || 0}deg)`, textAlign: 'center', lineHeight: 1 }}>
        {preset.text || preset.name || 'Untitled'}
      </p>
    </div>
  );
};

const PixelPresetCardPreview = ({ preset, style }) => {
  const canvasRef = useRef(null);
  const scrollOffsetRef = useRef(0);
  const animName = preset?.animation;
  const isImageOrDrawing = preset?.mode === 'image' || preset?.mode === 'drawing';
  const isAnimating = !isImageOrDrawing && Boolean(animName && animName !== 'show now' && animName !== 'static');
  const animSpeed = preset?.speed !== undefined ? preset?.speed : 8;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const pixels = preset.pixels;
    if (!pixels || pixels.length < 1280) return;

    const bgCol = preset.bgColor || '#000000';
    const bgR = parseInt(bgCol.slice(1, 3), 16) || 0;
    const bgG = parseInt(bgCol.slice(3, 5), 16) || 0;
    const bgB = parseInt(bgCol.slice(5, 7), 16) || 0;

    const renderFrame = (offset = 0) => {
      const imgData = ctx.createImageData(64, 20);
      const isFlickerOff = animName === 'flicker' && (Math.floor(offset / 4) % 2 === 1);

      for (let y = 0; y < 20; y++) {
        for (let x = 0; x < 64; x++) {
          const destIdx = (y * 64 + x) * 4;
          if (isFlickerOff) {
            imgData.data[destIdx] = bgR;
            imgData.data[destIdx + 1] = bgG;
            imgData.data[destIdx + 2] = bgB;
            imgData.data[destIdx + 3] = 255;
            continue;
          }

          let srcX = x;
          let srcY = y;
          if (animName === 'shift left' || animName === 'continuous left shift' || animName === 'move-left') {
            srcX = (x + offset) % 64;
          } else if (animName === 'move right' || animName === 'move-right') {
            srcX = (x - (offset % 64) + 64) % 64;
          } else if (animName === 'move up' || animName === 'move-up') {
            srcY = (y + offset) % 20;
          } else if (animName === 'move down' || animName === 'move-down') {
            srcY = (y - (offset % 20) + 20) % 20;
          } else if (animName === 'snow') {
            srcY = (y - (offset % 20) + 20) % 20;
            srcX = (x + ((y * 3 + offset) % 3) - 1 + 64) % 64;
          } else if (animName === 'bubble') {
            srcY = (y + offset) % 20;
            srcX = (x + ((y * 2 + offset) % 3) - 1 + 64) % 64;
          }

          const srcIdx = srcY * 64 + srcX;
          const p = pixels[srcIdx];
          let r = bgR, g = bgG, b = bgB;
          if (p && typeof p === 'string' && p.startsWith('#')) {
            r = parseInt(p.slice(1, 3), 16) || 0;
            g = parseInt(p.slice(3, 5), 16) || 0;
            b = parseInt(p.slice(5, 7), 16) || 0;
          } else if (p && p !== 0) {
            const fgCol = preset.textColor || '#ffffff';
            r = parseInt(fgCol.slice(1, 3), 16) || 0;
            g = parseInt(fgCol.slice(3, 5), 16) || 0;
            b = parseInt(fgCol.slice(5, 7), 16) || 0;
          }
          imgData.data[destIdx] = r;
          imgData.data[destIdx + 1] = g;
          imgData.data[destIdx + 2] = b;
          imgData.data[destIdx + 3] = 255;
        }
      }
      ctx.putImageData(imgData, 0, 0);
    };

    renderFrame(scrollOffsetRef.current);

    if (isAnimating) {
      const intervalMs = Math.max(10, 80 - animSpeed * 5);
      const interval = setInterval(() => {
        scrollOffsetRef.current = (scrollOffsetRef.current + 1) % 64;
        renderFrame(scrollOffsetRef.current);
      }, intervalMs);
      return () => clearInterval(interval);
    }
  }, [preset.pixels, preset.bgColor, preset.textColor, preset.animation, preset.speed, isAnimating, animSpeed]);

  return (
    <canvas 
      ref={canvasRef} 
      width={64} 
      height={20} 
      className="led-preview"
      style={{ width: '100%', height: '100%', objectFit: 'fill', imageRendering: 'pixelated', position: 'absolute', inset: 0, ...(style || {}) }}
    />
  );
};

const PixelatedImageCanvas = ({ pixels, bgColor }) => {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const imgData = ctx.createImageData(64, 20);
    const bgCol = bgColor || '#000000';
    const bgR = parseInt(bgCol.slice(1, 3), 16) || 0;
    const bgG = parseInt(bgCol.slice(3, 5), 16) || 0;
    const bgB = parseInt(bgCol.slice(5, 7), 16) || 0;

    for (let i = 0; i < 1280; i++) {
      const p = pixels && pixels[i];
      const idx = i * 4;
      let r = bgR, g = bgG, b = bgB;
      if (p && typeof p === 'string' && p.startsWith('#')) {
        r = parseInt(p.slice(1, 3), 16) || 0;
        g = parseInt(p.slice(3, 5), 16) || 0;
        b = parseInt(p.slice(5, 7), 16) || 0;
      } else if (p && p !== 0) {
        r = 255; g = 255; b = 255;
      }
      imgData.data[idx] = r;
      imgData.data[idx + 1] = g;
      imgData.data[idx + 2] = b;
      imgData.data[idx + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
  }, [pixels, bgColor]);

  return (
    <canvas 
      ref={canvasRef} 
      width={64} 
      height={20} 
      className="led-preview"
      style={{ 
        position: 'absolute', 
        inset: 0, 
        width: '100%', 
        height: '100%', 
        objectFit: 'fill', 
        imageRendering: 'pixelated', 
        pointerEvents: 'none', 
        userSelect: 'none', 
        display: 'block' 
      }} 
    />
  );
};

const MediaPixelPreview = ({ imgSrc, fileType, canvasX, canvasY, dw, dh, bgColor, pixels, speed, frameDurationMs }) => {
  const canvasRef = useRef(null);
  const videoRef = useRef(null);
  const gifBitmapsRef = useRef([]);
  const [gifDecoded, setGifDecoded] = useState(false);

  // Decode GIF frames using native ImageDecoder if available
  useEffect(() => {
    if (fileType !== 'gif' || !imgSrc) {
      gifBitmapsRef.current.forEach(f => {
        try { f.bitmap?.close?.(); } catch {}
      });
      gifBitmapsRef.current = [];
      setGifDecoded(false);
      return;
    }

    let isCancelled = false;

    const decode = async () => {
      if (typeof window.ImageDecoder === 'undefined') {
        return;
      }
      try {
        const res = await fetch(imgSrc);
        const buffer = await res.arrayBuffer();
        if (isCancelled) return;
        const decoder = new window.ImageDecoder({ data: buffer, type: 'image/gif' });
        await decoder.tracks.ready;
        const loaded = [];
        let i = 0;
        while (true) {
          try {
            const frame = await decoder.decode({ frameIndex: i });
            if (isCancelled) {
              try { frame.image.close(); } catch {}
              return;
            }
            const durMs = frame.image.duration ? (frame.image.duration / 1000) : 100;
            const bmp = await createImageBitmap(frame.image);
            try { frame.image.close(); } catch {}
            loaded.push({
              bitmap: bmp,
              duration: Math.max(20, durMs)
            });
            i++;
          } catch {
            break; // Reached end of frames
          }
        }
        if (!isCancelled && loaded.length > 0) {
          gifBitmapsRef.current.forEach(f => {
            try { f.bitmap?.close?.(); } catch {}
          });
          gifBitmapsRef.current = loaded;
          setGifDecoded(true);
        }
      } catch (err) {
        console.warn('[MediaPixelPreview] GIF decode error:', err);
      }
    };

    decode();

    return () => {
      isCancelled = true;
      gifBitmapsRef.current.forEach(f => {
        try { f.bitmap?.close?.(); } catch {}
      });
      gifBitmapsRef.current = [];
    };
  }, [imgSrc, fileType]);

  // Video playback initialization
  useEffect(() => {
    if (fileType === 'video' && videoRef.current) {
      const v = videoRef.current;
      v.muted = true;
      v.defaultMuted = true;
      v.loop = true;
      v.playsInline = true;
      v.play().catch(e => console.log('[MediaPixelPreview] Video play error:', e));
    }
  }, [fileType, imgSrc]);

  // Canvas render loop. Layout timing prevents a black canvas from being
  // painted before a stored first animation frame is available.
  useLayoutEffect(() => {
    let animId;
    let lastFrameTime = performance.now();
    let currentFrameIdx = 0;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Check if we have pre-rendered multi-frame pixels (e.g. editing a saved preset or loaded animation)
    const hasMultiFramePixels = pixels && pixels.length > 1280;
    let parsedPixelFrames = null;

    if (hasMultiFramePixels) {
      const numFrames = Math.floor(pixels.length / 1280);
      const frameWidth = 64;
      const frameHeight = 20;
      const stitchedWidth = frameWidth * numFrames;
      parsedPixelFrames = [];

      for (let f = 0; f < numFrames; f++) {
        const imgData = ctx.createImageData(frameWidth, frameHeight);
        for (let r = 0; r < frameHeight; r++) {
          const rowStartInStitched = r * stitchedWidth;
          const rowStartInFrame = r * frameWidth;
          for (let c = 0; c < frameWidth; c++) {
            const p = pixels[rowStartInStitched + f * frameWidth + c];
            const idx = (rowStartInFrame + c) * 4;
            if (p && p !== 0 && typeof p === 'string') {
              const color = p.startsWith('#') ? p : '#ffffff';
              imgData.data[idx] = parseInt(color.slice(1, 3), 16) || 0;
              imgData.data[idx+1] = parseInt(color.slice(3, 5), 16) || 0;
              imgData.data[idx+2] = parseInt(color.slice(5, 7), 16) || 0;
              imgData.data[idx+3] = 255;
            } else {
              const bgCol = bgColor || '#000000';
              imgData.data[idx] = parseInt(bgCol.slice(1, 3), 16) || 0;
              imgData.data[idx+1] = parseInt(bgCol.slice(3, 5), 16) || 0;
              imgData.data[idx+2] = parseInt(bgCol.slice(5, 7), 16) || 0;
              imgData.data[idx+3] = 255;
            }
          }
        }
        parsedPixelFrames.push(imgData);
      }
    }

    const render = (now) => {
      ctx.imageSmoothingEnabled = false;

      // 1) Multi-frame pixels from saved preset
      if (parsedPixelFrames && parsedPixelFrames.length > 1) {
        const presetSpeed = speed || 8;
        const clampedSpeed = Math.max(1, Math.min(15, presetSpeed));
        const delayMs = frameDurationMs ? Math.max(16, frameDurationMs) : Math.max(50, (0.4 - (clampedSpeed * 0.025)) * 1000);
        
        if (now - lastFrameTime >= delayMs) {
          currentFrameIdx = (currentFrameIdx + 1) % parsedPixelFrames.length;
          lastFrameTime = now;
        }
        ctx.putImageData(parsedPixelFrames[currentFrameIdx % parsedPixelFrames.length], 0, 0);
        animId = requestAnimationFrame(render);
        return;
      }

      // 2) Video playback
      if (fileType === 'video') {
        const v = videoRef.current;
        if (v && v.readyState >= 2) {
          try {
            ctx.fillStyle = bgColor || '#000000';
            ctx.fillRect(0, 0, 64, 20);
            ctx.drawImage(v, canvasX, canvasY, dw, dh);
          } catch {}
        }
        animId = requestAnimationFrame(render);
        return;
      }

      // 3) Decoded GIF playback
      if (fileType === 'gif' && gifBitmapsRef.current.length > 0) {
        const frames = gifBitmapsRef.current;
        const curFrame = frames[currentFrameIdx % frames.length];
        const frameDur = curFrame ? curFrame.duration : 100;
        if (now - lastFrameTime >= frameDur) {
          currentFrameIdx = (currentFrameIdx + 1) % frames.length;
          lastFrameTime = now;
        }
        const frameToDraw = frames[currentFrameIdx % frames.length];
        if (frameToDraw && frameToDraw.bitmap) {
          try {
            ctx.fillStyle = bgColor || '#000000';
            ctx.fillRect(0, 0, 64, 20);
            ctx.drawImage(frameToDraw.bitmap, canvasX, canvasY, dw, dh);
          } catch {}
        }
        animId = requestAnimationFrame(render);
        return;
      }

      // 4) Single-frame pixels fallback
      if (pixels && pixels.length >= 1280) {
        const bgCol = bgColor || '#000000';
        ctx.fillStyle = bgCol;
        ctx.fillRect(0, 0, 64, 20);
        const bgR = parseInt(bgCol.slice(1, 3), 16) || 0;
        const bgG = parseInt(bgCol.slice(3, 5), 16) || 0;
        const bgB = parseInt(bgCol.slice(5, 7), 16) || 0;
        const imgData = ctx.createImageData(64, 20);
        for (let i = 0; i < 1280; i++) {
          const p = pixels[i];
          const idx = i * 4;
          let r = bgR, g = bgG, b = bgB;
          if (p && typeof p === 'string' && p.startsWith('#')) {
            r = parseInt(p.slice(1, 3), 16) || 0;
            g = parseInt(p.slice(3, 5), 16) || 0;
            b = parseInt(p.slice(5, 7), 16) || 0;
          } else if (p && p !== 0) {
            r = 255; g = 255; b = 255;
          }
          imgData.data[idx] = r;
          imgData.data[idx + 1] = g;
          imgData.data[idx + 2] = b;
          imgData.data[idx + 3] = 255;
        }
        ctx.putImageData(imgData, 0, 0);
      }
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [imgSrc, fileType, canvasX, canvasY, dw, dh, bgColor, pixels, gifDecoded, speed, frameDurationMs]);

  return (
    <>
      {fileType === 'video' && (
        <video
          ref={videoRef}
          src={imgSrc}
          autoPlay
          loop
          muted
          playsInline
          style={{
            position: 'absolute',
            width: '1px',
            height: '1px',
            opacity: 0.01,
            pointerEvents: 'none',
            zIndex: 0
          }}
        />
      )}
      <canvas
        ref={canvasRef}
        width={64}
        height={20}
        className="led-preview"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'fill',
          imageRendering: 'pixelated',
          pointerEvents: 'none',
          userSelect: 'none',
          display: 'block',
          zIndex: 1
        }}
      />
    </>
  );
};

const parseHexColor = (hex, def = [255, 255, 255]) => {
  if (!hex || typeof hex !== 'string') return def;
  const clean = hex.replace('#', '');
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return [isNaN(r) ? def[0] : r, isNaN(g) ? def[1] : g, isNaN(b) ? def[2] : b];
  }
  return def;
};

const textPreviewCache = new Map();


const useFontReady = () => {
  const [ready, setReady] = useState(() => {
    if (typeof document === 'undefined' || !document.fonts) return true;
    return document.fonts.check ? document.fonts.check('16px "Unifont"') : true;
  });

  useEffect(() => {
    if (ready) return;
    if (typeof document !== 'undefined' && document.fonts) {
      let isMounted = true;
      Promise.all([
        document.fonts.ready,
        document.fonts.load('16px "Unifont"')
      ]).then(() => {
        if (isMounted) setReady(true);
      }).catch(() => {
        if (isMounted) setReady(true);
      });
      return () => { isMounted = false; };
    }
  }, [ready]);

  return ready;
};

const getTextTargetPixels = (ctx, text, font, align, baseline, x, y) => {
  const offCanvas = document.createElement('canvas');
  offCanvas.width = 64;
  offCanvas.height = 20;
  const offCtx = offCanvas.getContext('2d');
  offCtx.fillStyle = '#000000';
  offCtx.fillRect(0, 0, 64, 20);
  offCtx.fillStyle = '#ffffff';
  offCtx.font = font;
  offCtx.textAlign = align;
  offCtx.textBaseline = baseline;
  offCtx.fillText(text, x, y);
  const data = offCtx.getImageData(0, 0, 64, 20).data;
  const pts = [];
  for (let py = 0; py < 20; py++) {
    for (let px = 0; px < 64; px++) {
      const i = (py * 64 + px) * 4;
      if (data[i] > 140 || data[i+1] > 140 || data[i+2] > 140) {
        pts.push([px, py]);
      }
    }
  }
  return pts;
};

const apply1BitThreshold = (ctx, textColor, bgColor, globalOpacity = 1.0) => {
  const tc = parseHexColor(textColor, [255, 255, 255]);
  const bc = parseHexColor(bgColor, [0, 0, 0]);
  const imgData = ctx.getImageData(0, 0, 64, 20);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    const isLit = (data[i] > 140 || data[i+1] > 140 || data[i+2] > 140) && data[i+3] > 140;
    if (isLit) {
      data[i] = Math.round(tc[0] * globalOpacity + bc[0] * (1 - globalOpacity));
      data[i+1] = Math.round(tc[1] * globalOpacity + bc[1] * (1 - globalOpacity));
      data[i+2] = Math.round(tc[2] * globalOpacity + bc[2] * (1 - globalOpacity));
      data[i+3] = 255;
    } else {
      data[i] = bc[0];
      data[i+1] = bc[1];
      data[i+2] = bc[2];
      data[i+3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
};

const renderTextAnimation = (ctx, rawText, animName, offset, textColor = '#ffffff', bgColor = '#000000') => {
  const text = normalizeForSign(rawText || '');
  ctx.imageSmoothingEnabled = false;
  
  ctx.font = 'normal 16px "Unifont", monospace, sans-serif';
  ctx.textBaseline = 'middle';
  
  const drawBg = () => {
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, 64, 20);
  };
  
  const tw = ctx.measureText(text).width;
  const totalW = 64 + tw;
  
  // GLOBALLY SYNCED 20FPS CLOCK (50ms per frame)
  const globalFrame = Math.floor(performance.now() / 50);
  
  if (animName === 'continuous left shift') {
    drawBg();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    let curX = 64 - (globalFrame % totalW);
    ctx.fillText(text, curX, 10);
    if (curX + tw < 64) ctx.fillText(text, curX + totalW, 10);
    apply1BitThreshold(ctx, textColor, bgColor);
    return;
  }

  if (animName === 'shift left' || animName === 'move-left' || animName === 'move right' || animName === 'move-right' || animName === 'move up' || animName === 'move-up' || animName === 'move down' || animName === 'move-down') {
    drawBg();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    
    const pages = Math.max(1, Math.ceil(text.length / 8));
    const framesPerPage = 92;
    const cycleFrame = globalFrame % framesPerPage;
    const pageIdx = Math.floor(globalFrame / framesPerPage) % pages;
    const currentChunk = text.substring(pageIdx * 8, (pageIdx + 1) * 8);
    const chunkTw = ctx.measureText(currentChunk).width;
    
    let prog = 0;
    if (cycleFrame < 16) prog = cycleFrame / 16.0;
    else if (cycleFrame < 76) prog = 1.0;
    else prog = 1.0 + ((cycleFrame - 76) / 16.0);
    
    let curX = 32;
    let curY = 10;
    
    if (animName === 'shift left' || animName === 'move-left') {
       if (prog <= 1.0) curX = 64 + (chunkTw/2) - ((64 + chunkTw/2 - 32) * prog);
       else curX = 32 - ((32 + chunkTw/2 + 64) * (prog - 1.0));
    } else if (animName === 'move right' || animName === 'move-right') {
       if (prog <= 1.0) curX = -(chunkTw/2) + ((32 + chunkTw/2) * prog);
       else curX = 32 + ((64 + chunkTw/2 - 32) * (prog - 1.0));
    } else if (animName === 'move up' || animName === 'move-up') {
       if (prog <= 1.0) curY = 30 - (20 * prog);
       else curY = 10 - (20 * (prog - 1.0));
    } else if (animName === 'move down' || animName === 'move-down') {
       if (prog <= 1.0) curY = -10 + (20 * prog);
       else curY = 10 + (20 * (prog - 1.0));
    }
    
    ctx.fillText(currentChunk, Math.round(curX), Math.round(curY));
    apply1BitThreshold(ctx, textColor, bgColor);
    return;
  }

  if (animName === 'snow' || animName === 'bubble') {
    drawBg();
    const align = tw <= 64 ? 'center' : 'left';
    const bx = tw <= 64 ? 32 : 0;
    const pts = getTextTargetPixels(ctx, text, ctx.font, align, ctx.textBaseline, bx, 10);

    ctx.fillStyle = textColor;
    const framesPerPage = 92;
    const pageFrame = offset % framesPerPage;

    if (animName === 'snow') {
        for (let i = 0; i < pts.length; i++) {
          const [px, py] = pts[i];
          const delay = (px * 23 + 7) % 11;
          const progress = pageFrame - delay;
          if (progress >= py) ctx.fillRect(px, py, 1, 1);
        }
        ctx.fillStyle = '#ffffff';
        const colsWithText = new Set();
        pts.forEach(([px, py]) => colsWithText.add(px));
        colsWithText.forEach(px => {
          const delay = (px * 23 + 7) % 11;
          const progress = pageFrame - delay;
          if (progress >= 0 && progress < 20) ctx.fillRect(px, progress, 1, 1);
        });
    } else {
        for (let i = 0; i < pts.length; i++) {
          const [px, py] = pts[i];
          const delay = (px * 17 + 5) % 11;
          const progress = pageFrame - delay;
          const curY = 19 - progress;
          if (py >= curY) ctx.fillRect(px, py, 1, 1);
        }
        ctx.fillStyle = '#ffffff';
        const colsWithText = new Set();
        pts.forEach(([px, py]) => colsWithText.add(px));
        colsWithText.forEach(px => {
          const delay = (px * 17 + 5) % 11;
          const progress = pageFrame - delay;
          if (progress >= 0) {
            const curY = 19 - progress;
            if (curY >= 0 && curY < 20) ctx.fillRect(px, curY, 1, 1);
          }
        });
    }

    apply1BitThreshold(ctx, textColor, bgColor);
    return;
  }

  const align = tw <= 64 ? 'center' : 'left';
  const bx = tw <= 64 ? 32 : 0;
  


  if (animName === 'flicker') {
    const framesPerPage = 60;
    const pageFrame = offset % framesPerPage;
    const opacity = (pageFrame < 30) ? 1.0 : 0.0;
    
    drawBg();
    ctx.fillStyle = '#ffffff';
    if (pageFrame < 30) {
      const pts = getTextTargetPixels(ctx, text, ctx.font, align, ctx.textBaseline, bx, 10);
      for (let i = 0; i < pts.length; i++) {
        const [tx, ty] = pts[i];
        ctx.fillRect(tx, ty, 1, 1);
      }
    }
    apply1BitThreshold(ctx, textColor, bgColor, opacity);
    return;
  }

  drawBg();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = align;
  ctx.fillText(text, bx, 10);
  apply1BitThreshold(ctx, textColor, bgColor);
  return;
};

const TextPresetCardPreview = ({ preset }) => {
  const fontReady = useFontReady();
  const canvasRef = useRef(null);
  const scrollOffsetRef = useRef(0);

  const textToDraw = normalizeForSign(preset?.text || preset?.name || '');
  const textColor = preset?.textColor || '#ffffff';
  const bgColor = preset?.bgColor || '#000000';
  const animName = preset?.animation;
  const isAnimating = Boolean(animName && animName !== 'show now' && animName !== 'static');
  const animationSpeed = preset?.speed !== undefined ? preset?.speed : 8;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let active = true;
    let animInterval = null;

    const drawFrame = () => {
      if (!active) return;
      renderTextAnimation(ctx, textToDraw, animName, scrollOffsetRef.current, textColor, bgColor);
    };

    if (isAnimating) {
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, 64, 20);
      
      const speedMs = Math.max(10, 80 - animationSpeed * 5);
      animInterval = setInterval(() => {
        scrollOffsetRef.current++;
        drawFrame();
      }, speedMs);
      
      drawFrame();
    } else {
      renderTextAnimation(ctx, textToDraw, animName, 0, textColor, bgColor);
    }

    return () => {
      active = false;
      if (animInterval) clearInterval(animInterval);
    };
  }, [textToDraw, textColor, bgColor, animName, isAnimating, animationSpeed, fontReady]);

  return (
    <canvas 
      ref={canvasRef} 
      width={64} 
      height={20} 
      className="led-preview" 
      style={{ width: '100%', height: '100%', objectFit: 'fill', imageRendering: 'pixelated', position: 'absolute', inset: 0 }}
    />
  );
};

export const normalizeSavedPresets = (list) => {
  if (!Array.isArray(list)) {
    return Array(12).fill(null).map((_, i) => ({ slotNumber: i + 1, hwSlotId: i, preset: null }));
  }
  const normalized = list.slice(0, 12).map((item, idx) => {
    let hwId = item?.hwSlotId;
    if (hwId === undefined || hwId === null) {
      if (item?.preset?.hwSlotId !== undefined && item?.preset?.hwSlotId !== null) {
        hwId = item.preset.hwSlotId;
      } else if (item?.preset?.slot_id !== undefined && item?.preset?.slot_id !== null) {
        hwId = item.preset.slot_id;
      } else if (typeof item?.preset?.id === 'string' && item.preset.id.startsWith('hw-slot-')) {
        const parsed = parseInt(item.preset.id.split('-')[2], 10);
        if (!isNaN(parsed)) hwId = parsed;
      } else if (item?.slotNumber !== undefined && item?.slotNumber !== null) {
        hwId = item.slotNumber - 1;
      } else {
        hwId = idx;
      }
    }
    const preset = item?.preset ? {
      ...item.preset,
      hwSlotId: hwId,
      id: item.preset.id || `hw-slot-${hwId}`
    } : null;
    return {
      slotNumber: item?.slotNumber || (idx + 1),
      hwSlotId: hwId,
      preset
    };
  });

  while (normalized.length < 12) {
    const nextIdx = normalized.length;
    const usedIds = new Set(normalized.map(s => s.hwSlotId));
    let freeHwId = nextIdx;
    for (let h = 0; h < 12; h++) {
      if (!usedIds.has(h)) {
        freeHwId = h;
        break;
      }
    }
    normalized.push({
      slotNumber: nextIdx + 1,
      hwSlotId: freeHwId,
      preset: null
    });
  }
  return normalized;
};

export default function App() {
  const fontReady = useFontReady();
  const [activeTab, setActiveTab] = useState('dashboard');
  const [status, setStatus] = useState({
    connected: false, address: null, preview_url: null,
    calendar_connected: false, uptime: '—', frames: 0
  });
  const [brightness, setBrightness] = useState(15);
  const [speed, setSpeed] = useState(8);

  // Drag state for Saved Presets
  const [savedDraggedIdx, setSavedDraggedIdx] = useState(null);
  const [savedDragOverIdx, setSavedDragOverIdx] = useState(null);
  
  const [power, setPower] = useState(false);
  const [macAddress, setMacAddress] = useState(() => {
    const saved = localStorage.getItem('loy_last_connected_mac') || localStorage.getItem('loy_mac') || '';
    return saved;
  });
  const [isConnecting, setIsConnecting] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [apiError, setApiError] = useState(false);
  const [hasFetchedStatus, setHasFetchedStatus] = useState(false);
  const hadLiveConnectionRef = useRef(false);
  const disconnectedStatusPollsRef = useRef(0);
  const [pushMessage, setPushMessage] = useState('');
  const [localPushMessage, setLocalPushMessage] = useState('');
  const [pushing, setPushingState] = useState(false);
  const [presetView, setPresetView] = useState('local');
  const pushingRef = useRef(false);

  const setPushing = (value) => {
    pushingRef.current = value;
    setPushingState(value);
  };

  useEffect(() => {
    setPresetView(status.connected ? 'saved' : 'local');
  }, [status.connected]);
  const autoConnectTried = useRef(false);

  const clearStatusOnNextInteractionRef = useRef(false);
  const armStatusClear = (msg) => {
    // The current click creates the message; clear it on the next interaction
    // anywhere in the app instead of after an arbitrary timeout.
    window.setTimeout(() => { clearStatusOnNextInteractionRef.current = Boolean(msg); }, 0);
  };
  const handleSetPushMessage = (msg) => {
    setPushMessage(msg);
    setLocalPushMessage('');
    armStatusClear(msg);
  };

  const handleSetLocalPushMessage = (msg) => {
    setLocalPushMessage(msg);
    setPushMessage('');
    armStatusClear(msg);
  };

  const setUnifiedPushMessage = (msg) => {
    handleSetLocalPushMessage(msg);
  };

  useEffect(() => {
    const clearStatusOnNextInteraction = () => {
      // Keep progress and its outcome readable while an operation is still
      // running. The label itself remains directly clickable to dismiss.
      if (pushingRef.current) return;
      if (!clearStatusOnNextInteractionRef.current) return;
      clearStatusOnNextInteractionRef.current = false;
      setPushMessage('');
      setLocalPushMessage('');
    };
    window.addEventListener('pointerdown', clearStatusOnNextInteraction);
    return () => window.removeEventListener('pointerdown', clearStatusOnNextInteraction);
  }, []);

  useEffect(() => {
    if (pushMessage || localPushMessage) armStatusClear(true);
  }, [pushMessage, localPushMessage]);

  useEffect(() => {
    if (window.location.hash === '#calendar') {
      setActiveTab('calendar');
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (macAddress && macAddress.startsWith('FF:24:10:29:')) {
      localStorage.setItem('loy_mac', macAddress);
    }
  }, [macAddress]);

  const [previewStamp, setPreviewStamp] = useState(Date.now());
  const lastPreviewTs = useRef(0);
  const lastFramesRef = useRef(-1);

  const fetchStatus = async () => {
    try {
      const res = await axios.get(`${API_BASE}/status`);
      // BLE can briefly report disconnected while it is recovering. Keep the
      // last live UI state through two status polls so the page does not race
      // the backend's reconnect worker or visibly flap on a refresh.
      if (res.data?.connected) {
        hadLiveConnectionRef.current = true;
        disconnectedStatusPollsRef.current = 0;
      } else if (hadLiveConnectionRef.current) {
        disconnectedStatusPollsRef.current += 1;
        if (disconnectedStatusPollsRef.current < 3) return res.data;
      }
      setStatus(res.data);
      if (res.data && res.data.connected && res.data.address) {
        setMacAddress(res.data.address);
        try {
          localStorage.setItem('loy_last_connected_mac', res.data.address);
          localStorage.setItem('loy_mac', res.data.address);
        } catch (e) {}
      }
      setApiError(false);
      setHasFetchedStatus(true);
      if (res.data.power !== undefined) setPower(res.data.power);
      if (res.data.speed !== undefined) setSpeed(res.data.speed);
      // Update previewStamp only when preview timestamp changes (avoid restart on frame count updates)
      if (res.data.preview_url && res.data.preview_ts !== lastPreviewTs.current) {
        lastPreviewTs.current = res.data.preview_ts;
        setPreviewStamp(res.data.preview_ts || Date.now());
      }
      return res.data;
    } catch (e) {
      if (!e.response) {
        setApiError(true);
      }
      return null;
    }
  };

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 2000);
    return () => clearInterval(id);
  }, []);

  // Tell the launcher that an LED Sign page already exists, even when it is in
  // a different browser window.
  useEffect(() => {
    const heartbeat = () => axios.post(`${API_BASE}/ui-heartbeat`).catch(() => {});
    heartbeat();
    const id = setInterval(heartbeat, 5000);
    return () => clearInterval(id);
  }, []);

  // Dedicated Auto-Connect Effect — only reconnect to the most recently connected sign
  useEffect(() => {
    const lastConnected = localStorage.getItem('loy_last_connected_mac');
    if (hasFetchedStatus && !status.connected && lastConnected && !autoConnectTried.current && !isConnecting && !apiError) {
      console.log("[auto-connect] Attempting to reconnect to most recently connected sign:", lastConnected);
      autoConnectTried.current = true;
      doConnect(lastConnected, false, true);
    }
  }, [hasFetchedStatus, status.connected, isConnecting, apiError]);

  const doConnect = async (addr, isRetry = false, isAuto = false) => {
    if (!addr || (isConnecting && !isRetry)) return;
    setIsConnecting(true);
    setConnectionFailed(false);
    console.log(`[connect] ${isRetry ? 'Retry attempt' : 'Connecting'} to:`, addr, isAuto ? '(auto)' : '');
    try {
      const timeoutMs = 60000;
      const resPost = await axios.post(`${API_BASE}/connect`, { address: addr }, { timeout: timeoutMs });
      const connectedAddr = resPost.data?.address || addr;
      if (connectedAddr && connectedAddr.toUpperCase().startsWith('FF:24:10:29:')) {
        setMacAddress(connectedAddr);
        localStorage.setItem('loy_last_connected_mac', connectedAddr);
        localStorage.setItem('loy_mac', connectedAddr);
      }
      const res = await axios.get(`${API_BASE}/status`);
      setStatus(res.data);
      if (res.data.connected) {
        setScanOpen(false);
        setConnectionFailed(false);
        localStorage.setItem('loy_last_connected_mac', res.data.address || connectedAddr);
        localStorage.setItem('loy_mac', res.data.address || connectedAddr);
        if (res.data.power !== undefined) setPower(res.data.power);
        else setPower(true);
      } else {
        throw new Error("Server reported sign not connected");
      }
    } catch (e) {
      console.error(`[connect] ${isRetry ? 'Retry' : 'Attempt 1'} failed:`, e.message);
      if (!e.response) setApiError(true);
      if (!isRetry && !isAuto) {
        // Silent first-failure retry for manual user connection
        console.log('[connect] Auto-retrying once...');
        await new Promise(r => setTimeout(r, 1000));
        await doConnect(addr, true, false);
        return;
      }
      setConnectionFailed(true);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setStatus(prev => ({ ...prev, connected: false, address: null, preview_url: null }));
    setIsConnecting(false);
    autoConnectTried.current = true; // Prevent immediate auto-reconnect loop on manual disconnect
    setPushMessage('');
    setLocalPushMessage('');
    setIsManualOverride(false);
    setLastPushedId(null);
    try { await axios.post(`${API_BASE}/disconnect`, {}, { timeout: 3000 }); } catch (e) {}
  };

  const handleMacInput = (raw) => {
    const hex = raw.replace(/[^0-9a-fA-F:]/gi, '').toUpperCase();
    setMacAddress(hex);
  };

  const handleMacBlur = (raw) => {
    const hex = raw.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    if (hex.length >= 12) setMacAddress(formatMac(hex));
  };

  const handleClear = async () => {
    setIsManualOverride(false);
    setLastPushedId(null);
    try { await axios.post(API_BASE + '/clear'); } catch (e) {}
    const atTime = new Date();
    const activeEvents = (events || []).filter(ev =>
      isEventActive(ev, atTime) && ev.response_status?.toLowerCase() !== 'declined'
    );
    const active = activeEvents.sort((a, b) => new Date(b.start_iso) - new Date(a.start_iso))[0];
    if (active && status?.connected) {
      handlePush(getEventDisplayString(active));
    }
  };

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [lastPushedId, setLastPushedId] = useState(null);

  useEffect(() => {
    if (lastPushedId && status?.address) {
      localStorage.setItem(`loy_last_pushed_id_${status.address}`, lastPushedId);
    }
  }, [lastPushedId, status?.address]);
  const [isManualOverride, setIsManualOverrideState] = useState(false);
  const isManualOverrideRef = useRef(false);
  const lastActiveEventIdRef = useRef(null);
  const lastNotifiedEventIdRef = useRef(null);
  // Retain the manually selected saved slot while a calendar event temporarily
  // uses its dedicated calendar slot, so it can be restored when the event ends.
  const calendarReturnPresetRef = useRef(null);
  // A transient BLE disconnect (for example while the PC is locked) must not
  // replay the default and overwrite the preset the user deliberately chose.
  const initializedConnectionMacsRef = useRef(new Set());
  const initializingConnectionRef = useRef(false);
  const setIsManualOverride = (val) => {
    isManualOverrideRef.current = val;
    setIsManualOverrideState(val);
  };
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [deviceNames, setDeviceNames] = useState(() => {
    try { return JSON.parse(localStorage.getItem('loy_device_names_v2') || '{}'); }
    catch { return {}; }
  });
  const [events, setEvents] = useState(null);
  const [cleanName, setCleanName] = useState(() => localStorage.getItem('loy_clean_name') !== 'false');
  const [calLoading, setCalLoading] = useState(false);
  const [now, setNow] = useState(new Date());
  const [presets, setPresets] = useState([]);
  const [dbLoaded, setDbLoaded] = useState(false);
  const [allSavedPresets, setAllSavedPresets] = useState({});

  const activeMac = status.address?.toUpperCase() || localStorage.getItem('loy_last_connected_mac') || 'DEFAULT';
  const savedPresets = useMemo(() => normalizeSavedPresets(allSavedPresets[activeMac]), [allSavedPresets, activeMac]);

  const setSavedPresets = (nextSaved) => {
    if (typeof nextSaved === 'function') {
      setAllSavedPresets(prev => {
        const currentList = normalizeSavedPresets(prev[activeMac]);
        const result = normalizeSavedPresets(nextSaved(currentList));
        return { ...prev, [activeMac]: result };
      });
    } else {
      const normalized = normalizeSavedPresets(nextSaved);
      setAllSavedPresets(prev => ({ ...prev, [activeMac]: normalized }));
    }
  };

  const savedPresetsRef = useRef(savedPresets);
  useEffect(() => {
    savedPresetsRef.current = savedPresets;
  }, [savedPresets]);

  // Load presets from IndexedDB (with migration from localStorage) on mount
  useEffect(() => {
    const loadFromDB = async () => {
      try {
        let dbPresets = await getPresetsFromDB();
        
        // Migration from localStorage
        const savedLocal = localStorage.getItem('loy_presets');
        if (savedLocal) {
          try {
            const parsed = JSON.parse(savedLocal);
            if (Array.isArray(parsed) && parsed.length > 0) {
              dbPresets = parsed;
            }
            localStorage.removeItem('loy_presets');
          } catch (e) {
            console.error("Migration parse failed:", e);
          }
        }
        
        let dbSavedPresets = await getSavedPresetsFromDB();
        
        // Migration from array to object
        if (Array.isArray(dbSavedPresets)) {
          dbSavedPresets = { [DEFAULT_MAC]: dbSavedPresets };
        } else if (!dbSavedPresets) {
          dbSavedPresets = {};
        }

        const savedLocal2 = localStorage.getItem('loy_saved_presets');
        if (savedLocal2) {
          try {
            const parsed = JSON.parse(savedLocal2);
            if (Array.isArray(parsed) && parsed.length > 0) {
              dbSavedPresets = { ...dbSavedPresets, [DEFAULT_MAC]: parsed };
            } else if (typeof parsed === 'object') {
              dbSavedPresets = { ...dbSavedPresets, ...parsed };
            }
            localStorage.removeItem('loy_saved_presets');
          } catch (e) {
            console.error("Migration parse failed:", e);
          }
        }

        const savedLegacy = localStorage.getItem('savedPresets');
        if (savedLegacy) {
          try {
            const parsed = JSON.parse(savedLegacy);
            if (!dbSavedPresets[DEFAULT_MAC] && Array.isArray(parsed) && parsed.length > 0) {
              dbSavedPresets = { ...dbSavedPresets, [DEFAULT_MAC]: parsed };
            }
          } catch (e) {
            console.warn('Ignoring unreadable legacy saved preset cache:', e);
          }
          // Saved presets now live in IndexedDB. Remove this duplicate legacy
          // copy so a video cannot exhaust the small localStorage quota.
          localStorage.removeItem('savedPresets');
        }

        if (dbSavedPresets && Object.keys(dbSavedPresets).length > 0) {
          setAllSavedPresets(dbSavedPresets);
        }

        // Initialize default presets if empty
        const initialized = localStorage.getItem('loy_presets_initialized');
        if (!initialized || !dbPresets || dbPresets.length === 0) {
          localStorage.setItem('loy_presets_initialized', 'true');
          const clockPreset = {
            id: 'clock-default',
            name: 'Digital Clock',
            mode: 'clock',
            text: '',
            textColor: '#ffffff',
            bgColor: '#000000',
            animation: 'show now',
            speed: 15,
            clockStyle: 'default',
            timeFormat: '24h',
            showSeconds: true,
            rotation: 0,
            pixels: Array(64 * 20).fill(0),
            isDefault: false
          };
          if (typeof document !== 'undefined') {
            try {
              const canvas = document.createElement('canvas');
              canvas.width = 64;
              canvas.height = 20;
              const ctx = canvas.getContext('2d');
              if (ctx) {
                ctx.fillStyle = 'black';
                ctx.fillRect(0, 0, 64, 20);
                ctx.fillStyle = '#ffffff';

                ctx.font = '11px Arial, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('12:34 PM', 32, 10);
                clockPreset.thumbnail = canvas.toDataURL();
              }
            } catch (e) {
              console.error("Failed to generate clock thumbnail", e);
            }
          }
          dbPresets = [clockPreset];
        }

        // Migrate legacy animation names to current canonical names
        const migrateAnimation = (anim) => {
          if (!anim) return 'show now';
          if (anim === 'static') return 'show now';
          if (anim === 'move left' || anim === 'move-left') return 'continuous left shift';
          return anim;
        };
        if (Array.isArray(dbPresets)) {
          dbPresets = dbPresets.map(p => ({
            ...p,
            animation: migrateAnimation(p.animation)
          }));
        }

        setPresets(dbPresets);
      } catch (err) {
        console.error("Failed to load presets from DB:", err);
      } finally {
        setDbLoaded(true);
      }
    };
    loadFromDB();
  }, []);

  // Save presets to IndexedDB whenever presets change (after db is loaded)
  useEffect(() => {
    if (dbLoaded) {
      savePresetsToDB(presets).catch(err => console.error("Failed to save presets to IndexedDB:", err));
    }
  }, [presets, dbLoaded]);

  // Keep reserved default slot (slot 2 / index 1) in saved presets synced with default local preset
  useEffect(() => {
    if (!dbLoaded) return;
    const def = (presets || []).find(p => p.isDefault);
    if (!def) return;
    setSavedPresets(prev => {
      const currentList = prev || [];
      const slot2 = currentList[1]?.preset;
      if (slot2 && (slot2.id === def.id || slot2.id === 'hw-slot-1') && slot2.name === def.name && slot2.mode === def.mode && slot2.text === def.text && slot2.imgSrc === def.imgSrc) {
        return prev;
      }
      const next = [...currentList];
      next[1] = {
        slotNumber: 2,
        hwSlotId: 1,
        preset: {
          ...def,
          id: 'hw-slot-1',
          hwSlotId: 1,
          thumbnail: slot2?.thumbnail || def.thumbnail
        }
      };
      return next;
    });
  }, [presets, dbLoaded]);

  // Save savedPresets to IndexedDB whenever they change
  useEffect(() => {
    if (dbLoaded) {
      saveSavedPresetsToDB(allSavedPresets).catch(err => console.error("Failed to save allSavedPresets to IndexedDB:", err));
    }
  }, [allSavedPresets, dbLoaded]);

  useEffect(() => {
    localStorage.setItem('loy_device_names_v2', JSON.stringify(deviceNames));
  }, [deviceNames]);

  const setDeviceName = (addr, name) => {
    setDeviceNames(prev => ({ ...prev, [addr.toUpperCase()]: name }));
  };

  // Update clock every 10s for live "Now" badges and auto-push
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 10000);
    return () => clearInterval(id);
  }, []);

  // Request browser notification permission on startup
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  // Handle timezone changes or returning to the app after settings changes
  useEffect(() => {
    const handleRefresh = () => {
      const currentTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const savedTz = localStorage.getItem('loy_tz');
      
      if (savedTz && currentTz !== savedTz) {
        console.log(`[app] Timezone changed from ${savedTz} to ${currentTz}. Reloading...`);
        localStorage.setItem('loy_tz', currentTz);
        window.location.hash = '#calendar';
        window.location.reload();
        return;
      }
      
      console.log("[app] Window focused, syncing events...");
      setNow(new Date());
      fetchEvents().then(newEvents => {
        if (!isManualOverrideRef.current) {
          const activeEvents = (newEvents || [])?.filter(ev => isEventActive(ev, new Date()) && ev.response_status?.toLowerCase() !== 'declined') || [];
          const active = activeEvents.sort((a, b) => new Date(b.start_iso) - new Date(a.start_iso))[0];
          if (active) {
            console.log("[app] Force-pushing active event after focus:", active.summary);
            setLastPushedId(null);
            handlePush(getEventDisplayString(active), active.response_status);
          }
        }
      });
    };

    // Initialize TZ
    localStorage.setItem('loy_tz', Intl.DateTimeFormat().resolvedOptions().timeZone);

    window.addEventListener('timezonechange', handleRefresh);
    window.addEventListener('focus', handleRefresh);
    return () => {
      window.removeEventListener('timezonechange', handleRefresh);
      window.removeEventListener('focus', handleRefresh);
    };
  }, []);

  const fetchEvents = async () => {
    if (!status?.calendar_connected) return [];
    setCalLoading(true);
    try {
      const isClean = localStorage.getItem('loy_clean_name') !== 'false';
      const res = await axios.get(`${API_BASE}/calendar/today?clean_name=${isClean}`);
      const evs = res.data?.events || [];
      setEvents(evs);
      setCalLoading(false);
      return evs;
    } catch (e) {
      setCalLoading(false);
      return [];
    }
  };

  const syncHardwareSlots = async () => {
    if (!status?.connected) return;
    try {
      const macParam = encodeURIComponent(status.address || DEFAULT_MAC);
      const res = await axios.get(`${API_BASE}/hardware-slots?mac=${macParam}`);
      const hwSlots = res.data?.slots;
      if (Array.isArray(hwSlots) && hwSlots.length > 0) {
        setAllSavedPresets(prev => {
          const rawList = prev[activeMac];
          const currentList = normalizeSavedPresets(rawList);
          let updated = false;
          hwSlots.forEach(s => {
            const idx = s.slot_id;
            if (idx >= 0 && idx < 12) {
              if (idx === 1) {
                // Slot 2 is reserved for the Default Preset. Never clear it to null!
                const defPreset = (presets || []).find(p => p.isDefault);
                const pData = s.preset_data || defPreset;
                const previewUrl = s.preview_url ? `${API_BASE}${s.preview_url}?t=${Date.now()}` : (defPreset?.thumbnail || null);
                if (pData || previewUrl) {
                  const hwPreset = {
                    ...(pData || defPreset || {}),
                    id: 'hw-slot-1',
                    hwSlotId: 1,
                    thumbnail: previewUrl || pData?.thumbnail || defPreset?.thumbnail,
                    isHardware: false
                  };
                  const existing = currentList[1]?.preset;
                  const existingKey = existing?.id + '|' + existing?.thumbnail;
                  const newKey = hwPreset.id + '|' + hwPreset.thumbnail;
                  if (existingKey !== newKey) {
                    updated = true;
                    currentList[1] = { slotNumber: 2, hwSlotId: 1, preset: hwPreset };
                  }
                }
                return;
              }

              if (idx === 0) {
                // Slot 1 is reserved for the Calendar. Preserve existing preset if server cache is empty.
                const pData = s.preset_data;
                const previewUrl = s.preview_url ? `${API_BASE}${s.preview_url}?t=${Date.now()}` : null;
                if (!pData && !previewUrl && currentList[0]?.preset) {
                  return;
                }
                if (pData || previewUrl) {
                  const hwPreset = {
                    ...(pData || {}),
                    id: 'hw-slot-0',
                    hwSlotId: 0,
                    thumbnail: previewUrl || pData?.thumbnail,
                    isHardware: false
                  };
                  const existing = currentList[0]?.preset;
                  const existingKey = existing?.id + '|' + existing?.thumbnail;
                  const newKey = hwPreset.id + '|' + hwPreset.thumbnail;
                  if (existingKey !== newKey) {
                    updated = true;
                    currentList[0] = { slotNumber: 1, hwSlotId: 0, preset: hwPreset };
                  }
                }
                return;
              }

              // Match by hwSlotId to preserve custom user card order
              let targetSlotIndex = currentList.findIndex(item =>
                item?.hwSlotId === idx ||
                item?.preset?.hwSlotId === idx ||
                item?.preset?.id === `hw-slot-${idx}`
              );
              if (targetSlotIndex === -1 && idx < currentList.length) {
                targetSlotIndex = idx;
              }

              if (currentList[targetSlotIndex]?.preset?.mode === 'clock') {
                return;
              }

              if (s.occupied) {
                // The sign is write-only — hardware slot state cannot be reliably read back.
                // Only show a preset card if we have locally cached data (preset_data / preview_url).
                const pData = s.preset_data;
                const previewUrl = s.preview_url ? `${API_BASE}${s.preview_url}?t=${Date.now()}` : null;

                if (!pData && !previewUrl) {
                  // Only clear stale generic placeholder (e.g. old "Sign Slot X")
                  if (currentList[targetSlotIndex]?.preset?.name?.startsWith('Sign Slot ')) {
                    updated = true;
                    currentList[targetSlotIndex] = { ...currentList[targetSlotIndex], preset: null };
                  }
                  return;
                }

                const hwPreset = pData ? {
                  ...pData,
                  id: `hw-slot-${idx}`,
                  hwSlotId: idx,
                  thumbnail: previewUrl || pData.thumbnail,
                  isHardware: false
                } : {
                  id: `hw-slot-${idx}`,
                  hwSlotId: idx,
                  mode: 'image',
                  thumbnail: previewUrl,
                  isHardware: false
                };
                // Only update if content changed (avoid unnecessary re-renders)
                const existing = currentList[targetSlotIndex]?.preset;
                const existingKey = existing?.id + '|' + existing?.thumbnail;
                const newKey = hwPreset.id + '|' + hwPreset.thumbnail;
                if (existingKey !== newKey) {
                  updated = true;
                  currentList[targetSlotIndex] = { ...currentList[targetSlotIndex], hwSlotId: idx, preset: hwPreset };
                }
              } else if (idx >= 2 && currentList[targetSlotIndex]?.preset) {
                // Slot no longer occupied on hardware — clear card
                updated = true;
                currentList[targetSlotIndex] = { ...currentList[targetSlotIndex], preset: null };
              }
            }
          });
          return updated ? { ...prev, [activeMac]: currentList } : prev;
        });
      }
    } catch (e) {
      console.warn("[syncHardwareSlots] Error:", e);
    }
  };

  // Window focus listener to refresh hardware slots when returning to tab
  useEffect(() => {
    if (status.connected && dbLoaded) syncHardwareSlots();
  }, [status.connected, activeMac, dbLoaded]);

  useEffect(() => {
    const onFocus = () => {
      if (status?.connected) {
        syncHardwareSlots();
      }
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [status?.connected, activeMac]);

  // Auto-push / Blanking / Default logic based on the local clock
  useEffect(() => {
    if (!status?.connected || !dbLoaded || pushingRef.current || initializingConnectionRef.current ||
        !initializedConnectionMacsRef.current.has(status.address?.toUpperCase())) return;

    // Check for calendar event transitions to clear manual override (5 min early)
    try {
      if (events) {
        const nextEvent = selectCalendarEvent(events, now);
        const nextEventId = nextEvent ? `${nextEvent.id}-${nextEvent.start_iso}` : null;
        if (nextEventId !== lastActiveEventIdRef.current) {
          console.log(`[auto-push] Event window transition: ${lastActiveEventIdRef.current} -> ${nextEventId}. Clearing manual override.`);
          lastActiveEventIdRef.current = nextEventId;
          setIsManualOverride(false);
        }
      }
    } catch (err) {
      console.error("[auto-push] Error during transition check:", err);
    }

    if (isManualOverride) return;

    try {
      // Find event in current 5-min window [start - 5min, end]
      const currentEvent = selectCalendarEvent(events, now);

      let targetContent = null;
      let targetId = null;

      if (currentEvent) {
        targetContent = { type: 'event', data: currentEvent, summary: getEventDisplayString(currentEvent) };
        targetId = `event-${currentEvent.id}-${targetContent.summary}`;
      } else {
        // No active or upcoming event — target hardware slot 1 (the reserved default slot)
        targetContent = { type: 'hw-default' };
        targetId = 'hw-slot-1';
      }

      if (targetId !== lastPushedId) {
        // Calendar/default transitions operate on hardware slots, so expose
        // that source immediately instead of leaving the UI on Local.
        setPresetView('saved');
        if (targetContent.type === 'event') {
          // Only capture once for a calendar run. Moving from one calendar
          // event directly into another must keep the original return target.
          if (!calendarReturnPresetRef.current && !String(lastPushedId || '').startsWith('event-')) {
            const slotFromLastPush = String(lastPushedId || '').match(/^hw-slot-(\d+)$/);
            const slotFromDisplay = String(status.display_mode || '').match(/^preset-(\d+)$/);
            const savedSlotId = slotFromLastPush ? Number(slotFromLastPush[1]) : (slotFromDisplay ? Number(slotFromDisplay[1]) : null);
            if (Number.isInteger(savedSlotId) && savedSlotId > 0) {
              const savedSlot = (savedPresetsRef.current || []).find(slot =>
                slot?.hwSlotId === savedSlotId || (slot?.slotNumber - 1) === savedSlotId
              );
              if (savedSlot?.preset && !savedSlot.preset.isDefault) {
                calendarReturnPresetRef.current = { slotId: savedSlotId };
              }
            }
          }
          const currentSlot1Preset = savedPresetsRef.current?.[0]?.preset || savedPresets[0]?.preset;
          const currentSlot1Text = (currentSlot1Preset?.text || currentSlot1Preset?.name || '').trim();
          const targetCleanText = targetContent.summary.includes('|||') 
            ? targetContent.summary.split('|||')[0].trim() 
            : targetContent.summary.trim();

          const targetMac = (status.address || DEFAULT_MAC).toUpperCase();
          const isCalSynced = localStorage.getItem('loy_hw_cal_synced_' + targetMac);

          if (isCalSynced && currentSlot1Text && currentSlot1Text === targetCleanText) {
            console.log("[auto-push] Slot 1 already has event text, playing slot 0 directly:", targetCleanText);
            // Notify on first detection even when taking the shortcut path
            if (lastNotifiedEventIdRef.current !== targetId) {
              lastNotifiedEventIdRef.current = targetId;
              if ('Notification' in window && Notification.permission === 'granted') {
                const minutesUntilStart = Math.max(0, Math.round((new Date(currentEvent.start_iso) - new Date()) / 60000));
                const timeLabel = minutesUntilStart <= 1 ? 'now' : `in ${minutesUntilStart} min`;
                new Notification('Upcoming Meeting', {
                  body: `${currentEvent.summary || 'Untitled Event'} starts ${timeLabel}`,
                  icon: '/favicon.ico',
                  tag: `meeting-${targetId}`,
                });
              }
            }
            setLastPushedId(targetId);
            axios.post(`${API_BASE}/preset?id=0&mac=${encodeURIComponent(targetMac)}`).catch(() => {});
            return;
          }

          // Send browser notification the first time this event enters its window
          if (lastNotifiedEventIdRef.current !== targetId) {
            lastNotifiedEventIdRef.current = targetId;
            if ('Notification' in window && Notification.permission === 'granted') {
              const minutesUntilStart = Math.max(0, Math.round((new Date(currentEvent.start_iso) - new Date()) / 60000));
              const timeLabel = minutesUntilStart <= 1 ? 'now' : `in ${minutesUntilStart} min`;
              new Notification('Upcoming Meeting', {
                body: `${cleanEventSummary(currentEvent.summary)} starts ${timeLabel}`,
                icon: '/favicon.ico',
                tag: `meeting-${targetId}`,
              });
            }
          }

          console.log(`[auto-push] Auto-applying event 5m before start: "${currentEvent.summary}"`);
          handlePush(targetContent.summary, false, false, targetId).catch(() => {});
        } else {
          const returnPreset = calendarReturnPresetRef.current;
          calendarReturnPresetRef.current = null;
          if (returnPreset) {
            console.log(`[auto-push] Event window ended, restoring saved slot ${returnPreset.slotId}`);
            setLastPushedId(`hw-slot-${returnPreset.slotId}`);
            axios.post(`${API_BASE}/preset?id=${returnPreset.slotId}&mac=${encodeURIComponent(status.address || DEFAULT_MAC)}`).catch(e => {
              console.warn(`[auto-push] Could not restore saved slot ${returnPreset.slotId}:`, e);
            });
          } else {
            // Play hardware slot 1 — the reserved default
            console.log("[auto-push] Event window ended, playing hardware default slot (slot 1)");
            setLastPushedId('hw-slot-1');
            axios.post(`${API_BASE}/preset?id=1&mac=${encodeURIComponent(status.address || DEFAULT_MAC)}`).catch(e => {
              console.warn("[auto-push] No default saved to slot 1 yet:", e);
            });
          }
          return;
        }
        setLastPushedId(targetId);
      }
    } catch (err) {
      console.error("[auto-push] Error:", err);
    }
  }, [now, events, status.connected, isManualOverride, presets, lastPushedId]);

  // Sync on connection
  useEffect(() => {
    if (status.connected && status.address && dbLoaded && presets && presets.length > 0) {
      setScanOpen(false);
      const targetMac = status.address.toUpperCase();
      if (initializedConnectionMacsRef.current.has(targetMac)) return;
      if (pushingRef.current) return;
      initializedConnectionMacsRef.current.add(targetMac);
      initializingConnectionRef.current = true;
      setPushing(true);
      setPresetView('saved');
      setIsManualOverride(false);
      isManualOverrideRef.current = false;

      const pushDefaultOrActive = async () => {
        // 1. Check if hardware slot 1 (Default Preset, slot 2 in UI) is synced to this sign's hardware
        const def = presets.find(p => p.isDefault);
        const isDefaultSynced = localStorage.getItem('loy_hw_default_synced_' + targetMac);
        if (def && !isDefaultSynced) {
          console.log("[connect] Pushing local default preset to new sign default slot (slot 1)...");
          try {
            const resSave = await savePresetToSign({
              slot_id: 1,
              address: targetMac,
              preset: def
            });
            const savedThumb = resSave.data?.preview_url
              ? `${API_BASE}${resSave.data.preview_url}?t=${Date.now()}`
              : def.thumbnail;
            setAllSavedPresets(prev => {
              const curList = normalizeSavedPresets(prev[targetMac]);
              curList[1] = {
                slotNumber: 2,
                hwSlotId: 1,
                preset: { ...def, id: 'hw-slot-1', hwSlotId: 1, thumbnail: savedThumb, isHardware: false }
              };
              return { ...prev, [targetMac]: curList };
            });
            localStorage.setItem('loy_hw_default_synced_' + targetMac, 'true');
          } catch (e) {
            console.warn("[connect] Failed to push default to slot 1:", e);
          }
        }

        // 2. Calendar Slot (hardware slot 0, slot 1 in UI)
        let evs = [];
        try {
          evs = await fetchEvents();
        } catch (e) {}

        const activeEvents = (evs || []).filter(ev => isEventInWindow(ev, new Date()) && ev.response_status?.toLowerCase() !== 'declined');
        const active = activeEvents.sort((a, b) => new Date(b.start_iso) - new Date(a.start_iso))[0];

        if (active) {
          const activeStr = getEventDisplayString(active);
          console.log("[connect] Pushing active event on connect to slot 0:", active.summary);
          await handlePush(activeStr, false, true, `event-${active.id}-${activeStr}`);
          localStorage.setItem('loy_hw_cal_synced_' + targetMac, 'true');
        } else {
          // If no active event right now: check if this sign has had its calendar preset initialized on hardware
          const isCalSynced = localStorage.getItem('loy_hw_cal_synced_' + targetMac);
          if (!isCalSynced) {
            let prevCal = null;
            try {
              const stored = localStorage.getItem('loy_last_calendar_preset');
              if (stored) prevCal = JSON.parse(stored);
            } catch (e) {}
            if (!prevCal) {
              for (const k of Object.keys(allSavedPresets || {})) {
                if (k !== targetMac && allSavedPresets[k]?.[0]?.preset) {
                  prevCal = allSavedPresets[k][0].preset;
                  break;
                }
              }
            }
            if (prevCal) {
              console.log("[connect] Pushing cached calendar preset to new sign slot 0:", prevCal.text || prevCal.name);
              try {
                const resCal = await savePresetToSign({
                  slot_id: 0,
                  address: targetMac,
                  preset: prevCal
                });
                const calThumb = resCal.data?.preview_url
                  ? `${API_BASE}${resCal.data.preview_url}?t=${Date.now()}`
                  : prevCal.thumbnail;
                setAllSavedPresets(prev => {
                  const curList = normalizeSavedPresets(prev[targetMac]);
                  curList[0] = {
                    slotNumber: 1,
                    hwSlotId: 0,
                    preset: { ...prevCal, id: 'hw-slot-0', hwSlotId: 0, thumbnail: calThumb, isHardware: false }
                  };
                  return { ...prev, [targetMac]: curList };
                });
                localStorage.setItem('loy_hw_cal_synced_' + targetMac, 'true');
              } catch (e) {
                console.warn("[connect] Failed to push previous calendar preset to slot 0:", e);
              }
            }
          }

          const savedLastPushedId = localStorage.getItem(`loy_last_pushed_id_${targetMac}`);
          if (savedLastPushedId && savedLastPushedId !== 'hw-slot-1') {
            console.log(`[connect] Resuming previously pushed preset: ${savedLastPushedId}`);
            setLastPushedId(savedLastPushedId);
          } else {
            console.log("[connect] Playing hardware default slot (slot 1)");
            setLastPushedId('hw-slot-1');
            try {
              await axios.post(`${API_BASE}/preset?id=1&mac=${encodeURIComponent(targetMac)}`);
            } catch (e) {
              console.warn("[connect] No default saved to slot 1 yet:", e);
            }
          }
        }

        if (typeof syncHardwareSlots === 'function') syncHardwareSlots();
      };
      pushDefaultOrActive().catch(e => handleSetPushMessage(`Error: ${e.message}`)).finally(() => {
        initializingConnectionRef.current = false;
        setPushing(false);
        fetchStatus();
      });
    } else if (!status.connected) {
      // Keep the chosen preset across temporary disconnects. The next
      // connection is initialized only once per sign during this app session.
    }
  }, [status.connected, status.address, dbLoaded, presets, pushing]);

  // Regular poll
  useEffect(() => {
    fetchEvents();
    const id = setInterval(fetchEvents, 60000); // Check for last-minute additions every minute
    return () => clearInterval(id);
  }, [status.calendar_connected]);

  const handlePush = async (payload, manual = false, skipMessages = false, autoTargetId = null) => {
    if (pushingRef.current && !skipMessages) return;
    if (manual) setIsManualOverride(true);
    setPushing(true);
    
    let data;
    let pushName = '';
    let isEvent = false;
    
    if (typeof payload === 'string') {
      pushName = 'Event';
      isEvent = true;
      // Extract just the display portion (before the "|||" separator)
      const signText = normalizeForSign(payload.includes('|||') ? payload.split('|||')[0].trim() : payload);
      data = {
        mode: 'text',
        name: signText,
        text: signText,
        textColor: '#ffffff',
        bgColor: '#000000',
        animation: 'continuous left shift',
        speed: speed,
        rotation: 0,
        spacing: 1,
        views: 1
      };
    } else {
      pushName = payload.name;
      data = { ...payload };
      if (data.id) {
        setLastPushedId(data.id);
      } else {
        setLastPushedId(null);
      }
      if (data.mode === 'text') {
        delete data.pixels;
        if (data.text) data.text = normalizeForSign(data.text);
        if (data.name) data.name = normalizeForSign(data.name);
      }
    }

    if (!skipMessages) {
      if (manual) {
        if (isEvent) {
          const currentSlot1Preset = savedPresetsRef.current?.[0]?.preset || savedPresets[0]?.preset;
          const currentSlot1Text = (currentSlot1Preset?.text || currentSlot1Preset?.name || '').trim();
          const targetEventText = (data.text || data.name || pushName || '').trim();
          if (currentSlot1Text && currentSlot1Text === targetEventText) {
            handleSetPushMessage('Playing from Slot 1...');
          } else {
            handleSetPushMessage('Saving event to Slot 1...');
          }
        } else {
          handleSetLocalPushMessage(`Pushing "${pushName}" to sign...`);
        }
      } else {
        handleSetLocalPushMessage('');
      }
    }

    try {
      if (data.mode === 'clock') {
        const pushColor = data.clockStyle === 'default' ? '#ffffff' : (data.textColor || '#10B981');
        await axios.post(`${API_BASE}/clock?on=true&color=${encodeURIComponent(pushColor)}&bg_color=${encodeURIComponent(data.bgColor || '#000000')}&format=${data.timeFormat || '12h'}&show_seconds=${data.showSeconds !== false}&clock_style=${data.clockStyle || 'custom'}`);
        if (manual && !skipMessages) {
          handleSetLocalPushMessage(`Pushed "${pushName}" to sign!`);
        }
        setLastPushedId(data.id || 'clock-default');
      } else if (data.isDefault && status?.connected) {
        // Default preset: play saved default preset (hardware slot 1) directly from hardware
        try {
          await axios.post(`${API_BASE}/preset?id=1&mac=${encodeURIComponent(status.address || '')}`);
          if (manual && !skipMessages) {
            handleSetLocalPushMessage(`Pushed "${pushName}" to sign!`);
          }
          setLastPushedId('hw-slot-1');
        } catch (defErr) {
          if (defErr.response?.status === 404) {
            // Hardware slot not saved yet for this sign — push the local preset data directly
            console.log('[handlePush] Default HW slot not found, pushing local preset data directly');
            const fallbackData = { ...data };
            if (fallbackData.mode === 'text') delete fallbackData.pixels;
            await axios.post(`${API_BASE}/push-text`, fallbackData);
            if (manual && !skipMessages) {
              handleSetLocalPushMessage(`Pushed "${pushName}" to sign!`);
            }
            setLastPushedId(data.id || 'hw-slot-1');
          } else {
            throw defErr;
          }
        }
      } else if (isEvent) {
        if (status.connected) {
          setPresetView('saved');
          const eventPresetCopy = { ...data };
          delete eventPresetCopy.pixels;

          const targetMac = (status.address || '').toUpperCase();
          const currentSlot1Preset = savedPresetsRef.current?.[0]?.preset || savedPresets[0]?.preset;
          const currentSlot1Text = (currentSlot1Preset?.text || currentSlot1Preset?.name || '').trim();
          const targetEventText = (eventPresetCopy.text || eventPresetCopy.name || '').trim();
          const isCalSynced = localStorage.getItem('loy_hw_cal_synced_' + targetMac);

          // Skip re-saving if hardware slot 1 already has this event text (auto OR manual)
          if (isCalSynced && currentSlot1Text && currentSlot1Text === targetEventText) {
            console.log('[push-event] Slot 1 already has this text, playing slot 0 directly from hardware');
            handleSetPushMessage('Playing from Slot 1...');
            await axios.post(`${API_BASE}/preset?id=0&mac=${encodeURIComponent(targetMac)}`);
            setLastPushedId(autoTargetId || 'hw-slot-0');
            await fetchStatus();
            handleSetPushMessage('Pushed Slot 1 to sign!');
            return;
          }

          handleSetPushMessage('Saving event to Slot 1...');

          try {
            const saveRes = await savePresetToSign({
              slot_id: 0,
              address: targetMac,
              preset: eventPresetCopy
            });
            const savedThumb = saveRes.data?.preview_url
              ? `${API_BASE}${saveRes.data.preview_url}?t=${Date.now()}`
              : null;
            // Show confirmation first before updating UI previews
            handleSetPushMessage('Saved to Slot 1!');
            setSavedPresets(prev => {
              const next = [...prev];
              next[0] = {
                slotNumber: 1,
                preset: { ...eventPresetCopy, id: 'hw-slot-0', thumbnail: savedThumb || eventPresetCopy.thumbnail }
              };
              return next;
            });
            setLastPushedId(autoTargetId || 'hw-slot-0');
            localStorage.setItem('loy_hw_cal_synced_' + targetMac, 'true');
            try {
              localStorage.setItem('loy_last_calendar_preset', JSON.stringify({ ...eventPresetCopy, id: 'hw-slot-0', thumbnail: savedThumb || eventPresetCopy.thumbnail }));
            } catch (e) {}
          } catch (saveErr) {
            console.warn('[push-event] Saved preset to slot 0 error:', saveErr);
            handleSetPushMessage(`Error saving to Slot 1: ${saveErr.response?.data?.detail || saveErr.message}`);
          }
        } else {
          handleSetPushMessage('Error: Sign not connected');
        }
      } else {
        await axios.post(`${API_BASE}/push-text`, data);
        if (manual && !skipMessages) {
          handleSetLocalPushMessage(`Pushed "${pushName}" to sign!`);
        }
        setLastPushedId(data.id || null);
      }
      fetchStatus();
    } catch (e) {
      console.error('[push] Failed:', e);
      const detail = e.response?.data?.detail;
      const errorMsg = typeof detail === 'string' ? detail : (Array.isArray(detail) ? detail[0]?.msg : JSON.stringify(detail));
      const isDisconnectError = !status.connected || 
        (errorMsg && (errorMsg.includes('-2147023673') || errorMsg.toLowerCase().includes('canceled') || errorMsg.toLowerCase().includes('cancelled') || errorMsg.toLowerCase().includes('disconnected') || errorMsg.toLowerCase().includes('not connected')));
      if (!skipMessages) {
        (isEvent ? handleSetPushMessage : handleSetLocalPushMessage)('Error: ' + (errorMsg || e.message));
      }
      throw e;
    } finally {
      setPushing(false);
    }
  };


  const handlePushManual = (name, status) => {
    setIsManualOverride(true);
    handlePush(name, true);
  };

  return (
    <div className="app-container">
      <header className="header-row" style={{ marginBottom: 40 }}>
        <div className="logo-group"></div>
        
        {apiError && (
          <div className="flex items-center gap-2 px-3 py-1.5 bg-red-500/20 text-red-400 rounded-full border border-red-500/20 animate-pulse">
            <Wifi size={14} />
            <span className="text-[10px] font-black uppercase tracking-widest">Server Offline</span>
          </div>
        )}
      </header>

      <div className="main-view-layout">
        <div className="left-column">
          <div className="dashboard-side">
            <DashboardView 
              status={status} power={power} setPower={setPower}
              brightness={brightness} setBrightness={setBrightness}
              speed={speed} setSpeed={setSpeed}
              macAddress={macAddress}
              onMacInput={handleMacInput}
              onMacBlur={handleMacBlur}
              onConnect={doConnect}
              onDisconnect={handleDisconnect}
              isConnecting={isConnecting}
              onClear={handleClear}
              isModalOpen={isModalOpen}
              onPush={handlePush}
              connectionFailed={connectionFailed}
              apiError={apiError}
              deviceNames={deviceNames}
              setDeviceName={setDeviceName}
              previewStamp={previewStamp}
              lastPushedId={lastPushedId}
              setLastPushedId={setLastPushedId}
              setIsManualOverride={setIsManualOverride}
              presets={presets}
              savedPresets={savedPresets}
              setSavedPresets={setSavedPresets}
              savedDraggedIdx={savedDraggedIdx}
              setSavedDraggedIdx={setSavedDraggedIdx}
              savedDragOverIdx={savedDragOverIdx}
              setSavedDragOverIdx={setSavedDragOverIdx}
              now={now}
              pushMessage={pushMessage || localPushMessage}
              setPushMessage={handleSetPushMessage}
              pushing={pushing}
              setPushing={setPushing}
              scanOpen={scanOpen}
              setScanOpen={setScanOpen}
              syncHardwareSlots={syncHardwareSlots}
              fetchStatus={fetchStatus}
              presetView={presetView}
              setPresetView={setPresetView}
            />
          </div>
          <MediaView 
            status={status} 
            isModalOpen={isModalOpen}
            setIsModalOpen={setIsModalOpen}
            presets={presets}
            setPresets={setPresets}
            onPush={handlePush}
            onPushSuccess={fetchStatus}
            now={now}
            pushMessage={localPushMessage}
            setPushMessage={handleSetPushMessage}
            setLocalPushMessage={handleSetLocalPushMessage}
            setUnifiedPushMessage={setUnifiedPushMessage}
            pushing={pushing}
            setPushing={setPushing}
            savedPresets={savedPresets}
            setSavedPresets={setSavedPresets}
            syncHardwareSlots={syncHardwareSlots}
            setLastPushedId={setLastPushedId}
            presetView={presetView}
            setPresetView={setPresetView}
          />
        </div>
        <div className="right-column">
          <CalendarView 
            status={status} 
            events={events}
            loading={calLoading}
            fetchEvents={fetchEvents}
            now={now}
            onPush={handlePush}
            pushMessage={pushMessage || localPushMessage}
            pushing={pushing}
            cleanName={cleanName}
            setCleanName={setCleanName}
          />
        </div>
      </div>
    </div>
  );
}

function NavButton({ icon, label, active, onClick }) {
  return (
    <button onClick={onClick} className={`btn-styled px-5 py-2 text-sm ${!active && 'inactive'}`}>
      {icon} <span>{label}</span>
    </button>
  );
}

/* ─── Dashboard ─────────────────────────────────────────────────────── */
function DashboardView({ status, power, setPower, brightness, setBrightness, speed, setSpeed, macAddress, onMacInput, onMacBlur, onConnect, onDisconnect, isConnecting, onClear, isModalOpen, onPush, connectionFailed, apiError, deviceNames, setDeviceName, previewStamp, lastPushedId, setLastPushedId, setIsManualOverride, presets, savedPresets, setSavedPresets, savedDraggedIdx, setSavedDraggedIdx, savedDragOverIdx, setSavedDragOverIdx, now, pushMessage, setPushMessage, pushing, setPushing, scanOpen, setScanOpen, syncHardwareSlots, fetchStatus, presetView, setPresetView }) {
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    setIsLoaded(false);
  }, [status.preview_url, previewStamp]);

  const [scanResults, setScanResults] = useState([]);
  const [recents, setRecents] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('loy_recents') || '[]');
      if (Array.isArray(saved)) {
        return saved;
      }
    } catch {}
    return [];
  });
  const [scanTab, setScanTab] = useState('all');
  const [isScanning, setIsScanning] = useState(false);
  const [scanSearch, setScanSearch] = useState('');
  const [scanPage, setScanPage] = useState(0);
  const [nameEditMode, setNameEditMode] = useState(false);
  const [nameEditValue, setNameEditValue] = useState('');
  const [assigningSlotIndex, setAssigningSlotIndex] = useState(null);
  const [slotSaveProgress, setSlotSaveProgress] = useState(null);
  const [slotSavePhase, setSlotSavePhase] = useState('');
  const [savedPage, setSavedPage] = useState(0);
  const isAssignmentReminder = pushMessage === 'Please assign animated text, GIFs, and videos to a Saved Preset before pushing.';
  const previewRef = useRef(null);
  const pendingConnectRef = useRef(null); // stores { addr, name } of the device being connected

  // Removed playbackRate adjustment; speed is controlled via CSS variable '--scroll-duration'
  // This simplifies preview animation handling.


  useEffect(() => {
    localStorage.setItem('loy_recents', JSON.stringify(recents));
  }, [recents]);

  const togglePower = async () => {
    const next = !power;
    setPower(next);
    try {
      await axios.post(`${API_BASE}/power?on=${next}`);
    } catch (e) {
      setPower(!next);
    }
  };

  const onBrightnessChange = async (val) => {
    setBrightness(val);
    try { await axios.post(`${API_BASE}/brightness?level=${val}`); } catch (e) {}
  };

  const onSpeedChange = async (val) => {
    setSpeed(val);
    try { await axios.post(`${API_BASE}/speed?level=${val}`); } catch (e) {}
  };

  const startScan = async (forcedTab) => {
    if (forcedTab) setScanTab(forcedTab);
    setScanPage(0);
    setIsScanning(true);
    setScanResults([]);
    try {
      const res = await axios.get(`${API_BASE}/scan`, { timeout: 30000 });
      setScanResults(res.data.filter(d => d.is_led));
    } catch (e) {
      console.error("Scan error or timeout:", e);
    }
    setIsScanning(false);
  };

  const handleScanOpen = () => {
    setScanOpen(true);
    setScanSearch('');
    setScanPage(0);
    startScan();
  };

  const handleConnectOrScan = () => {
    handleScanOpen();
  };

  // Helper: detect if a string looks like a raw MAC address
  const isMacAddress = (s) => /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(s);

  const addRecent = (addr, name) => {
    if (!addr) return;
    setRecents(prev => {
      const existing = prev.find(d => d.address === addr);
      let finalName = name || addr;
      if (existing && existing.name && !isMacAddress(existing.name) && (!name || name === addr)) {
        finalName = existing.name;
      }
      if (!existing && isMacAddress(finalName)) return prev;
      const filtered = prev.filter(d => d.address !== addr);
      return [{ address: addr, name: finalName }, ...filtered].slice(0, 10);
    });
  };

  const removeRecent = (addr) => {
    setRecents(prev => prev.filter(d => d.address !== addr));
  };

  const clearRecents = () => {
    setRecents([]);
  };

  const pickDevice = (addr, name) => {
    setScanOpen(false);
    setIsManualOverride(false);
    setLastPushedId(null);
    setMacAddress(addr);
    try {
      localStorage.setItem('loy_last_connected_mac', addr);
      localStorage.setItem('loy_mac', addr);
    } catch (e) {}
    pendingConnectRef.current = { addr, name }; // remember name; only commit to recents on success
    onConnect(addr);
  };

  // Only add to recents once the connection actually succeeds
  useEffect(() => {
    if (status.connected && status.address) {
      const pending = pendingConnectRef.current;
      if (pending && pending.addr.toLowerCase() === status.address.toLowerCase()) {
        // Connection succeeded — now it's safe to record
        addRecent(pending.addr, pending.name);
        pendingConnectRef.current = null;
      } else {
        // App restarted / reconnected automatically — update existing entry only
        addRecent(status.address);
      }
    }
  }, [status.connected, status.address]);

  // For recents, filter out any nameless records while retaining known signs
  const recentsFiltered = recents.filter(d => d.name && !isMacAddress(d.name));
  const devicesToFilter = scanTab === 'recents' ? recentsFiltered : scanResults;
  const filteredDevices = devicesToFilter.filter(d =>
    d.name?.toLowerCase().includes(scanSearch.toLowerCase()) ||
    d.address?.toLowerCase().includes(scanSearch.toLowerCase())
  );
  const totalPages = Math.ceil(filteredDevices.length / SCAN_PAGE_SIZE);
  const pagedDevices = filteredDevices.slice(scanPage * SCAN_PAGE_SIZE, (scanPage + 1) * SCAN_PAGE_SIZE);

  const slotsPerPage = 12;
  const totalSavedPages = Math.ceil((savedPresets || []).length / slotsPerPage);

  const assignPresetToSlot = async (globalIdx, preset) => {
    if (pushing) return;
    console.log('[assignPresetToSlot] Called with globalIdx:', globalIdx, 'preset:', preset);
    if (!preset) {
      console.warn('[assignPresetToSlot] No preset provided');
      return;
    }

    // Slots 0 and 1 are reserved (Calendar and Default) — block manual assignment
    if (globalIdx === 0 || globalIdx === 1) {
      setPushMessage(`Slot ${globalIdx + 1} is reserved and cannot be manually assigned.`);
      return;
    }

    if (preset.text?.includes('|||')) {
      setPushMessage('Event presets cannot be saved to slots.');
      return;
    }

    if (preset.mode === 'clock' || preset.id === 'clock-default') {
      const slotObj = savedPresets[globalIdx];
      const hwSlotId = slotObj?.hwSlotId !== undefined 
        ? slotObj.hwSlotId 
        : (slotObj?.slotNumber ? slotObj.slotNumber - 1 : globalIdx);

      const nextSaved = [...savedPresets];
      nextSaved[globalIdx] = {
        ...nextSaved[globalIdx],
        hwSlotId: hwSlotId,
        preset: {
          ...preset,
          id: preset.id || `saved-clock-${globalIdx}`,
          mode: 'clock',
          hwSlotId: hwSlotId
        }
      };
      try {
        if (typeof onPush === 'function') {
          await onPush(preset, true, true);
        }
        // IndexedDB persists the slot; do not duplicate video frames in localStorage.
        setPushMessage(`Assigned Clock to Slot ${globalIdx + 1}!`);
        setSavedPresets(nextSaved);
        setIsManualOverride(true);
        setLastPushedId(preset.id || `saved-clock-${globalIdx}`);
      } catch (err) {
        console.warn('Failed to push clock on assign:', err);
        const detail = err.response?.data?.detail || err.message || '';
        setPushMessage(`Error: Failed to assign Clock to Slot ${globalIdx + 1}${detail ? ` — ${detail}` : ''}`);
      }
      return;
    }

    const presetCopy = { ...preset };
    if (presetCopy.mode === 'text') {
      delete presetCopy.pixels;
    }

    if (globalIdx >= 12) {
      setPushing(true);
      setPushMessage(`Saving to App Slot ${globalIdx + 1}...`);
      
      const nextSaved = [...savedPresets];
      nextSaved[globalIdx] = {
        ...nextSaved[globalIdx],
        preset: { ...presetCopy, id: `saved-${Date.now()}-${globalIdx}` }
      };

      try {
        if (typeof onPush === 'function') {
           await onPush(presetCopy, true, true);
        } else {
           await axios.post(`${API_BASE}/preset`, {
             preset: presetCopy,
             mac: status.address || DEFAULT_MAC
           });
        }
        setPushMessage(`Assigned to App Slot ${globalIdx + 1}!`);
        setSavedPresets(nextSaved);
        setIsManualOverride(true);
        setLastPushedId(`saved-${Date.now()}-${globalIdx}`);
      } catch (err) {
        setPushMessage(`Assigned to App Slot ${globalIdx + 1}, but failed to preview on sign.`);
      } finally {
        setPushing(false);
      }
      return;
    }

    setPushing(true);
    setIsManualOverride(true);
    setPushMessage(`Saving to slot ${globalIdx + 1}...`);
    setSlotSaveProgress(0);
    setSlotSavePhase('Uploading preset');
    const progressId = `slot-save-${Date.now()}-${globalIdx}`;
    let pollActive = true;
    let highestProgress = 0;
    const updateProgress = (progress, phase) => {
      if (!pollActive || progress < highestProgress) return;
      highestProgress = progress;
      setSlotSaveProgress(progress);
      setSlotSavePhase(phase);
    };
    const progressPoll = window.setInterval(() => {
      axios.get(`${API_BASE}/save-progress/${encodeURIComponent(progressId)}`)
        .then(res => {
          updateProgress(res.data?.progress ?? 0, res.data?.phase || 'Preparing preset');
        })
        .catch(() => {});
    }, 300);
    try {
      const slotObj = savedPresets[globalIdx];
      const hwSlotId = slotObj?.hwSlotId !== undefined 
        ? slotObj.hwSlotId 
        : (slotObj?.slotNumber ? slotObj.slotNumber - 1 : globalIdx);

      // Keep the same stitched-row layout used by local GIF/video previews.
      // The former compact conversion was read as contiguous frames on the
      // server, scrambling the video and discarding cached preview pixels.
      const presetForUpload = { ...presetCopy };
      if (presetForUpload.pixelsRgbB64) {
        delete presetForUpload.pixels;
      }
      // Pixels already contain the crop; omit the large original source from
      // the upload. The local preset retains it for editing/exporting.
      if (presetForUpload.pixels?.length) delete presetForUpload.imgSrc;

      const res = await savePresetToSign({
        slot_id: hwSlotId,
        address: status.address || DEFAULT_MAC,
        preset: presetForUpload,
        progress_id: progressId
      }, {
        timeout: 300000,
        onUploadProgress: (event) => {
          if (event.total) {
            updateProgress(Math.min(15, Math.round((event.loaded / event.total) * 15)), 'Uploading preset');
          }
        }
      });

      const savedThumbnail = res.data?.preview_url 
        ? `${API_BASE}${res.data.preview_url}?t=${Date.now()}` 
        : presetCopy.thumbnail;

      const nextSaved = [...savedPresets];
      nextSaved[globalIdx] = {
        ...nextSaved[globalIdx],
        hwSlotId: hwSlotId,
        preset: { 
          ...presetCopy, 
          id: `saved-${Date.now()}-${globalIdx}`,
          hwSlotId: hwSlotId,
          thumbnail: savedThumbnail
        }
      };
      setPushMessage(`Saved to slot ${globalIdx + 1}!`);
      setSavedPresets(nextSaved);
      setIsManualOverride(true);
      setLastPushedId(`hw-slot-${hwSlotId}`);
      if (typeof syncHardwareSlots === 'function') await syncHardwareSlots();
      if (typeof fetchStatus === 'function') await fetchStatus();
    } catch (err) {
      const detail = err.response?.data?.detail || err.message || '';
      const isDisconnectError = !status.connected || detail.includes('-2147023673') || detail.toLowerCase().includes('canceled') || detail.toLowerCase().includes('cancelled') || detail.toLowerCase().includes('disconnected') || detail.toLowerCase().includes('not connected');
      setPushMessage(`Error: ${detail || 'Failed to save preset'}`);
    } finally {
      pollActive = false;
      window.clearInterval(progressPoll);
      setSlotSaveProgress(null);
      setSlotSavePhase('');
      setPushing(false);
    }
  };

  const playSavedPreset = async (globalIdx, preset) => {
    if (pushing) return;
    if (!preset) return; // Do nothing when clicking empty slots!

    if (preset.mode === 'clock' || preset.id === 'clock-default') {
      setPushing(true);
      setPushMessage(`Pushing Clock to sign...`);
      setIsManualOverride(true);
      try {
        await onPush(preset, true, true);
        setPushMessage(`Pushed Clock to sign!`);
        setLastPushedId(preset.id || `saved-clock-${globalIdx}`);
      } catch (err) {
        console.error('Failed to trigger clock play:', err);
        setPushMessage(`Error: ${err.message}`);
      } finally {
        setPushing(false);
      }
      return;
    }

    const slotObj = savedPresets[globalIdx];
    const hwSlotId = preset.hwSlotId !== undefined 
      ? preset.hwSlotId 
      : (slotObj?.hwSlotId !== undefined 
        ? slotObj.hwSlotId 
        : (preset.id && typeof preset.id === 'string' && preset.id.startsWith('hw-slot-') 
          ? parseInt(preset.id.split('-')[2], 10) 
          : globalIdx));

    setPushing(true);
    setPushMessage(preset.name ? `Pushing "${preset.name}" to sign...` : `Pushing slot ${globalIdx + 1} to sign...`);
    setIsManualOverride(true);

    try {
      if (hwSlotId < 12) {
        // Notify server to switch active hardware preset slot and update live preview
        await axios.post(`${API_BASE}/preset?id=${hwSlotId}&mac=${encodeURIComponent(status.address || DEFAULT_MAC)}`);
        if (typeof fetchStatus === 'function') await fetchStatus();
        setPushMessage(preset.name ? `Pushed "${preset.name}" to sign!` : `Pushed slot ${globalIdx + 1} to sign!`);
        setLastPushedId(`hw-slot-${hwSlotId}`);
      } else {
        await onPush(preset, true, true);
        setPushMessage(preset.name ? `Pushed "${preset.name}" to sign!` : `Pushed slot ${globalIdx + 1} to sign!`);
        setLastPushedId(preset.id || `hw-slot-${hwSlotId}`);
      }
    } catch (err) {
      console.error('Failed to trigger hardware preset play:', err);
      const detail = err.response?.data?.detail || err.message || '';
      const isDisconnectError = !status.connected || detail.includes('-2147023673') || detail.toLowerCase().includes('canceled') || detail.toLowerCase().includes('cancelled') || detail.toLowerCase().includes('disconnected') || detail.toLowerCase().includes('not connected');
      setPushMessage(`Error: ${detail || err.message}`);
    } finally {
      setPushing(false);
    }
  };

  const handleDropOnSlot = async (e, slotGlobalIndex) => {
    e.preventDefault();
    setSavedDraggedIdx(null);
    setSavedDragOverIdx(null);
    const dragData = e.dataTransfer.getData('text/plain');
    console.log('[handleDropOnSlot] Drop detected on slot:', slotGlobalIndex, 'dragData:', dragData);
    if (!dragData) return;

    if (dragData.startsWith('saved-slot:')) {
      const sourceGlobalIndex = parseInt(dragData.split(':')[1], 10);
      if (isNaN(sourceGlobalIndex) || sourceGlobalIndex === slotGlobalIndex) return;

      // Protect reserved slots (0 and 1: Calendar and Default)
      if (sourceGlobalIndex < 2 || slotGlobalIndex < 2) return;

      console.log('[handleDropOnSlot] Reordering saved slots:', sourceGlobalIndex, '->', slotGlobalIndex);
      const nextSaved = [...savedPresets];
      const [draggedItem] = nextSaved.splice(sourceGlobalIndex, 1);
      nextSaved.splice(slotGlobalIndex, 0, draggedItem);

      setSavedPresets(nextSaved);
      return;
    } else {
      if (presets) {
        console.log('[handleDropOnSlot] Dropped local preset ID:', dragData);
        const preset = presets.find(p => p.id?.toString() === dragData || p.id === dragData);
        console.log('[handleDropOnSlot] Found matching local preset:', preset);
        if (preset) {
          const presetCopy = { ...preset };
          await assignPresetToSlot(slotGlobalIndex, presetCopy);
        } else {
          console.warn('[handleDropOnSlot] No matching preset found for ID:', dragData);
        }
      }
    }
  };

  const pushPreset = async (p) => {
    try {
      await onPush(p, true, true);
    } catch (err) {
      console.error('[push] Failed:', err);
      throw err;
    }
  };

  const dragStartPos = useRef({ x: 0, y: 0, time: 0 });
  const handlePointerDown = (e) => {
    dragStartPos.current = { 
      x: e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0), 
      y: e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : 0), 
      time: Date.now() 
    };
  };
  const handlePointerUp = (e, callback) => {
    if (!dragStartPos.current) {
      callback();
      return;
    }
    const clientX = e.clientX !== undefined ? e.clientX : (e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientX : 0);
    const clientY = e.clientY !== undefined ? e.clientY : (e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientY : 0);
    const dx = clientX - dragStartPos.current.x;
    const dy = clientY - dragStartPos.current.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const dt = Date.now() - dragStartPos.current.time;
    
    // Treat as click if they didn't move much, OR if it was a very fast click (< 500ms)
    if (distance < 15 || dt < 500) {
      callback();
    }
    dragStartPos.current = null;
  };

  const activePreset = (() => {
    // 1. If we have a manual override from a recent click
    if (lastPushedId) {
      const p = presets.find(p => p.id === lastPushedId || `preset-${p.id}` === lastPushedId) || 
                savedPresets.map(s => s.preset).filter(Boolean).find(p => p.id === lastPushedId || `preset-${p.id}` === lastPushedId);
      if (p) return p;
      if (typeof lastPushedId === 'string' && lastPushedId.startsWith('hw-slot-')) {
        const slotHwId = parseInt(lastPushedId.split('-')[2], 10);
        return savedPresets.find(s => s?.preset?.hwSlotId === slotHwId || s?.hwSlotId === slotHwId || s?.preset?.id === lastPushedId)?.preset;
      }
    }
    // 2. Fallback to reading the hardware display_mode status
    if (status?.display_mode && typeof status.display_mode === 'string' && status.display_mode.startsWith('preset-')) {
       const slotIdx = parseInt(status.display_mode.split('-')[1], 10);
       if (!isNaN(slotIdx)) {
         return savedPresets.find(s => s?.preset?.hwSlotId === slotIdx || s?.hwSlotId === slotIdx || s?.preset?.id === `hw-slot-${slotIdx}`)?.preset;
       }
    }
    return null;
  })();

  let currentSn = '';
  const connectedRecent = recents.find(r => r.address === status.address);
  if (connectedRecent) {
    let rawName = connectedRecent.name || '';
    if (rawName.startsWith('HELLO')) {
      currentSn = 'YS' + rawName.substring(5);
    } else if (rawName.includes('-')) {
      currentSn = 'YS' + rawName.split('-')[1];
    } else if (rawName.startsWith('YS')) {
      currentSn = rawName;
    }
  }
  const defaultDisplayName = currentSn || status.address;

  return (
    <div className="flex flex-col items-center">
      <div className="dashboard-hero">
        {/* Power btn — top aligned */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div onClick={togglePower} className={`power-btn ${power ? 'on' : 'off'} ${!status.connected ? 'disabled' : ''}`} title={power ? 'Turn Off' : 'Turn On'}>
            <Power size={26} />
          </div>
          <div onClick={() => {
            const defPreset = (presets || []).find(p => p.isDefault);
            if (defPreset && status?.connected) {
              setIsManualOverride(true);
              pushPreset(defPreset);
            }
          }} className={`power-btn off ${!status.connected ? 'disabled' : ''}`} style={{ background: 'rgba(255, 255, 255, 0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#f8fafc', opacity: status.connected ? 1 : 0.2, pointerEvents: status.connected ? 'auto' : 'none' }} title="Trigger Default Preset" onMouseOver={e => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)'; e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)'; e.currentTarget.style.transform = 'scale(1.05)'; }} onMouseOut={e => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)'; e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)'; e.currentTarget.style.transform = 'none'; }}>
            <img src="https://static.thenounproject.com/png/5507757-200.png" alt="Default" width="34" height="34" style={{ filter: 'invert(100%)', opacity: status.connected ? 0.9 : 0.4 }} />
          </div>
        </div>

        <div className="preview-stack opacity-100 scale-100">
          <div className="preview-box">
            {status?.connected ? (
              status?.display_mode === 'clock' ? (
                <ClockPresetCardPreview
                  preset={{
                    textColor: status.clock_color || '#ffffff',
                    bgColor: status.clock_bg_color || '#000000',
                    clockStyle: status.clock_style || 'default',
                    timeFormat: status.clock_format || '24h',
                    showSeconds: status.clock_show_seconds !== false
                  }}
                  style={{ width: '100%', height: '100%', objectFit: 'fill', imageRendering: 'pixelated' }}
                />
              ) : activePreset ? (
                <div style={{ width: '100%', height: '100%', position: 'relative' }}>
                  <PresetCardMedia preset={activePreset} now={now} />
                </div>
              ) : status?.preview_url ? (
                <img
                  ref={previewRef}
                  src={`${API_BASE}${status.preview_url}?t=${previewStamp}`}
                  className={`${status.width && status.width > 64 ? "scrolling-preview" : "static-preview"} ${isLoaded ? 'loaded' : ''}`}
                  style={status.width && status.width > 64 ? { '--scroll-duration': `${((64 + status.width) * Math.max(10, 80 - (activePreset?.speed !== undefined ? activePreset.speed : (status?.speed !== undefined ? status.speed : speed)) * 5)) / 1000}s` } : {}}
                  onLoad={() => setIsLoaded(true)}
                />
              ) : (
                <div style={{width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: '12px'}}>
                  Connecting...
                </div>
              )
            ) : (
              <div style={{width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: '12px'}}>
                Disconnected
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
            <div className="brightness-rail glass-panel" style={{ opacity: status.connected ? 1 : 0.2, pointerEvents: status.connected ? 'auto' : 'none', padding: '12px 16px', flex: 1 }}>
              <Sun className="text-amber-400 flex-shrink-0" size={17} />
              <input 
                type="range" min="1" max="15" value={brightness} 
                onChange={(e) => onBrightnessChange(parseInt(e.target.value))} 
                className="h-slider" 
                disabled={!status.connected}
              />
              <span className="font-bold text-slate-500 w-6 text-[10px] text-right">{brightness}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Connection row */}
      <div className="connection-row" style={{ position: 'relative' }}>
        {status.connected ? (
          <>
            <button className="btn-disconnect" onClick={onDisconnect}>
              <Link2Off size={16} /> Disconnect
            </button>
            {nameEditMode ? (
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
                <input
                  autoFocus
                  className="input-field"
                  style={{ height: '36px', width: '180px', fontSize: 13 }}
                  value={nameEditValue}
                  placeholder="Enter device name…"
                  onChange={e => setNameEditValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      setDeviceName(status.address, nameEditValue.trim());
                      setNameEditMode(false);
                    }
                    if (e.key === 'Escape') setNameEditMode(false);
                  }}
                />
                <button 
                  className="btn-styled" 
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 36, width: 36, padding: 0 }} 
                  onClick={() => {
                    setDeviceName(status.address, nameEditValue.trim());
                    setNameEditMode(false);
                  }}
                  title="Save Name"
                >
                  <Save size={14} />
                </button>
                <button 
                  className="btn-disconnect" 
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 36, width: 36, padding: 0 }} 
                  onClick={() => setNameEditMode(false)}
                  title="Cancel"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <div
                className="mac-display flex items-center gap-2 cursor-pointer group"
                onClick={() => { setNameEditValue(deviceNames[status.address?.toUpperCase()] || defaultDisplayName); setNameEditMode(true); }}
                title="Click to name this device"
              >
                <span>{deviceNames[status.address?.toUpperCase()] || defaultDisplayName}</span>
                <Pencil size={12} className="opacity-0 group-hover:opacity-60 transition-opacity" />
              </div>
            )}
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button 
              className="btn-styled flex items-center justify-center gap-2" 
              style={{ whiteSpace: 'nowrap', minWidth: '140px', height: '42px', padding: '0 18px' }} 
              onClick={() => {
                if (isConnecting) onDisconnect();
                else if (macAddress) onConnect(macAddress);
                else handleConnectOrScan();
              }} 
              title={macAddress ? `Connect to ${deviceNames[macAddress?.toUpperCase()] || macAddress}` : 'Connect'}
            >
              {isConnecting ? (
                <><RefreshCw size={14} className="animate-spin" /> Cancel</>
              ) : isScanning ? 'Scanning...' : (
                `Connect${macAddress && deviceNames[macAddress?.toUpperCase()] ? ` (${deviceNames[macAddress.toUpperCase()]})` : ''}`
              )}
            </button>
            <button
              className="btn-styled flex items-center justify-center"
              style={{ height: '42px', width: '42px', padding: 0 }}
              onClick={handleScanOpen}
              title="Change Sign / Scan Nearby"
            >
              <Search size={15} />
            </button>
            {connectionFailed && !isConnecting && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                fontSize: '11px', color: '#f87171', fontWeight: 600,
                background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.25)',
                borderRadius: '8px', padding: '6px 10px', whiteSpace: 'nowrap'
              }}>
                <span>⚠</span>
                <span>{apiError ? 'Server offline' : 'Connection failed — power cycle the sign and retry'}</span>
              </div>
            )}
          </div>
        )}

        {/* Scan popup — floats above, doesn't push layout */}
        <AnimatePresence>
          {scanOpen && (
            <>
              {/* Backdrop to close on click outside */}
              <div className="fixed inset-0 z-40" onClick={() => setScanOpen(false)} />
              
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className="scan-popup glass-panel z-50"
              >
                <div className="scan-popup-header">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-widest text-slate-400">
                      {isScanning ? 'Scanning...' : scanTab === 'recents' ? 'Recent Devices' : 'Nearby Devices'}
                    </span>
                  </div>
                  <button 
                    onClick={() => setScanOpen(false)} 
                    className="btn-styled p-2 rounded-2xl ml-4"
                    style={{ minWidth: 'auto' }}
                  >
                    <X size={14} />
                  </button>
                </div>

                {/* Tabs */}
                <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                  <button 
                    className={`btn-styled ${scanTab === 'all' ? '' : 'inactive'}`}
                    style={{ flex: 1, padding: '10px 0', minWidth: 0, fontSize: '12px', textTransform: 'uppercase' }}
                    onClick={() => { setScanTab('all'); setScanPage(0); if (!isScanning && scanResults.length === 0) startScan('all'); }}
                  >
                    All Devices
                  </button>
                  <button 
                    className={`btn-styled ${scanTab === 'recents' ? '' : 'inactive'}`}
                    style={{ flex: 1, padding: '10px 0', minWidth: 0, fontSize: '12px', textTransform: 'uppercase' }}
                    onClick={() => { setScanTab('recents'); setScanPage(0); if (!isScanning && scanResults.length === 0) startScan('recents'); }}
                  >
                    Recents
                  </button>
                </div>

                {/* Search */}
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
                  <div className="input-field" style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, padding: '10px 14px' }}>
                    <Search size={14} style={{ opacity: 0.5, flexShrink: 0 }} />
                    <input
                      style={{ background: 'transparent', border: 'none', color: 'white', flex: 1, outline: 'none', width: '100%', fontSize: '12px' }}
                      placeholder={scanTab === 'recents' ? "Search recents..." : "Search for a device..."}
                      value={scanSearch}
                      onChange={(e) => { setScanSearch(e.target.value); setScanPage(0); }}
                    />
                  </div>
                  <button 
                    onClick={() => startScan(scanTab)} 
                    className="btn-styled" 
                    style={{ padding: '11px', minWidth: 'auto', flexShrink: 0, borderRadius: '14px' }}
                    title="Scan for nearby devices"
                  >
                    <RefreshCw size={14} className={isScanning ? "animate-spin text-violet-400" : ""} />
                  </button>
                </div>

                <div className="scan-popup-list">
                  {isScanning && scanTab === 'all' && (
                    <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', width: '100%', minHeight: 180 }}>
                      <RefreshCw size={28} className="animate-spin text-violet-400" />
                    </div>
                  )}

                  {!(isScanning && scanTab === 'all') && pagedDevices.length === 0 && (
                    <div className="flex flex-col items-center justify-center text-center" style={{ flex: 1, minHeight: 180 }}>
                      <p className="text-slate-500 text-sm font-semibold">
                        {scanTab === 'recents' ? 'No recent devices.' : 'No devices found nearby.'}
                      </p>
                      {scanTab === 'all' && (
                        <p className="text-slate-600 text-xs px-4" style={{ marginTop: '16px' }}>Make sure your sign is powered on, in range, and isn't already paired to your phone.</p>
                      )}
                    </div>
                  )}

                  {!(isScanning && scanTab === 'all') && pagedDevices.map(dev => {
                    let rawName = dev.adv_name || dev.name || 'Unknown Device';
                    
                    let sn = '';
                    if (rawName.startsWith('HELLO')) {
                      sn = 'YS' + rawName.substring(5);
                    } else if (rawName.includes('-')) {
                      sn = 'YS' + rawName.split('-')[1];
                    } else if (rawName.startsWith('YS')) {
                      sn = rawName;
                    }

                    const customName = deviceNames[dev.address?.toUpperCase()];
                    const defaultName = sn || dev.name || 'LED Sign';
                    const displayName = customName || defaultName;
                    
                    const isConnected = status.connected && status.address?.toLowerCase() === dev.address?.toLowerCase();
                    const isDiscovered = scanResults.some(r => r.address?.toLowerCase() === dev.address?.toLowerCase());
                    const isAvailable = isConnected || isDiscovered;
                    
                    return (
                      <div 
                        key={dev.address} 
                        className="scan-item"
                        style={!isAvailable ? {
                          opacity: 0.55,
                          filter: 'grayscale(100%)',
                          cursor: 'pointer'
                        } : {
                          cursor: 'pointer'
                        }}
                        onClick={() => {
                          pickDevice(dev.address, rawName);
                        }}
                      >
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <p className="font-bold text-sm text-slate-100" style={!isAvailable ? { color: '#94a3b8' } : {}}>
                              {displayName}
                            </p>
                            {isConnected ? (
                              <span style={{ fontSize: '10px', padding: '1px 7px', borderRadius: '999px', background: 'rgba(34,197,94,0.15)', color: '#4ade80', border: '1px solid rgba(34,197,94,0.3)', fontWeight: 600 }}>
                                Connected
                              </span>
                            ) : isAvailable ? (
                              <span style={{ fontSize: '10px', padding: '1px 7px', borderRadius: '999px', background: 'rgba(56,189,248,0.15)', color: '#38bdf8', border: '1px solid rgba(56,189,248,0.3)', fontWeight: 600 }}>
                                Available
                              </span>
                            ) : (
                              <span style={{ fontSize: '10px', padding: '1px 7px', borderRadius: '999px', background: 'rgba(255,255,255,0.06)', color: '#94a3b8', border: '1px solid rgba(255,255,255,0.1)', fontWeight: 600 }}>
                                Offline
                              </span>
                            )}
                          </div>
                          <p className="text-xs font-mono text-slate-500" style={!isAvailable ? { color: '#64748b' } : {}}>
                            {dev.address}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          {scanTab === 'recents' && (
                            <button 
                              style={{ 
                                background: 'transparent', border: 'none', cursor: 'pointer',
                                color: 'rgba(148,163,184,0.5)', padding: '4px 6px', borderRadius: '8px',
                                display: 'flex', alignItems: 'center', transition: 'color 0.15s'
                              }}
                              onMouseOver={e => e.currentTarget.style.color = '#f87171'}
                              onMouseOut={e => e.currentTarget.style.color = 'rgba(148,163,184,0.5)'}
                              onClick={(e) => { e.stopPropagation(); removeRecent(dev.address); }}
                              title="Remove from recents"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 12, marginTop: 4, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                    <button
                      className="btn-styled inactive"
                      style={{ padding: '6px 10px', background: 'rgba(255,255,255,0.05)', flexShrink: 0 }}
                      onClick={() => setScanPage(p => Math.max(0, p - 1))}
                      disabled={scanPage === 0}
                    >
                      <ChevronLeft size={13} />
                    </button>
                    <span className="text-xs font-bold text-slate-400" style={{ whiteSpace: 'nowrap' }}>{scanPage + 1} / {totalPages}</span>
                    <button
                      className="btn-styled inactive"
                      style={{ padding: '6px 10px', background: 'rgba(255,255,255,0.05)', flexShrink: 0 }}
                      onClick={() => setScanPage(p => Math.min(totalPages - 1, p + 1))}
                      disabled={scanPage >= totalPages - 1}
                    >
                      <ChevronRight size={13} />
                    </button>
                  </div>
                )}
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>

      {/* Presets: one shared header, with Saved and Local views. */}
      {(
        <div className="flex flex-col items-center pt-16 w-full" style={{ borderTop: '1px solid rgba(255,255,255,0.05)', marginTop: '24px' }}>
          <div
            style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%', maxWidth: 1100, marginBottom: 4 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <ImageIcon className="text-emerald-400 shrink-0" size={24} />
              <h3 className="text-2xl font-black" style={{ margin: 0 }}>Presets</h3>
              {pushMessage && (
                <div
                  role="status"
                  className="text-xs font-bold"
                  style={{
                    color: isAssignmentReminder || pushMessage.startsWith('Error') ? '#f87171' : (/^(Saved|Pushed|Assigned|Deleted)\b/.test(pushMessage) ? '#34d399' : '#38bdf8'),
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    marginLeft: 16, flex: '0 0 auto', whiteSpace: 'nowrap'
                  }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                  }}
                >
                  {pushing && !isAssignmentReminder && !pushMessage.startsWith('Error') && <RefreshCw size={12} className="animate-spin" aria-label="Saving" />}
                  {!pushing && /^(Saved|Pushed|Assigned|Deleted)\b/.test(pushMessage) && <Check size={12} className="text-emerald-400" />}
                  <span>{pushMessage}</span>
                  {pushing && slotSaveProgress !== null && (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: '0 0 auto' }}>
                      <div
                        aria-label={`Slot save progress: ${slotSaveProgress}%`}
                        style={{ width: 72, height: 6, borderRadius: 999, background: 'rgba(255,255,255,0.25)', overflow: 'hidden' }}
                      >
                        <span style={{ display: 'block', width: `${slotSaveProgress}%`, height: '100%', background: '#38bdf8', borderRadius: 'inherit', transition: 'width 0.2s ease' }} />
                      </div>
                      <span>{slotSaveProgress}% {slotSavePhase}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div role="tablist" aria-label="Preset source" onPointerDown={(e) => e.stopPropagation()} style={{ display: 'inline-flex', gap: 4, padding: 3, borderRadius: 12, background: 'rgba(255,255,255,0.05)' }}>
              <button
                role="tab"
                aria-selected={presetView === 'saved'}
                disabled={!status.connected}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => status.connected && setPresetView('saved')}
                className={`btn-styled ${presetView === 'saved' && status.connected ? '' : 'inactive'}`}
                style={{ height: 34, padding: '0 14px', fontSize: 14, opacity: status.connected ? 1 : 0.4, cursor: status.connected ? 'pointer' : 'not-allowed' }}
                title={status.connected ? 'View saved sign presets' : 'Connect to a sign to view saved presets'}
              >Saved</button>
              <button
                role="tab"
                aria-selected={presetView === 'local'}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setPresetView('local')}
                className={`btn-styled ${presetView === 'local' ? '' : 'inactive'}`}
                style={{ height: 34, padding: '0 14px', fontSize: 14 }}
              >Local</button>
            </div>
          </div>
          

          {presetView === 'saved' && status.connected && (
            <div className="glass-panel p-10 w-full" style={{ maxWidth: 1100 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '24px', width: '100%' }}>
                {savedPresets.slice(savedPage * slotsPerPage, (savedPage + 1) * slotsPerPage).map((slot, localIdx) => {
                  const globalIdx = savedPage * slotsPerPage + localIdx;
                  const p = slot.preset;

                  // Slots 0 and 1 are reserved (Calendar and Default respectively)
                  const isReservedCalendar = globalIdx === 0;
                  const isReservedDefault = globalIdx === 1;
                  const isReserved = isReservedCalendar || isReservedDefault;
                  const reservedColor = isReservedCalendar ? '#38bdf8' : '#facc15';

                  if (!p) {
                    return (
                      <div
                        key={slot.hwSlotId !== undefined ? `hw-${slot.hwSlotId}` : `slot-${slot.slotNumber || globalIdx}`}
                        onDragOver={!isReserved ? (e) => { e.preventDefault(); setSavedDragOverIdx(globalIdx); } : undefined}
                        onDragLeave={!isReserved ? () => setSavedDragOverIdx(null) : undefined}
                        onDrop={!isReserved ? (e) => handleDropOnSlot(e, globalIdx) : undefined}
                        onPointerDown={handlePointerDown}
                        onPointerUp={(e) => handlePointerUp(e, () => playSavedPreset(globalIdx, null))}
                        className="preset-card empty-slot relative transition-all cursor-pointer"
                        style={{
                          border: globalIdx === savedDragOverIdx ? '2px dashed var(--accent-primary)' : (isReserved ? `1px solid ${reservedColor}22` : undefined),
                          boxShadow: globalIdx === savedDragOverIdx ? 'var(--neon-shadow)' : undefined,
                          opacity: isReserved ? 0.7 : 1,
                        }}
                      >
                        {isReserved ? (
                          <>
                            <div style={{ fontSize: 22, marginBottom: 4, display: 'flex', justifyContent: 'center' }}>
                              {isReservedCalendar ? '📅' : <Star size={22} fill="#facc15" color="#facc15" />}
                            </div>
                            <p style={{ fontSize: '10px', fontWeight: 900, color: reservedColor, textTransform: 'uppercase', letterSpacing: '0.08em', margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                              {isReservedCalendar ? '📅 Calendar' : (
                                <>
                                  <Star size={10} fill="#facc15" color="#facc15" /> Default
                                </>
                              )}
                            </p>
                            <p style={{ fontSize: '9px', color: 'rgba(255,255,255,0.25)', marginTop: 4, textAlign: 'center' }}>
                              {isReservedCalendar ? 'Auto-updated by calendar' : 'Set via "Use as Default"'}
                            </p>
                          </>
                        ) : (
                          <>
                            <Plus size={20} className="text-slate-600 mb-1" />
                            <p style={{ fontSize: '10px', fontWeight: 900, color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: 0 }}>
                              Empty
                            </p>
                          </>
                        )}
                        {!isReserved && (
                          <div className="preset-card-overlay flex gap-2">
                            <button
                              onPointerDown={(e) => e.stopPropagation()}
                              onPointerUp={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                setAssigningSlotIndex(globalIdx);
                              }}
                              className="btn-styled preset-card-edit-btn"
                              title="Assign Preset"
                            >
                              <Plus size={14} className="mr-2" /> Assign
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  }

                  return (
                    <div
                      key={slot.hwSlotId !== undefined ? `hw-${slot.hwSlotId}` : `slot-${slot.slotNumber || globalIdx}`}
                      className="preset-card relative group overflow-hidden transition-all"
                      onPointerDown={handlePointerDown}
                      onPointerUp={(e) => handlePointerUp(e, () => playSavedPreset(globalIdx, p))}
                      draggable={!isReserved}
                      onDragStart={!isReserved ? (e) => {
                        e.dataTransfer.setData('text/plain', `saved-slot:${globalIdx}`);
                        e.dataTransfer.effectAllowed = 'move';
                        setSavedDraggedIdx(globalIdx);
                      } : undefined}
                      onDragEnd={!isReserved ? () => {
                        setSavedDraggedIdx(null);
                        setSavedDragOverIdx(null);
                      } : undefined}
                      onDragOver={!isReserved ? (e) => { e.preventDefault(); setSavedDragOverIdx(globalIdx); } : undefined}
                      onDragLeave={!isReserved ? () => setSavedDragOverIdx(null) : undefined}
                      onDrop={!isReserved ? (e) => handleDropOnSlot(e, globalIdx) : undefined}
                      style={{
                        cursor: isReserved ? 'pointer' : 'grab',
                        opacity: globalIdx === savedDraggedIdx ? 0.4 : 1,
                        transform: globalIdx === savedDraggedIdx ? 'scale(0.98)' : 'none',
                        border: globalIdx === savedDragOverIdx ? '2px dashed var(--accent-primary)' : (isReserved ? `1px solid ${reservedColor}44` : undefined),
                        boxShadow: globalIdx === savedDragOverIdx ? 'var(--neon-shadow)' : (isReserved ? `0 0 12px ${reservedColor}22` : undefined),
                        userSelect: 'none'
                      }}
                    >
                      {isReserved && (
                        <div
                          className="preset-card-badge"
                          style={isReservedCalendar ? {
                            background: 'rgba(56,189,248,0.15)',
                            color: '#38bdf8',
                            border: '1px solid rgba(56,189,248,0.25)'
                          } : undefined}
                        >
                          {isReservedCalendar ? (
                            <>
                              <span>📅</span> Calendar
                            </>
                          ) : (
                            <>
                              <Star size={10} fill="#facc15" color="#facc15" />
                              Default
                            </>
                          )}
                        </div>
                      )}
                      <PresetCardMedia preset={p} now={now} />

                      <div 
                        className="preset-card-overlay flex gap-2" 
                        onPointerDown={handlePointerDown}
                        onPointerUp={(e) => {
                          e.stopPropagation();
                          handlePointerUp(e, () => playSavedPreset(globalIdx, p));
                        }}
                      >
                        {!isReserved && (
                          <button
                            onPointerDown={(e) => e.stopPropagation()}
                            onPointerUp={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              setAssigningSlotIndex(globalIdx);
                            }}
                            className="btn-styled preset-card-edit-btn"
                            title="Update Preset"
                          >
                            <RefreshCw size={14} className="mr-2" /> Update
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Assign Preset Modal */}
          {assigningSlotIndex !== null && createPortal(
            <AnimatePresence>
              <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
                <motion.div 
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)' }}
                  onClick={() => setAssigningSlotIndex(null)}
                />
                <motion.div 
                  initial={{ scale: 0.9, opacity: 0, y: 20 }}
                  animate={{ scale: 1, opacity: 1, y: 0 }}
                  exit={{ scale: 0.9, opacity: 0, y: 20 }}
                  className="relative glass-panel"
                  style={{ position: 'relative', padding: '32px', width: '100%', maxWidth: '640px', overflowY: 'auto', maxHeight: '90vh' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px', flexWrap: 'nowrap' }}>
                    <h3 style={{ fontSize: '20px', fontWeight: 900, margin: 0, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {assigningSlotIndex === 0 ? '📅 Calendar Slot (Reserved)' :
                       assigningSlotIndex === 1 ? '⭐ Default Slot (Reserved)' :
                       `Assign Local Preset to Slot ${savedPresets[assigningSlotIndex]?.slotNumber}`}
                    </h3>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0, flexWrap: 'nowrap' }}>
                      {savedPresets[assigningSlotIndex]?.preset && assigningSlotIndex >= 2 && (
                        <button
                          onClick={async () => {
                            const slotObj = savedPresets[assigningSlotIndex];
                            const hwSlotId = slotObj?.preset?.hwSlotId !== undefined 
                              ? slotObj.preset.hwSlotId 
                              : (slotObj?.hwSlotId !== undefined ? slotObj.hwSlotId : assigningSlotIndex);

                            if (hwSlotId < 12) {
                              try {
                                const wasActive = (lastPushedId === `hw-slot-${hwSlotId}`) || (status?.display_mode === `preset-${hwSlotId}`);
                                setPushing(true);
                                setPushMessage(`Clearing slot ${assigningSlotIndex + 1}...`);
                                await axios.delete(`${API_BASE}/delete-preset/${hwSlotId}?mac=${encodeURIComponent(status.address || DEFAULT_MAC)}&was_active=${wasActive}`);
                                setPushMessage(`Cleared slot ${assigningSlotIndex + 1}!`);
                                
                                const nextSaved = [...savedPresets];
                                nextSaved[assigningSlotIndex] = { ...nextSaved[assigningSlotIndex], preset: null };
                                setSavedPresets(nextSaved);
                                if (typeof syncHardwareSlots === 'function') {
                                  await syncHardwareSlots();
                                }
                                if (lastPushedId === `hw-slot-${hwSlotId}`) {
                                  if (typeof setLastPushedId === 'function') setLastPushedId('hw-slot-1');
                                }
                                if (typeof fetchStatus === 'function') fetchStatus();
                                setAssigningSlotIndex(null);
                              } catch (err) {
                                console.error('Failed to delete hardware preset:', err);
                                setPushMessage(`Error: ${err.message}`);
                              } finally {
                                setPushing(false);
                              }
                            }
                          }}
                          className="btn-disconnect flex items-center"
                          style={{
                            padding: '4px 12px',
                            fontSize: '12px',
                            height: '32px',
                            background: 'rgba(239, 68, 68, 0.1)',
                            border: '1px solid rgba(239, 68, 68, 0.2)',
                            color: '#ef4444',
                            whiteSpace: 'nowrap'
                          }}
                          title="Clear Slot"
                        >
                          <Trash2 size={14} className="mr-1" /> Clear Slot
                        </button>
                      )}
                      <button onClick={() => setAssigningSlotIndex(null)} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onMouseOver={e => e.currentTarget.style.color='#fff'} onMouseOut={e => e.currentTarget.style.color='#64748b'}><X size={24} /></button>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '24px' }}>
                    {presets?.filter(p => {
                      if (!p?.id) return false;
                      // Dynamic event titles with ||| shouldn't be assigned
                      if (p.text?.includes('|||')) {
                        return false;
                      }
                      return true;
                    })?.map(p => {
                      const isClock = p.mode === 'clock' || p.id === 'clock-default';
                      return (
                        <div 
                          key={p.id}
                          className="preset-card relative overflow-hidden border border-white/5 hover:border-emerald-500/30 transition-all"
                          onClick={() => {
                            console.log('[AssignModal] Clicked preset card:', p.id, p.name);
                            assignPresetToSlot(assigningSlotIndex, p);
                            setAssigningSlotIndex(null);
                          }}
                        >
                          <PresetCardMedia preset={p} now={now} />
                        </div>
                      );
                    })}
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button className="btn-disconnect" onClick={() => setAssigningSlotIndex(null)}>
                      Cancel
                    </button>
                  </div>
                </motion.div>
              </div>
            </AnimatePresence>,
            document.body
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Calendar ───────────────────────────────────────────────────────── */
function CalendarView({ status, events, loading, fetchEvents, now, onPush, pushMessage, pushing, cleanName, setCleanName }) {
  const [calError, setCalError] = useState('');

  useEffect(() => {
    // Clear error if we successfully fetched events
    if (status.calendar_connected && events?.length > 0) {
      setCalError('');
    }
  }, [status.calendar_connected, events]);


  const handleSignIn = async () => {
    try {
      const res = await axios.get(`${API_BASE}/auth/url`);
      window.open(res.data.url, '_blank');
    } catch (e) {
      setCalError(e.response?.data?.detail || e.message);
    }
  };



  return (
    <div className="flex flex-col items-center py-12 w-full" style={{ maxWidth: 860, margin: '0 auto' }}>
      {/* Header: icon + title + sync button all on one line */}
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', width: '100%', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
          <Calendar className="text-blue-400" size={24} style={{ flexShrink: 0 }} />
          <h3 className="text-2xl font-black" style={{ margin: 0, whiteSpace: 'nowrap' }}>Today's Schedule</h3>
          {status.calendar_connected && (
            <>
              <button onClick={fetchEvents} className="btn-styled inactive" style={{ padding: '6px 10px', marginLeft: 4 }} disabled={loading} title="Refresh">
                <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
              </button>
              <button onClick={async () => { await axios.post(`${API_BASE}/auth/logout`); window.location.reload(); }} className="btn-styled inactive" style={{ padding: '6px 12px', fontSize: 12, marginLeft: 'auto' }}>
                Sign out
              </button>
            </>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginBottom: '32px' }}>
        <p className="text-slate-400 text-sm">
          {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
        </p>
        {status.calendar_connected && (
          <div 
            style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}
            onClick={() => {
              const val = !cleanName;
              setCleanName(val);
              localStorage.setItem('loy_clean_name', val.toString());
              setTimeout(() => fetchEvents(), 0);
            }}
          >
            <div style={{
              width: '18px', height: '18px', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: cleanName ? 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))' : 'rgba(255,255,255,0.05)',
              border: cleanName ? 'none' : '1px solid rgba(255,255,255,0.2)'
            }}>
              {cleanName && <Check size={14} color="white" strokeWidth={3} />}
            </div>
            <span style={{ fontSize: '14px', color: '#cbd5e1', userSelect: 'none' }}>
              Remove my name from event titles
            </span>
          </div>
        )}
      </div>

      {calError && (
        <div className={`flex items-center gap-3 text-sm mb-6 w-full px-5 py-3 rounded-2xl bg-amber-400/10 text-amber-300`}>
          <AlertCircle size={14} />{calError}
        </div>
      )}

      {!status.calendar_connected ? (
        <div className="glass-panel w-full" style={{ padding: '48px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
          <p className="text-slate-400" style={{ marginBottom: '24px' }}>Sign in with Google to see today's meetings.</p>
          <button 
            onClick={handleSignIn}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px',
              backgroundColor: '#f2f2f2',
              color: '#1f1f1f',
              padding: '10px 24px',
              borderRadius: '24px',
              fontSize: '16px',
              fontWeight: '500',
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'Roboto, Arial, sans-serif',
              boxShadow: '0 1px 2px 0 rgba(0,0,0,0.1)'
            }}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Sign in with Google
          </button>
        </div>
      ) : events?.length === 0 ? (
        <div className="glass-panel w-full p-12 text-center">
          <p className="text-slate-500">No events scheduled for today.</p>
        </div>
      ) : (
        <div className="w-full grid grid-cols-1 gap-4">
          {events?.map((ev, i) => (
            <EventCard
              key={i}
              ev={ev}
              now={now}
              onPush={onPush}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function formatEventTime(ev) {
  if (!ev || !ev.start_iso || !ev.end_iso) return ev?.time || '';
  try {
    const sDate = new Date(ev.start_iso);
    const eDate = new Date(ev.end_iso);
    if (isNaN(sDate.getTime()) || isNaN(eDate.getTime())) return ev.time || '';

    const fmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
    return `${fmt.format(sDate)} - ${fmt.format(eDate)}`;
  } catch (err) {
    console.warn("[calendar] Failed to format time:", err);
    return ev.time || '';
  }
}

function EventCard({ ev, now, onPush }) {
  const timeStr = formatEventTime(ev);
  const summary = ev?.summary || 'Untitled Event';
  const isDeclined = ev?.response_status?.toLowerCase() === 'declined' || summary.toLowerCase().includes('[declined]');
  const isActive = isEventActive(ev, now);

  const handleCardClick = (e) => {
    // If the click was on the link (title/time), don't push
    if (e.target.closest('a')) return;
    const displayStr = getEventDisplayString(ev);
    onPush(displayStr, true);
  };

  return (
    <div
      className="glass-panel transition-all group"
      onClick={handleCardClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '14px 20px',
        cursor: 'pointer',
        opacity: isDeclined ? 0.5 : 1,
        filter: isDeclined ? 'grayscale(0.8)' : 'none',
        position: 'relative',
        ...(isActive && !isDeclined ? {
          background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
          borderColor: 'transparent',
          boxShadow: 'var(--neon-shadow)',
        } : {})
      }}
    >
      {isActive && (
        <div style={{ width: 4, height: 40, borderRadius: 4, flexShrink: 0, background: 'rgba(255,255,255,0.4)' }} />
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <p 
          style={{ fontWeight: 800, fontSize: 18, color: isActive ? '#ffffff' : '#cbd5e1', margin: 0, whiteSpace: 'normal', letterSpacing: '-0.02em', width: 'fit-content' }} 
          className="hover:underline"
        >
          {ev.html_link || ev.id ? (
            <a 
              href={ev.html_link || `https://calendar.google.com/calendar/r/event/${ev.id}`} 
              target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}
              onClick={(e) => e.stopPropagation()}
            >
              {summary}
            </a>
          ) : summary}
        </p>
        <p 
          style={{ fontSize: 14, fontWeight: 600, color: isActive ? 'rgba(255,255,255,0.9)' : '#64748b', margin: '2px 0 0 0', width: 'fit-content' }} 
          className="hover:underline"
        >
          {ev.html_link || ev.id ? (
            <a 
              href={ev.html_link || `https://calendar.google.com/calendar/r/event/${ev.id}`} 
              target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}
              onClick={(e) => e.stopPropagation()}
            >
              {timeStr}
            </a>
          ) : timeStr}
        </p>
      </div>

      {isActive && ev.response_status?.toLowerCase() !== 'declined' && (
        <div className="flex items-center gap-3">
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, background: 'rgba(255,255,255,0.2)', color: '#ffffff', padding: '4px 10px', borderRadius: 99, flexShrink: 0 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ffffff', animation: 'pulse 2s infinite' }} />
            Now
          </span>
        </div>
      )}
    </div>
  );
}

function hslToHex(h, s, l) {
  l /= 100;
  const a = s * Math.min(l, 1 - l) / 100;
  const f = n => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function rgbToHex(r, g, b) {
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

function hexToHsl(hex) {
  const shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
  const fullHex = hex.replace(shorthandRegex, (m, r, g, b) => r + r + g + g + b + b);
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(fullHex);
  if (!result) return { h: 0, s: 0, l: 0 };
  
  let r = parseInt(result[1], 16) / 255;
  let g = parseInt(result[2], 16) / 255;
  let b = parseInt(result[3], 16) / 255;
  
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

function HslColorSlider({ label, value, onChange }) {
  const [localHex, setLocalHex] = useState(value);
  const colorInputRef = useRef(null);

  useEffect(() => {
    setLocalHex(value);
  }, [value]);

  const pct = (() => {
    if (!value) return 0;
    const hex = value.toLowerCase();
    if (hex === '#000000' || hex === 'black') return 0.975;
    if (hex === '#ffffff' || hex === 'white') return 0.925;

    const hsl = hexToHsl(value);
    if (hsl.l < 5) return 0.975;
    if (hsl.l > 95 || hsl.s < 8) return 0.925;
    return Math.min(0.90, (Math.min(300, hsl.h) / 300) * 0.90);
  })();

  const isValidHex = (hex) => {
    return /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex);
  };

  const normalizeHex = (hex) => {
    if (hex.startsWith('#')) return hex;
    return '#' + hex;
  };

  const handleHexChange = (e) => {
    const val = e.target.value;
    setLocalHex(val);
    if (isValidHex(val)) {
      onChange(normalizeHex(val));
    }
  };

  const handleHexBlur = () => {
    if (!isValidHex(localHex)) {
      setLocalHex(value);
    } else {
      setLocalHex(normalizeHex(localHex));
    }
  };

  const safeColorValue = (() => {
    if (!value) return '#000000';
    if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
    if (/^#[0-9a-fA-F]{3}$/.test(value)) {
      const r = value[1];
      const g = value[2];
      const b = value[3];
      return `#${r}${r}${g}${g}${b}${b}`;
    }
    if (value === 'black') return '#000000';
    if (value === 'white') return '#ffffff';
    return '#000000';
  })();

  const handlePickColor = async () => {
    if (window.EyeDropper) {
      try {
        const eyeDropper = new window.EyeDropper();
        const result = await eyeDropper.open();
        if (result && result.sRGBHex) {
          onChange(result.sRGBHex);
        }
      } catch (err) {
        console.log('EyeDropper closed or failed, falling back to input color', err);
        colorInputRef.current?.click();
      }
    } else {
      colorInputRef.current?.click();
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '12px', flexWrap: 'nowrap', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '10px', fontWeight: 'bold', color: '#64748b', textTransform: 'uppercase', whiteSpace: 'nowrap', marginLeft: '4px' }}>{label}</span>
        
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
          <input 
            type="text"
            value={localHex}
            onChange={handleHexChange}
            onBlur={handleHexBlur}
            className="input-field"
            placeholder="#ffffff"
            style={{ 
              width: '80px', 
              height: '24px', 
              padding: '0 6px', 
              fontSize: '11px', 
              borderRadius: '6px', 
              letterSpacing: '0.02em',
              textTransform: 'uppercase',
              textAlign: 'center',
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
              fontFamily: 'monospace'
            }}
          />
          <button
            type="button"
            onClick={handlePickColor}
            title="Pick color from screen"
            style={{
              width: '24px',
              height: '24px',
              borderRadius: '6px',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              color: '#94a3b8',
              flexShrink: 0
            }}
            onMouseOver={e => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)';
              e.currentTarget.style.color = '#ffffff';
            }}
            onMouseOut={e => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
              e.currentTarget.style.color = '#94a3b8';
            }}
          >
            <Pipette size={12} />
          </button>
          <div 
            onClick={() => colorInputRef.current?.click()}
            style={{
              width: '32px',
              height: '18px',
              borderRadius: '99px',
              background: value,
              boxShadow: `0 0 8px ${value}`,
              border: '2px solid rgba(255,255,255,0.2)',
              transition: 'background-color 0.2s, box-shadow 0.2s',
              flexShrink: 0,
              cursor: 'pointer'
            }}
            title="Click to open color selector"
          />
        </div>
      </div>

      <div style={{ position: 'relative', width: '100%', height: '28px' }}>
        <div 
          style={{ 
            width: '100%', 
            height: '28px', 
            borderRadius: '99px', 
            background: 'linear-gradient(to right, hsl(0,100%,50%), hsl(60,100%,50%) 18%, hsl(120,100%,50%) 36%, hsl(180,100%,50%) 54%, hsl(240,100%,50%) 72%, hsl(300,100%,50%) 90%, #ffffff 90%, #ffffff 95%, #000000 95%, #000000 100%)', 
            cursor: 'pointer',
            border: 'none',
            boxShadow: 'none',
            overflow: 'hidden'
          }}
          onMouseDown={(e) => {
            const bar = e.currentTarget;
            const handleMove = (moveEvent) => {
              const rect = bar.getBoundingClientRect();
              let x = moveEvent.clientX - rect.left;
              if (x < 0) x = 0;
              if (x > rect.width) x = rect.width;
              const newPct = x / rect.width;
              const newColor = getColorAtPercent(newPct);
              onChange(newColor);
            };

            handleMove(e); // Trigger immediately on click

            const handleUp = () => {
              window.removeEventListener('mousemove', handleMove);
              window.removeEventListener('mouseup', handleUp);
            };

            window.addEventListener('mousemove', handleMove);
            window.addEventListener('mouseup', handleUp);
          }}
        />
        {/* Slider pointer indicator */}
        <div 
          style={{ 
            width: '20px', 
            height: '20px', 
            borderRadius: '50%', 
            border: '2px solid #ffffff', 
            background: value,
            position: 'absolute', 
            top: '4px', 
            left: `calc(${pct * 100}% - 10px)`, 
            boxShadow: '0 0 6px rgba(0,0,0,0.8), inset 0 1px 2px rgba(255,255,255,0.5)', 
            pointerEvents: 'none',
            transition: 'left 0.05s ease-out, background-color 0.1s'
          }} 
        />
      </div>

      <input 
        ref={colorInputRef}
        type="color"
        value={safeColorValue}
        onChange={(e) => onChange(e.target.value)}
        style={{ display: 'none' }}
      />
    </div>
  );
}

/* ─── Media ──────────────────────────────────────────────────────────── */
function MediaView({ status, isModalOpen, setIsModalOpen, presets, setPresets, onPush, onPushSuccess, now, pushMessage, setPushMessage, setLocalPushMessage, setUnifiedPushMessage, pushing, setPushing, savedPresets, setSavedPresets, syncHardwareSlots, setLastPushedId, presetView, setPresetView }) {
  const fontReady = useFontReady();
  const [draggedId, setDraggedId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);

  const dragStartPos = useRef({ x: 0, y: 0, time: 0 });
  const handlePointerDown = (e) => {
    dragStartPos.current = { 
      x: e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0), 
      y: e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : 0), 
      time: Date.now() 
    };
  };
  const handlePointerUp = (e, callback) => {
    if (!dragStartPos.current) {
      callback();
      return;
    }
    const clientX = e.clientX !== undefined ? e.clientX : (e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientX : 0);
    const clientY = e.clientY !== undefined ? e.clientY : (e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientY : 0);
    const dx = clientX - dragStartPos.current.x;
    const dy = clientY - dragStartPos.current.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const dt = Date.now() - dragStartPos.current.time;
    
    // Treat as click if they didn't move much, OR if it was a very fast click (< 500ms)
    if (distance < 15 || dt < 500) {
      callback();
    }
    dragStartPos.current = null;
  };

  const handleDragStart = (e, id) => {
    const preset = presets.find(p => p.id === id);
    if (preset && preset.isDefault) {
      e.preventDefault();
      return;
    }
    setDraggedId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id.toString());
    document.body.style.userSelect = 'none';
  };

  const handleDragOver = (e, id) => {
    e.preventDefault();
    if (id !== draggedId) {
      setDragOverId(id);
    }
  };

  const handleDrop = (e, targetId) => {
    e.preventDefault();
    if (!draggedId || draggedId === targetId) {
      setDraggedId(null);
      setDragOverId(null);
      return;
    }

    const sortedPresets = [...presets]
      .filter(p => p?.id)
      .sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));

    const draggedIndex = sortedPresets.findIndex(p => p.id === draggedId);
    const targetIndex = sortedPresets.findIndex(p => p.id === targetId);

    if (draggedIndex !== -1 && targetIndex !== -1) {
      const newPresets = [...sortedPresets];
      const [draggedItem] = newPresets.splice(draggedIndex, 1);
      newPresets.splice(targetIndex, 0, draggedItem);
      setPresets(newPresets);
    }

    setDraggedId(null);
    setDragOverId(null);
  };

  const handleDragEnd = () => {
    setDraggedId(null);
    setDragOverId(null);
    document.body.style.userSelect = '';
  };

  const imageObjRef = useRef(null);

  // Form State for Modal
  const [editingId, setEditingId] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveProgress, setSaveProgress] = useState(null);
  const processedMediaSignatureRef = useRef('');
  const [animDropdownOpen, setAnimDropdownOpen] = useState(false);
  const fileInputRef = useRef(null);
  const [showGrid, setShowGrid] = useState(true);
  const [showGuides, setShowGuides] = useState(true);
  const [form, setForm] = useState({
    name: '', 
    text: '', 
    textColor: '#ffffff', 
    bgColor: '#000000', 
    animation: 'continuous left shift', 
    speed: 8, 
    rotation: 0,
    mode: 'text', // 'text', 'drawing', or 'image'
    pixels: Array(64 * 20).fill(0),
    spacing: 1,
    views: 1,
    imgSrc: null,
    fileType: null,
    canvasX: 0,
    canvasY: 0,
    zoom: 1,
    dwBase: 64,
    dhBase: 20,
    timeFormat: '12h',
    showSeconds: true,
    clockStyle: 'default',
    isDefault: false
  });

  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(600);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const handleMediaFile = (file) => {
    if (!file) return;
    setSaveError('');

    // Tear down the previous source before loading the replacement. This is
    // especially important for GIFs: otherwise a decoded frame cache can keep
    // painting the old animation until the new one has finished decoding.
    imageObjRef.current = null;

    const isVideo = file.type.startsWith('video/') || file.name.toLowerCase().endsWith('.mp4') || file.name.toLowerCase().endsWith('.webm');
    const isGif = file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');
    const fileType = isVideo ? 'video' : (isGif ? 'gif' : 'image');

    if (fileType === 'video') {
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.src = url;
      video.onloadedmetadata = () => {
        imageObjRef.current = video;
        video.play().catch(err => console.log('Video play error:', err));
        initializeMediaCrop(video, url, 'video');
      };
      video.onerror = () => {
        setUnifiedPushMessage('Unsupported video format or corrupt file. Try converting to MP4/H.264.');
        setSaveError('Unsupported video format or corrupt file.');
      };
    } else {
      const reader = new FileReader();
      reader.onload = (re) => {
        const img = new Image();
        img.onload = () => {
          imageObjRef.current = img;
          initializeMediaCrop(img, re.target.result, fileType);
        };
        img.onerror = () => {
          setUnifiedPushMessage('Unsupported image format or corrupt file.');
          setSaveError('Unsupported image format or corrupt file.');
        };
        img.src = re.target.result;
      };
      reader.readAsDataURL(file);
    }
  };

  // A media file dropped anywhere over the preset editor becomes an image/video
  // preset, even if the user was editing text, drawing, or a clock.
  useEffect(() => {
    if (!isModalOpen) return;
    const acceptDrop = (event) => {
      if (!event.dataTransfer?.files?.length) return;
      event.preventDefault();
      const file = event.dataTransfer.files[0];
      setForm(prev => ({ ...prev, mode: 'image' }));
      setTimeout(() => handleMediaFile(file), 0);
    };
    const allowDrop = (event) => {
      if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', allowDrop);
    window.addEventListener('drop', acceptDrop);
    return () => {
      window.removeEventListener('dragover', allowDrop);
      window.removeEventListener('drop', acceptDrop);
    };
  }, [isModalOpen]);

  const handleMediaDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(true);
  };

  const handleMediaDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
  };

  const handleMediaDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleMediaFile(file);
    }
  };

  React.useLayoutEffect(() => {
    if (!containerRef.current) return;
    const updateWidth = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.clientWidth);
      }
    };
    updateWidth();
    window.addEventListener('resize', updateWidth);
    const timer = setTimeout(updateWidth, 100);
    return () => {
      window.removeEventListener('resize', updateWidth);
      clearTimeout(timer);
    };
  }, [isModalOpen, form.mode, form.imgSrc]);

  // React's delegated wheel handler can be passive in some browser paths.
  // Use a native non-passive listener so zooming the crop never scrolls the
  // page behind the editor.
  useEffect(() => {
    const container = containerRef.current;
    if (!isModalOpen || form.mode !== 'image' || !container) return;
    const preventPageScroll = (event) => {
      event.preventDefault();
    };
    container.addEventListener('wheel', preventPageScroll, { passive: false });
    return () => container.removeEventListener('wheel', preventPageScroll);
  }, [isModalOpen, form.mode, form.imgSrc]);

  const runCropRender = (img, x, y, w, h, bgColor = '#000000') => {
    if (!img) return Array(64 * 20).fill(0);
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 20;
    const ctx = canvas.getContext('2d');
    if (!ctx) return Array(64 * 20).fill(0);
    
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, 64, 20);
    ctx.drawImage(img, x, y, w, h);
    
    const data = ctx.getImageData(0, 0, 64, 20).data;
    const pixels = [];
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i+1];
      const b = data[i+2];
      
      // If pixel is extremely dark and background is black, treat as empty (0)
      if (bgColor === '#000000' && r < 16 && g < 16 && b < 16) {
        pixels.push(0);
      } else {
        // Round to nearest 16 to clean up image noise and optimize BLE color list size
        const roundedR = Math.min(255, Math.max(0, Math.round(r / 16) * 16));
        const roundedG = Math.min(255, Math.max(0, Math.round(g / 16) * 16));
        const roundedB = Math.min(255, Math.max(0, Math.round(b / 16) * 16));
        pixels.push(rgbToHex(roundedR, roundedG, roundedB));
      }
    }
    return pixels;
  };

  const initializeMediaCrop = (mediaEl, imgSrc, fileType) => {
    let dwBase = 64;
    let dhBase = 20;
    const canvasAspect = 64 / 20;
    const width = fileType === 'video' ? mediaEl.videoWidth : mediaEl.width;
    const height = fileType === 'video' ? mediaEl.videoHeight : mediaEl.height;
    const imgAspect = width / height;
    
    if (imgAspect > canvasAspect) {
      dhBase = 20;
      dwBase = 20 * imgAspect;
    } else {
      dwBase = 64;
      dhBase = 64 / imgAspect;
    }
    
    const canvasX = (64 - dwBase) / 2;
    const canvasY = (20 - dhBase) / 2;
    const zoom = 1.0;
    
    const pixels = runCropRender(mediaEl, canvasX, canvasY, dwBase * zoom, dhBase * zoom, form.bgColor || '#000000');
    
    setForm(prev => {
      if (prev.mode !== 'image') return prev;
      return {
        ...prev,
        imgSrc,
        fileType,
        canvasX,
        canvasY,
        zoom,
        dwBase,
        dhBase,
        pixels
      };
    });
  };

  // Clipboard paste support (CTRL + V) when in IMAGE/VIDEO tab
  useEffect(() => {
    if (!isModalOpen || form.mode !== 'image') return;

    const handlePaste = (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const file = items[i].getAsFile();
          if (file) {
            handleMediaFile(file);
            break;
          }
        }
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [isModalOpen, form.mode]);

  // Global arrow key support for cropping (no need to click to focus first)
  useEffect(() => {
    if (!isModalOpen || form.mode !== 'image' || !form.imgSrc) return;

    const handleKeyDown = (e) => {
      // Don't intercept if user is typing in an input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      
      const step = e.shiftKey ? 5 : 1;
      let newX = form.canvasX;
      let newY = form.canvasY;
      
      if (e.key === 'ArrowUp') newY -= step;
      else if (e.key === 'ArrowDown') newY += step;
      else if (e.key === 'ArrowLeft') newX -= step;
      else if (e.key === 'ArrowRight') newX += step;
      else return;

      e.preventDefault();
      
      let nextPixels = form.pixels;
      if (imageObjRef.current) {
        nextPixels = runCropRender(
          imageObjRef.current,
          newX,
          newY,
          (form.dwBase || 64) * (form.zoom || 1),
          (form.dhBase || 20) * (form.zoom || 1),
          form.bgColor || '#000000'
        );
      }
      
      setForm(prev => ({ ...prev, canvasX: newX, canvasY: newY, pixels: nextPixels }));
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isModalOpen, form.mode, form.imgSrc, form.canvasX, form.canvasY, form.dwBase, form.dhBase, form.zoom, form.bgColor, form.pixels]);

  useEffect(() => {
    if (isModalOpen && form.mode === 'image' && form.imgSrc) {
      if (!imageObjRef.current || imageObjRef.current.src !== form.imgSrc) {
        if (form.fileType === 'video') {
          const video = document.createElement('video');
          video.muted = true;
          video.loop = true;
          video.playsInline = true;
          video.src = form.imgSrc;
          video.onloadedmetadata = () => {
            imageObjRef.current = video;
            video.play().catch(err => console.log('Video play error:', err));
            if (form.canvasX === undefined || form.dwBase === undefined) {
              initializeMediaCrop(video, form.imgSrc, 'video');
            }
          };
          video.onerror = () => {
            setSaveError('Unsupported video format or corrupt file.');
          };
        } else {
          const img = new Image();
          img.onload = () => {
            imageObjRef.current = img;
            if (form.canvasX === undefined || form.dwBase === undefined) {
              initializeMediaCrop(img, form.imgSrc, form.fileType || 'image');
            }
          };
          img.src = form.imgSrc;
        }
      }
    } else if (!isModalOpen) {
      if (imageObjRef.current && typeof imageObjRef.current.pause === 'function') {
        imageObjRef.current.pause();
      }
      imageObjRef.current = null;
    }
  }, [isModalOpen, form.mode, form.imgSrc, form.canvasX, form.dwBase, form.fileType]);


  const [isEraserActive, setIsEraserActive] = useState(false);
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [previewTime, setPreviewTime] = useState(new Date());
  const [scrollOffset, setScrollOffset] = useState(0);

  const editingModeRef = useRef(null);

  // Reset eraser, undo/redo stacks, and editing mode ref on modal toggle
  useEffect(() => {
    setIsEraserActive(false);
    setUndoStack([]);
    setRedoStack([]);
    if (!isModalOpen) {
      editingModeRef.current = null;
    }
  }, [isModalOpen]);

  // The editor owns scroll while it is open; the document behind the overlay
  // must remain fixed.
  useEffect(() => {
    if (!isModalOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [isModalOpen]);

  // Keep previewTime updated when clock mode is active
  useEffect(() => {
    if (!isModalOpen || form.mode !== 'clock') return;
    setPreviewTime(new Date());
    
    let intervalId;
    const msToNextSecond = 1000 - new Date().getMilliseconds();
    const timeoutId = setTimeout(() => {
      setPreviewTime(new Date());
      intervalId = setInterval(() => {
        setPreviewTime(new Date());
      }, 1000);
    }, msToNextSecond);

    return () => {
      clearTimeout(timeoutId);
      if (intervalId) clearInterval(intervalId);
    };
  }, [isModalOpen, form.mode]);

  // Handle animation for scrolling text in preview
  useEffect(() => {
    const isAnim = Boolean(form.animation && form.animation !== 'show now' && form.animation !== 'static');
    if (!isModalOpen || form.mode !== 'text' || !isAnim) {
      setScrollOffset(0);
      return;
    }
    const interval = setInterval(() => {
      setScrollOffset(prev => prev + 1);
    }, Math.max(10, 80 - (form.speed !== undefined ? form.speed : 8) * 5)); // Higher speed = lower interval
    return () => clearInterval(interval);
  }, [isModalOpen, form.mode, form.animation, form.speed, form.text]);



  useEffect(() => {
    if (!isModalOpen) return;
    if (form.mode !== 'text' && form.mode !== 'clock') return;
    if (form.mode === 'text' && editingModeRef.current && editingModeRef.current !== 'text') return;
    if (form.mode === 'clock' && editingModeRef.current && editingModeRef.current !== 'clock') return;
    
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 20;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, 64, 20);
    ctx.fillStyle = 'white';

    let textToDraw = '';
    if (form.mode === 'text') {
      const textColor = form.textColor || '#ffffff';
      const bgColor = form.bgColor || '#000000';
      const animName = form.animation || 'show now';
      
      // Because renderTextAnimation now uses performance.now() globally for 3-phase and sweeps,
      // we can just call it and it will inherently stay in sync with the rest of the UI!
      // But for flicker, continuous left shift, etc, we pass the local scrollOffset.
      renderTextAnimation(ctx, form.text || '', animName, scrollOffset, textColor, bgColor);
      
    } else {
      const hours = previewTime.getHours();
      if (form.clockStyle === 'default') {
        drawDefaultClockCanvas(ctx, previewTime.getHours(), previewTime.getMinutes(), 'white', previewTime.getSeconds() % 2 === 0);
      } else {
        drawCustomTimeCanvas(ctx, hours, previewTime.getMinutes(), form.timeFormat, 'white', previewTime.getSeconds() % 2 === 0);
      }
      
      if (form.showSeconds !== false) {
        ctx.fillStyle = 'white';
        ctx.fillRect(2, 0, previewTime.getSeconds() + 1, 1);
      }
    }

    const data = ctx.getImageData(0, 0, 64, 20).data;
    const nextPixels = [];
    for (let i = 0; i < data.length; i += 4) {
      const brightness = (data[i] + data[i+1] + data[i+2]) / 3;
      nextPixels.push(brightness / 255);
    }
    
    setForm(prev => ({ ...prev, pixels: nextPixels }));
  }, [form.text, form.mode, form.timeFormat, form.showSeconds, isModalOpen, previewTime, scrollOffset, form.animation, form.clockStyle, fontReady]);

  // Re-render crop pixels dynamically when background color changes
  useEffect(() => {
    if (isModalOpen && form.mode === 'image' && form.imgSrc && imageObjRef.current) {
      const nextPixels = runCropRender(
        imageObjRef.current,
        form.canvasX,
        form.canvasY,
        form.dwBase * form.zoom,
        form.dhBase * form.zoom,
        form.bgColor || '#000000'
      );
      setForm(prev => ({ ...prev, pixels: nextPixels }));
    }
  }, [form.bgColor, isModalOpen, form.mode, form.imgSrc]);

  const getAnimationStitchedPixels = async () => {
    if (form.fileType !== 'video' && form.fileType !== 'gif') {
      let pixels = form.pixels;
      if ((!pixels || pixels.length === 0) && imageObjRef.current) {
        pixels = runCropRender(
          imageObjRef.current,
          form.canvasX,
          form.canvasY,
          form.dwBase * form.zoom,
          form.dhBase * form.zoom,
          form.bgColor || '#000000'
        );
      }
      return { pixels: pixels || form.pixels };
    }

    // Keep motion faithful to the uploaded video instead of reducing every
    // clip to eight snapshots. Gemini videos are commonly 24 fps, and this
    // cap still keeps long clips practical for browser memory and BLE storage.
    let numFrames = 8;
    const frames = [];

    if (form.fileType === 'video') {
      // Decoding locally in the server is substantially faster than seeking
      // through every frame in a browser video element.
      if (form.imgSrc) {
        const sourceResponse = await fetch(form.imgSrc);
        if (!sourceResponse.ok) throw new Error('Video source is unavailable. Please replace the media.');
        const sourceBlob = await sourceResponse.blob();
        const bytes = new Uint8Array(await sourceBlob.arrayBuffer());
        let binary = '';
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
        }
        setSaveProgress(10);
        const response = await processVideoMedia({
          videoB64: btoa(binary),
          canvasX: form.canvasX,
          canvasY: form.canvasY,
          zoom: form.zoom,
          dwBase: form.dwBase,
          dhBase: form.dhBase,
          bgColor: form.bgColor || '#000000'
        });
        if (!Array.isArray(response.data?.pixels) || !response.data.pixels.length) {
          throw new Error('Video processing returned no frames. Restart LED Sign and try again.');
        }
        setSaveProgress(85);
        return {
          imgSrc: `data:${sourceBlob.type || 'video/mp4'};base64,${btoa(binary)}`,
          pixels: response.data.pixels,
          frameDurationMs: response.data.frameDurationMs,
          frameDurationsMs: response.data.frameDurationsMs
        };
      }
      const video = imageObjRef.current;
      if (!video) return form.pixels;
      
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 2;
      const targetVideoFps = 24;
      const maxVideoFrames = 300;
      numFrames = Math.max(1, Math.ceil(duration * targetVideoFps));
      if (numFrames > maxVideoFrames) {
        throw new Error(`Video is too long (${numFrames} frames). Maximum supported is ${maxVideoFrames} frames.`);
      }
      setSaveProgress(0);
      const originalTime = video.currentTime;
      
      const wasPlaying = !video.paused;
      if (wasPlaying) video.pause();

      const seekVideo = (vid, time) => {
        return new Promise((resolve) => {
          const onSeeked = () => {
            vid.removeEventListener('seeked', onSeeked);
            resolve();
          };
          vid.addEventListener('seeked', onSeeked);
          vid.currentTime = time;
        });
      };

      for (let i = 0; i < numFrames; i++) {
        const seekTime = (duration / numFrames) * i;
        await seekVideo(video, seekTime);
        
        const framePixels = runCropRender(
          video,
          form.canvasX,
          form.canvasY,
          form.dwBase * form.zoom,
          form.dhBase * form.zoom,
          form.bgColor || '#000000'
        );
        frames.push(framePixels);
        // Reserve the final portion for packaging/saving the generated preset.
        setSaveProgress(Math.round(((i + 1) / numFrames) * 85));
      }

      video.currentTime = originalTime;
      if (wasPlaying) {
        video.play().catch(err => console.log('Video resume error:', err));
      }
    } else if (form.fileType === 'gif') {
      try {
        setSaveProgress(10);
        const response = await axios.post(`${API_BASE}/process-gif`, {
          imgSrc: form.imgSrc,
          canvasX: form.canvasX,
          canvasY: form.canvasY,
          zoom: form.zoom,
          dwBase: form.dwBase,
          dhBase: form.dhBase,
          bgColor: form.bgColor || '#000000'
        });
        // Return exact frame duration from GIF metadata for precise sign timing
        setSaveProgress(85);
        return { pixels: response.data.pixels, speed: response.data.speed, frameDurationMs: response.data.frameDurationMs, frameDurationsMs: response.data.frameDurationsMs };
      } catch (err) {
        console.error('GIF backend processing failed:', err);
        throw err;
      }
    }

    if (frames.length === 0) return { pixels: form.pixels };

    const finalPixels = [];
    for (let r = 0; r < 20; r++) {
      for (let f = 0; f < frames.length; f++) {
        for (let c = 0; c < 64; c++) {
          finalPixels.push(frames[f][r * 64 + c]);
        }
      }
    }
    // For video: frameDurationMs = actual time per extracted frame (preserves native video speed)
    const videoDuration = (imageObjRef.current && imageObjRef.current.duration) || 2;
    const videoFrameDurationMs = (videoDuration / numFrames) * 1000;
    return { pixels: finalPixels, frameDurationMs: videoFrameDurationMs };
  };

  const handleSave = async () => {
    if (isSaving || pushing) return;
    setSaveError('');
    const drawingHasContent = Array.isArray(form.pixels) && form.pixels.some(pixel => pixel && pixel !== 0);
    if (form.mode === 'image' && !form.imgSrc) {
      setUnifiedPushMessage('Add image or video media before saving.');
      return;
    }
    if (form.mode === 'text' && !(form.text || '').trim()) {
      setUnifiedPushMessage('Enter text before saving.');
      return;
    }
    if (form.mode === 'drawing' && !drawingHasContent) {
      setUnifiedPushMessage('Draw something before saving.');
      return;
    }
    setIsSaving(true);
    setPushing(true);
    setSaveProgress(0);
    try {
      let finalPixels = form.pixels;
      let finalImgSrc = form.imgSrc;
      if (form.mode === 'image') {
        const mediaSignature = JSON.stringify([form.imgSrc, form.fileType, form.canvasX, form.canvasY, form.zoom, form.dwBase, form.dhBase, form.bgColor]);
        const canReuseProcessedFrames = (form.fileType === 'gif' || form.fileType === 'video') &&
          processedMediaSignatureRef.current === mediaSignature && Array.isArray(form.pixels) && form.pixels.length > 1280;
        if (canReuseProcessedFrames) {
          setSaveProgress(85);
        } else {
          const res = await getAnimationStitchedPixels();
          if (res && res.pixels) {
            finalPixels = res.pixels;
            if (res.imgSrc) finalImgSrc = res.imgSrc;
            processedMediaSignatureRef.current = mediaSignature;
            if (res.speed !== undefined) {
              form.speed = res.speed;
            }
            if (res.frameDurationMs !== undefined) {
              form.frameDurationMs = res.frameDurationMs;
            }
            if (res.frameDurationsMs !== undefined) {
              form.frameDurationsMs = res.frameDurationsMs;
            }
          }
        }
      }
      setSaveProgress(90);
      
      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = 64;
      thumbCanvas.height = 20;
      const thumbCtx = thumbCanvas.getContext('2d');
      let thumbnail;
      
      if (form.mode === 'clock' || form.mode === 'text' || !finalPixels) {
        thumbnail = null;
      } else {
        const imageData = thumbCtx.createImageData(64, 20);
        const firstFramePixels = [];
        const numFrames = finalPixels.length / 1280;
        
        if (numFrames > 1) {
          const stitchedWidth = 64 * numFrames;
          for (let r = 0; r < 20; r++) {
            const startIdx = r * stitchedWidth;
            for (let c = 0; c < 64; c++) {
              firstFramePixels.push(finalPixels[startIdx + c]);
            }
          }
        } else {
          firstFramePixels.push(...finalPixels);
        }

        for (let i = 0; i < 1280; i++) {
          const p = firstFramePixels[i];
          const idx = i * 4;
          
          if (form.mode === 'drawing' || form.mode === 'image') {
            if (p && p !== 0) {
              const color = typeof p === 'string' && p.startsWith('#') ? p : (form.textColor || '#ffffff');
              const r = parseInt(color.slice(1, 3), 16) || 0;
              const g = parseInt(color.slice(3, 5), 16) || 0;
              const b = parseInt(color.slice(5, 7), 16) || 0;
              imageData.data[idx] = r;
              imageData.data[idx+1] = g;
              imageData.data[idx+2] = b;
              imageData.data[idx+3] = 255;
            } else {
              const bgCol = form.bgColor || '#000000';
              const r = parseInt(bgCol.slice(1, 3), 16) || 0;
              const g = parseInt(bgCol.slice(3, 5), 16) || 0;
              const b = parseInt(bgCol.slice(5, 7), 16) || 0;
              imageData.data[idx] = r;
              imageData.data[idx+1] = g;
              imageData.data[idx+2] = b;
              imageData.data[idx+3] = 255;
            }
          } else {
            const fgColor = form.textColor || (form.mode === 'clock' ? '#10B981' : '#ffffff');
            const bgColor = form.bgColor || '#000000';
            
            const fgR = parseInt(fgColor.slice(1, 3), 16) || 0;
            const fgG = parseInt(fgColor.slice(3, 5), 16) || 0;
            const fgB = parseInt(fgColor.slice(5, 7), 16) || 0;
            
            const bgR = parseInt(bgColor.slice(1, 3), 16) || 0;
            const bgG = parseInt(bgColor.slice(3, 5), 16) || 0;
            const bgB = parseInt(bgColor.slice(5, 7), 16) || 0;
            
            const r = Math.round(bgR + p * (fgR - bgR));
            const g = Math.round(bgG + p * (fgG - bgG));
            const b = Math.round(bgB + p * (fgB - bgB));
            
            imageData.data[idx] = r;
            imageData.data[idx+1] = g;
            imageData.data[idx+2] = b;
            imageData.data[idx+3] = 255;
          }
        }
        thumbCtx.putImageData(imageData, 0, 0);
        thumbnail = thumbCanvas.toDataURL();
      }

      const textVal = form.mode === 'text' ? normalizeForSign(form.text || '') : form.text;
      const presetData = { 
        ...form, 
        imgSrc: finalImgSrc,
        text: textVal,
        pixels: finalPixels,
        thumbnail,
        animation: form.mode === 'text' ? (form.animation || 'continuous left shift') : 'show now',
        name: form.mode === 'clock' ? 'Digital Clock' :
              form.mode === 'drawing' ? `Drawing ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 
              form.mode === 'image' ? (form.fileType === 'video' ? 'Custom Video' : form.fileType === 'gif' ? 'Custom GIF' : 'Custom Image') : (textVal || 'Untitled Text') 
      };

      let nextPresets = [...presets];
      if (form.isDefault) {
        nextPresets = nextPresets.map(p => ({ ...p, isDefault: false }));
      }

      const savedPreset = { ...presetData, id: editingId || Date.now() };
      if (editingId) {
        nextPresets = nextPresets.map(p => p.id === editingId ? savedPreset : p);
      } else {
        nextPresets = [...nextPresets, savedPreset];
      }
      // Close only once IndexedDB has committed, so quota or clone errors are
      // shown without losing the user's editor contents.
      await savePresetsToDB(nextPresets);
      setPresets(nextPresets);
      setSaveProgress(100);

      // Close the modal and reset form immediately so UI is snappy!
      setIsModalOpen(false);
      setAnimDropdownOpen(false);
      setEditingId(null);
      setForm({
        name: '', text: '', textColor: '#ffffff', bgColor: '#000000',
        animation: 'continuous left shift', speed: 8, rotation: 0,
        mode: 'text', pixels: Array(64 * 20).fill(0),
        imgSrc: null, fileType: null, canvasX: 0, canvasY: 0, zoom: 1, dwBase: 64, dhBase: 20,
        timeFormat: '12h',
        showSeconds: true,
        clockStyle: 'default',
        isDefault: false
      });

      // If marked as default, keep saved preset slot 2 in sync and push to hardware if connected
      if (form.isDefault) {
        const defaultPresetCopy = { ...presetData };
        if (defaultPresetCopy.mode === 'text') {
          delete defaultPresetCopy.pixels;
        }

        // Immediately sync slot 2 in savedPresets state
        setSavedPresets(prev => {
          const next = [...prev];
          next[1] = {
            slotNumber: 2,
            preset: { ...savedPreset, id: 'hw-slot-1', thumbnail: thumbnail || presetData.thumbnail }
          };
          return next;
        });

        if (status?.connected) {
          try {
            if (typeof setPresetView === 'function') setPresetView('saved');
            if (typeof setPushing === 'function') setPushing(true);
            if (typeof setPushMessage === 'function') setPushMessage('Saving default to Slot 2...');
            const saveRes = await savePresetToSign({
              slot_id: 1,
              address: status.address || DEFAULT_MAC,
              preset: defaultPresetCopy
            });
            console.log('[preset-save] Saved default preset to hardware slot 1');
            const savedThumb = saveRes.data?.preview_url 
              ? `${API_BASE}${saveRes.data.preview_url}?t=${Date.now()}` 
              : (thumbnail || presetData.thumbnail || null);
            if (typeof setPushMessage === 'function') setPushMessage('Saved to Slot 2!');
            setSavedPresets(prev => {
              const next = [...prev];
              next[1] = {
                slotNumber: 2,
                preset: { ...defaultPresetCopy, id: 'hw-slot-1', thumbnail: savedThumb }
              };
              return next;
            });
            if (typeof setLastPushedId === 'function') setLastPushedId('hw-slot-1');
            syncHardwareSlots();
          } catch (saveErr) {
            console.warn('[preset-save] Failed to save default to hw slot 1:', saveErr);
            if (typeof setPushMessage === 'function') setPushMessage('Error saving default to Slot 2');
          } finally {
            if (typeof setPushing === 'function') setPushing(false);
          }
        }
      }

      // Do not push saved preset automatically to the sign
    } catch (err) {
      console.error('Error saving preset:', err);
      setUnifiedPushMessage(`Error saving preset: ${err.response?.data?.detail || err.message || 'Unable to process media'}`);
      setSaveError(err.response?.data?.detail || err.message || 'Unable to process media');
    } finally {
      setIsSaving(false);
      setPushing(false);
      setSaveProgress(null);
    }
  };

  const drawingHasContent = Array.isArray(form.pixels) && form.pixels.some(pixel => pixel && pixel !== 0);
  const hasRequiredPresetContent =
    (form.mode === 'image' && Boolean(form.imgSrc)) ||
    (form.mode === 'text' && Boolean((form.text || '').trim())) ||
    (form.mode === 'drawing' && drawingHasContent) ||
    form.mode === 'clock';

  const exportOriginalMedia = () => {
    if (!form.imgSrc) return;
    const extension = form.fileType === 'gif' ? 'gif' : form.fileType === 'video' ? 'mp4' : 'png';
    const link = document.createElement('a');
    link.href = form.imgSrc;
    link.download = `${(form.name || 'led-sign-media').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'led-sign-media'}.${extension}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const startEdit = (p, e) => {
    setSaveError('');
    if (e) e.stopPropagation();
    editingModeRef.current = p.mode;
    setEditingId(p.id);
    
    let normalizedPixels = p.pixels || Array(64 * 20).fill(0);
    if (p.mode === 'drawing') {
      normalizedPixels = normalizedPixels.map(pixel => {
        if (pixel && pixel !== 0) {
          return (typeof pixel === 'string' && pixel.startsWith('#')) ? pixel : (p.textColor || '#ffffff');
        }
        return 0;
      });
    }
    
    const fileType = p.fileType || (p.name.includes('GIF') || (p.imgSrc && p.imgSrc.startsWith('data:image/gif')) ? 'gif' : (p.imgSrc ? 'image' : null));
    // Existing media pixels are already the rendered crop. Keep them unless
    // the user changes a crop setting or replaces the source.
    processedMediaSignatureRef.current = JSON.stringify([
      p.imgSrc, fileType, p.canvasX, p.canvasY, p.zoom, p.dwBase, p.dhBase, p.bgColor
    ]);
    setForm({ ...p, fileType, pixels: normalizedPixels, animation: p.animation || 'continuous left shift' });
    setIsModalOpen(true);
  };

  const deletePreset = (id, e) => {
    if (e) e.stopPropagation();
    setPresets(presets.filter(p => p.id !== (id || editingId)));
    if (!id) {
      setIsModalOpen(false);
      setAnimDropdownOpen(false);
      setEditingId(null);
    }
  };

  const canPushLocalPresetDirectly = (preset) => {
    if (!preset) return false;
    if (preset.mode === 'clock' || preset.id === 'clock-default') return true;
    if (preset.mode === 'drawing') return true;
    if (preset.mode === 'image') {
      return preset.fileType !== 'gif' && preset.fileType !== 'video';
    }
    return preset.mode === 'text' && (preset.animation || '').trim().toLowerCase() === 'show now';
  };

  const pushPreset = async (p) => {
    if (!canPushLocalPresetDirectly(p)) {
      if (typeof setLocalPushMessage === 'function') {
        setLocalPushMessage('Please assign animated text, GIFs, and videos to a Saved Preset before pushing.');
      }
      return;
    }

    if (p.isDefault && status?.connected) {
      try {
        if (typeof setPushing === 'function') setPushing(true);
        if (typeof setLocalPushMessage === 'function') {
          setLocalPushMessage(`Pushing "${p.name || 'Default'}" to sign...`);
        }
        if (typeof setLastPushedId === 'function') setLastPushedId('hw-slot-1');
        await axios.post(`${API_BASE}/preset?id=1&mac=${encodeURIComponent(status.address || DEFAULT_MAC)}`);
        if (typeof setLocalPushMessage === 'function') {
          setLocalPushMessage(`Pushed "${p.name || 'Default'}" to sign!`);
        }
        if (onPushSuccess) onPushSuccess();
      } catch (err) {
        console.error('Failed to trigger default hardware preset:', err);
        if (err.response?.status === 404) {
          // Hardware slot not yet saved for this sign — fall back to pushing local preset data directly
          console.log('[pushPreset] Hardware slot not found, falling back to local push');
          try {
            await onPush(p, true);
            if (onPushSuccess) onPushSuccess();
          } catch (e) {
            // handled in handlePush
          }
        } else {
          const detail = err.response?.data?.detail || err.message || '';
          if (typeof setLocalPushMessage === 'function') {
            setLocalPushMessage(`Error: ${detail}`);
          }
        }
      } finally {
        if (typeof setPushing === 'function') setPushing(false);
      }
      return;
    }

    try {
      await onPush(p, true);
      if (onPushSuccess) onPushSuccess();
    } catch (e) {
      // Errors are handled in handlePush globally
    }
  };

  return (
    <div className="flex flex-col items-center pb-12 w-full">
      {presetView === 'local' && (
        <div className="glass-panel p-10 w-full" style={{ maxWidth: 1100, marginTop: 0 }}>
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', 
            gap: '24px', 
            width: '100%' 
          }}>
            <div
              className="preset-card relative group overflow-hidden border-white/5 hover:border-emerald-500/30 transition-all flex flex-col items-center justify-center gap-2 bg-black"
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
              style={{
                cursor: 'pointer'
              }}
              onClick={() => {
                editingModeRef.current = 'text'; setEditingId(null); setForm({name: '', text: '', textColor: '#ffffff', bgColor: '#000000', animation: 'continuous left shift', speed: 8, rotation: 0, mode: 'text', pixels: Array(64 * 20).fill(0), spacing: 1, views: 1, imgSrc: null, canvasX: 0, canvasY: 0, zoom: 1, dwBase: 64, dhBase: 20, timeFormat: '12h', showSeconds: true, clockStyle: 'default', isDefault: false}); setIsModalOpen(true);
              }}
            >
              <Plus className="text-emerald-400" size={24} />
              <p className="text-xs font-black text-emerald-500/60 uppercase tracking-widest">New Preset</p>
            </div>

            {presets
              ?.filter(p => p?.id)
              ?.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0))
              ?.map(p => {
              const isClock = p.mode === 'clock' || p.id === 'clock-default';
              const canPushDirectly = canPushLocalPresetDirectly(p);
              return (
              <div 
                key={p.id} 
                className="preset-card relative group overflow-hidden transition-all"
                draggable={!p.isDefault}
                onDragStart={(e) => handleDragStart(e, p.id)}
                onDragOver={(e) => handleDragOver(e, p.id)}
                onDrop={(e) => handleDrop(e, p.id)}
                onDragEnd={handleDragEnd}
                style={{
                  cursor: p.isDefault ? 'default' : (canPushDirectly ? 'grab' : 'not-allowed'),
                  // Keep media previews true to their saved-preset colors. The
                  // direct-push restriction is communicated by the cursor and
                  // tooltip, not by dimming the artwork itself.
                  opacity: p.id === draggedId ? 0.4 : 1,
                  transform: p.id === draggedId ? 'scale(0.98)' : 'none',
                  border: p.id === dragOverId ? '2px dashed var(--accent-primary)' : (p.isDefault ? '1px solid #facc1544' : '1px solid var(--glass-border)'),
                  boxShadow: p.id === dragOverId ? 'var(--neon-shadow)' : (p.isDefault ? '0 0 12px #facc1522' : 'none'),
                  transition: 'all 0.15s ease',
                  userSelect: 'none'
                }}
                onPointerDown={handlePointerDown}
                onPointerUp={(e) => handlePointerUp(e, () => {
                  if (status?.connected) {
                    pushPreset(p);
                  } else {
                    setMsg('Error: Sign is not connected');
                  }
                })}
                title={canPushDirectly ? undefined : 'Please assign animated text, GIFs, and videos to a Saved Preset before pushing.'}
              >
                {p.isDefault && (
                  <div className="preset-card-badge">
                    <Star size={10} fill="#facc15" color="#facc15" />
                    Default
                  </div>
                )}
                <PresetCardMedia preset={p} now={now} />
                <div className="preset-card-overlay flex gap-2">
                  <button
                    onPointerDown={(e) => e.stopPropagation()}
                    onPointerUp={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); startEdit(p, e); }}
                    className="btn-styled preset-card-edit-btn"
                    title="Edit Preset"
                  >
                    <Pencil size={14} className="mr-2" /> Edit
                  </button>
                </div>
              </div>
              );
            })}
          </div>
        </div>
      )}

      {isModalOpen && createPortal(
        <AnimatePresence>
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)' }}
              onClick={() => { setIsModalOpen(false); setAnimDropdownOpen(false); }}
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className={`relative glass-panel ${isSaving ? 'media-processing-lock' : ''}`}
              style={{ position: 'relative', padding: '32px', width: '100%', maxWidth: '768px', overflowY: 'auto', maxHeight: '90vh' }}
            >
              {isSaving && (
                <div
                  aria-label="Media processing in progress"
                  onPointerDown={e => e.preventDefault()}
                  onWheel={e => e.preventDefault()}
                  style={{ position: 'absolute', inset: 0, zIndex: 20, background: 'transparent' }}
                />
              )}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
                <h3 style={{ fontSize: '24px', fontWeight: 900, margin: 0 }}>{editingId ? 'Edit Preset' : 'Create Preset'}</h3>
                <button onClick={() => { setIsModalOpen(false); setAnimDropdownOpen(false); }} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer' }} onMouseOver={e => e.currentTarget.style.color='#fff'} onMouseOut={e => e.currentTarget.style.color='#64748b'}><X size={24} /></button>
              </div>

              <div style={{ marginBottom: '32px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', width: '100%' }}>
                <div className="preview-stack opacity-100 scale-100" style={{ margin: '0 auto', width: '100%', maxWidth: 'var(--preview-width)' }}>
                  {form.mode === 'image' ? (
                    <>
                      <input 
                        type="file" 
                        ref={fileInputRef} 
                        id="img-upload" 
                        hidden 
                        accept="image/*,video/*"
                        onChange={e => {
                          handleMediaFile(e.target.files?.[0]);
                          e.target.value = '';
                        }}
                      />
                      {!form.imgSrc ? (
                        <div 
                          ref={containerRef}
                          onClick={() => fileInputRef.current?.click()}
                          onDragEnter={handleMediaDragOver}
                          onDragOver={handleMediaDragOver}
                          onDragLeave={handleMediaDragLeave}
                          onDrop={handleMediaDrop}
                          className="preview-box cursor-pointer relative group"
                          style={{ 
                            background: form.bgColor || '#000000', 
                            boxSizing: 'border-box'
                          }}
                        >
                          <div 
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              width: '100%',
                              height: '100%',
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'center',
                              justifyContent: 'center',
                              backgroundColor: 'transparent',
                              borderRadius: '8px',
                              transition: 'background-color 0.2s',
                              pointerEvents: 'none'
                            }}
                          >
                            <ImageIcon size={48} className="text-slate-400 mb-2 transition-transform group-hover:scale-105" />
                            <span className="text-sm font-semibold text-slate-300">Select Image/Video</span>
                          </div>
                          {isDraggingOver && (
                            <div style={{
                              position: 'absolute',
                              inset: 0,
                              backgroundColor: 'rgba(16, 185, 129, 0.15)',
                              border: '2px dashed #10B981',
                              borderRadius: '8px',
                              zIndex: 50,
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'center',
                              justifyContent: 'center',
                              color: '#10B981',
                              fontWeight: 'bold',
                              pointerEvents: 'none',
                              backdropFilter: 'blur(4px)'
                            }}>
                              <Upload size={32} className="animate-bounce mb-2" />
                              <span className="text-sm">Drop to Upload Media</span>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div 
                          ref={containerRef}
                          onDragEnter={handleMediaDragOver}
                          onDragOver={handleMediaDragOver}
                          onDragLeave={handleMediaDragLeave}
                          onDrop={handleMediaDrop}
                          className="preview-box"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (!form.imgSrc || !imageObjRef.current) return;
                            const step = e.shiftKey ? 5 : 1;
                            let newX = form.canvasX;
                            let newY = form.canvasY;
                            if (e.key === 'ArrowUp') newY -= step;
                            else if (e.key === 'ArrowDown') newY += step;
                            else if (e.key === 'ArrowLeft') newX -= step;
                            else if (e.key === 'ArrowRight') newX += step;
                            else return;
                            
                            e.preventDefault();
                            updateForm({ canvasX: newX, canvasY: newY });
                          }}
                          style={{
                            backgroundColor: form.bgColor || '#000000',
                            userSelect: 'none',
                            cursor: 'grab',
                            boxSizing: 'border-box',
                            position: 'relative',
                            overscrollBehavior: 'contain'
                          }}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            e.currentTarget.focus();
                            if (!form.imgSrc || !imageObjRef.current) return;
                            
                            const container = e.currentTarget;
                            const scale = (container.clientWidth || 512) / 64;
                            const startX = e.clientX;
                            const startY = e.clientY;
                            const initialCanvasX = form.canvasX;
                            const initialCanvasY = form.canvasY;
                            
                            container.style.cursor = 'grabbing';
                            
                            const handleDragMove = (moveEvent) => {
                              const dx = moveEvent.clientX - startX;
                              const dy = moveEvent.clientY - startY;
                              
                              let newCanvasX = initialCanvasX + dx / scale;
                              let newCanvasY = initialCanvasY + dy / scale;
                              
                              const snapThreshold = 2.0;
                              const imageWidth = form.dwBase * form.zoom;
                              const imageHeight = form.dhBase * form.zoom;

                              // Snap to horizontal and vertical center (Photoshop smart guide snap)
                              if (Math.abs(newCanvasX + imageWidth / 2 - 32) < snapThreshold) {
                                newCanvasX = 32 - imageWidth / 2;
                              }
                              if (Math.abs(newCanvasY + imageHeight / 2 - 10) < snapThreshold) {
                                newCanvasY = 10 - imageHeight / 2;
                              }

                              if (Math.abs(newCanvasX) < snapThreshold) newCanvasX = 0;
                              if (Math.abs(newCanvasX + imageWidth - 64) < snapThreshold) newCanvasX = 64 - imageWidth;
                              if (Math.abs(newCanvasY) < snapThreshold) newCanvasY = 0;
                              if (Math.abs(newCanvasY + imageHeight - 20) < snapThreshold) newCanvasY = 20 - imageHeight;
                              
                              const nextPixels = runCropRender(
                                imageObjRef.current,
                                newCanvasX,
                                newCanvasY,
                                form.dwBase * form.zoom,
                                form.dhBase * form.zoom,
                                form.bgColor || '#000000'
                              );
                              
                              setForm(prev => ({
                                ...prev,
                                canvasX: newCanvasX,
                                canvasY: newCanvasY,
                                pixels: nextPixels
                              }));
                            };
                            
                            const handleDragEnd = () => {
                              container.style.cursor = 'grab';
                              window.removeEventListener('mousemove', handleDragMove);
                              window.removeEventListener('mouseup', handleDragEnd);
                            };
                            
                            window.addEventListener('mousemove', handleDragMove);
                            window.addEventListener('mouseup', handleDragEnd);
                          }}
                          onWheel={(e) => {
                            e.preventDefault();
                            if (!imageObjRef.current) return;
                            
                            const zoomFactor = e.deltaY < 0 ? 1.05 : 0.95;
                            const newZoom = Math.min(Math.max(form.zoom * zoomFactor, 0.1), 10.0);
                            
                            const oldZoom = form.zoom;
                            const oldX = form.canvasX;
                            const oldY = form.canvasY;
                            
                            const newX = 32 - (32 - oldX) * (newZoom / oldZoom);
                            const newY = 10 - (10 - oldY) * (newZoom / oldZoom);
                            
                            const nextPixels = runCropRender(
                              imageObjRef.current,
                              newX,
                              newY,
                              form.dwBase * newZoom,
                              form.dhBase * newZoom,
                              form.bgColor || '#000000'
                            );
                            
                            setForm(prev => ({
                              ...prev,
                              zoom: newZoom,
                              canvasX: newX,
                              canvasY: newY,
                              pixels: nextPixels
                            }));
                          }}
                        >
                          {/* Image / Video / GIF with exact 64x20 quantized pixelated styling */}
                          <MediaPixelPreview
                            key={form.imgSrc || 'empty-media'}
                            imgSrc={form.imgSrc}
                            fileType={form.fileType}
                            canvasX={form.canvasX}
                            canvasY={form.canvasY}
                            dw={form.dwBase * form.zoom}
                            dh={form.dhBase * form.zoom}
                            bgColor={form.bgColor}
                            pixels={form.pixels}
                            speed={form.speed}
                            frameDurationMs={form.frameDurationMs}
                          />

                          {/* 64x20 Pixel Matrix Grid */}
                          {showGrid && (
                            <div 
                              style={{
                                position: 'absolute',
                                inset: 0,
                                backgroundImage: `
                                  linear-gradient(to right, rgba(255, 255, 255, 0.08) 1px, transparent 1px),
                                  linear-gradient(to bottom, rgba(255, 255, 255, 0.08) 1px, transparent 1px)
                                `,
                                backgroundSize: 'calc(100% / 64) calc(100% / 20)',
                                pointerEvents: 'none',
                                zIndex: 10
                              }} 
                            />
                          )}

                          {/* Photoshop-style Centering Guides */}
                          {showGuides && (() => {
                            const imgW = form.dwBase * form.zoom;
                            const imgH = form.dhBase * form.zoom;
                            const isHCenter = Math.abs((form.canvasX + imgW / 2) - 32) < 0.35;
                            const isVCenter = Math.abs((form.canvasY + imgH / 2) - 10) < 0.35;
                            return (
                              <>
                                {/* Vertical Center Guide (x=32) */}
                                <div 
                                  style={{
                                    position: 'absolute',
                                    left: '50%',
                                    top: 0,
                                    bottom: 0,
                                    width: isHCenter ? '2px' : '1px',
                                    transform: 'translateX(-50%)',
                                    backgroundColor: isHCenter ? '#f43f5e' : 'rgba(244, 63, 94, 0.4)',
                                    boxShadow: isHCenter ? '0 0 8px #f43f5e, 0 0 2px #ffffff' : 'none',
                                    pointerEvents: 'none',
                                    zIndex: 12,
                                    transition: 'all 0.1s ease'
                                  }} 
                                />
                                {/* Horizontal Center Guide (y=10) */}
                                <div 
                                  style={{
                                    position: 'absolute',
                                    top: '50%',
                                    left: 0,
                                    right: 0,
                                    height: isVCenter ? '2px' : '1px',
                                    transform: 'translateY(-50%)',
                                    backgroundColor: isVCenter ? '#f43f5e' : 'rgba(244, 63, 94, 0.4)',
                                    boxShadow: isVCenter ? '0 0 8px #f43f5e, 0 0 2px #ffffff' : 'none',
                                    pointerEvents: 'none',
                                    zIndex: 12,
                                    transition: 'all 0.1s ease'
                                  }} 
                                />
                              </>
                            );
                          })()}

                          {isDraggingOver && (
                            <div style={{
                              position: 'absolute',
                              inset: 0,
                              backgroundColor: 'rgba(16, 185, 129, 0.15)',
                              border: '2px dashed #10B981',
                              borderRadius: '8px',
                              zIndex: 50,
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'center',
                              justifyContent: 'center',
                              color: '#10B981',
                              fontWeight: 'bold',
                              pointerEvents: 'none',
                              backdropFilter: 'blur(4px)'
                            }}>
                              <Upload size={32} className="animate-bounce mb-2" />
                              <span className="text-sm">Drop to Upload Media</span>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  ) : form.mode === 'drawing' ? (
                    <div 
                      onMouseDown={(e) => {
                        if (form.mode !== 'drawing') return;
                        setUndoStack(prev => [...prev, [...form.pixels]]);
                        setRedoStack([]);
                      }}
                      className="preview-box"
                      style={{ 
                        display: 'grid', 
                        gridTemplateColumns: 'repeat(64, 1fr)', 
                        gridTemplateRows: 'repeat(20, 1fr)', 
                        gap: '1px', 
                        background: form.bgColor || '#000000', 
                        padding: '4px', 
                        width: '100%', 
                        aspectRatio: '64/20', 
                        boxSizing: 'border-box'
                      }}
                    >
                      {(Array.isArray(form.pixels) ? form.pixels : Array(1280).fill(0)).map((p, i) => {
                        const activeColor = form.textColor || '#ffffff';
                        return (
                          <div 
                            key={i} 
                            onMouseDown={(e) => {
                              e.preventDefault();
                              if (form.mode !== 'drawing') return;
                              const next = [...form.pixels];
                              const currentColor = form.textColor || '#ffffff';
                              if (isEraserActive) {
                                next[i] = 0;
                              } else {
                                next[i] = next[i] === currentColor ? 0 : currentColor;
                              }
                              setForm({...form, pixels: next});
                            }}
                            onMouseEnter={(e) => {
                              if (form.mode !== 'drawing' || e.buttons !== 1) return;
                              const next = [...form.pixels];
                              const currentColor = form.textColor || '#ffffff';
                              if (isEraserActive) {
                                next[i] = 0;
                              } else {
                                next[i] = currentColor;
                              }
                              setForm({...form, pixels: next});
                            }}
                            onDragStart={(e) => e.preventDefault()}
                            style={{ 
                              background: (p && p !== 0 ? (typeof p === 'string' && p.startsWith('#') ? p : activeColor) : (form.bgColor || '#000000')),
                              cursor: 'crosshair',
                              userSelect: 'none'
                            }}
                          />
                        );
                      })}
                    </div>
                  ) : (
                    <div className="preview-box">
                      {form.mode === 'clock' ? (
                        <ClockPresetCardPreview preset={form} now={now} />
                      ) : (
                        <TextPresetCardPreview preset={{ ...form, name: '' }} />
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-6">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button 
                        onClick={() => { editingModeRef.current = 'text'; setForm({...form, mode: 'text'}); }}
                        className={`btn-styled text-[10px] px-4 py-1.5 rounded-full transition-all ${form.mode !== 'text' ? 'inactive' : ''}`}
                        style={{ fontSize: 10, fontWeight: 900, flex: 1 }}
                      >
                        TEXT
                      </button>
                      <button 
                        onClick={() => {
                          editingModeRef.current = 'drawing';
                          if (form.mode !== 'drawing') {
                            setForm(prev => {
                              const originalPreset = presets?.find(pr => pr.id === editingId);
                              const isOriginalDrawing = originalPreset && originalPreset.mode === 'drawing';
                              
                              let nextPixels;
                              if (isOriginalDrawing) {
                                nextPixels = originalPreset.pixels || Array(64 * 20).fill(0);
                              } else {
                                nextPixels = Array(64 * 20).fill(0);
                              }
                              
                              const normalized = nextPixels.map(p => {
                                if (p && p !== 0) {
                                  return (typeof p === 'string' && p.startsWith('#')) ? p : (prev.textColor || '#ffffff');
                                }
                                return 0;
                              });
                              
                              return { ...prev, mode: 'drawing', pixels: normalized };
                            });
                          }
                        }}
                        className={`btn-styled text-[10px] px-4 py-1.5 rounded-full transition-all ${form.mode !== 'drawing' ? 'inactive' : ''}`}
                        style={{ fontSize: 10, fontWeight: 900, flex: 1 }}
                      >
                        DRAW
                      </button>
                      <button 
                        onClick={() => { editingModeRef.current = 'image'; setForm({...form, mode: 'image'}); }}
                        className={`btn-styled text-[10px] px-4 py-1.5 rounded-full transition-all ${form.mode !== 'image' ? 'inactive' : ''}`}
                        style={{ fontSize: 10, fontWeight: 900, flex: 1 }}
                      >
                        MEDIA
                      </button>
                      <button 
                        onClick={() => { editingModeRef.current = 'clock'; setForm({...form, mode: 'clock'}); }}
                        className={`btn-styled text-[10px] px-4 py-1.5 rounded-full transition-all ${form.mode !== 'clock' ? 'inactive' : ''}`}
                        style={{ fontSize: 10, fontWeight: 900, flex: 1 }}
                      >
                        CLOCK
                      </button>
                    </div>
                    
                    {/* Default Toggle */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingRight: '4px', paddingTop: '12px', paddingBottom: '12px' }}>
                      <label style={{ fontSize: '13px', fontWeight: 700, color: '#cbd5e1', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <input 
                          type="checkbox" 
                          checked={form.isDefault} 
                          onChange={(e) => setForm({...form, isDefault: e.target.checked})}
                          style={{ margin: 0, width: '16px', height: '16px', accentColor: 'var(--accent-primary)', cursor: 'pointer' }}
                        />
                        Use as Default
                      </label>
                    </div>
                  </div>

                  {form.mode === 'drawing' ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', marginTop: '8px', padding: '16px', background: 'rgba(255,255,255,0.02)', borderRadius: '20px', border: '1px solid rgba(255,255,255,0.05)' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px' }}>
                        <HslColorSlider 
                          label="Pen Colour" 
                          value={form.textColor || '#ffffff'} 
                          onChange={val => setForm(prev => ({ ...prev, textColor: val }))} 
                        />
                        <HslColorSlider 
                          label="Background Colour" 
                          value={form.bgColor || '#000000'} 
                          onChange={val => setForm(prev => ({ ...prev, bgColor: val }))} 
                        />
                      </div>

                      {/* Action Buttons (Clear & Eraser) */}
                      <div style={{ display: 'flex', gap: '20px', justifyContent: 'center', marginTop: '12px' }}>
                        {/* Clean Button */}
                        <button
                          onClick={() => {
                            setUndoStack(prev => [...prev, [...form.pixels]]);
                            setRedoStack([]);
                            setForm(prev => ({ ...prev, pixels: Array(64 * 20).fill(0) }));
                          }}
                          type="button"
                          style={{
                            width: '64px',
                            height: '64px',
                            borderRadius: '16px',
                            background: 'rgba(255, 255, 255, 0.04)',
                            border: '1px solid rgba(255, 255, 255, 0.08)',
                            color: '#f8fafc',
                            cursor: 'pointer',
                            transition: 'all 0.2s',
                            outline: 'none',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                          }}
                          onMouseOver={e => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)'; e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)'; e.currentTarget.style.transform = 'scale(1.05)'; }}
                          onMouseOut={e => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)'; e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)'; e.currentTarget.style.transform = 'none'; }}
                          title="Clear Canvas"
                        >
                          <img src="https://static.thenounproject.com/png/5507757-200.png" alt="Clear" width="30" height="30" style={{ filter: 'invert(100%)', opacity: 1.0 }} />
                        </button>

                        {/* Eraser Button */}
                        <button
                          onClick={() => {
                            setIsEraserActive(!isEraserActive);
                          }}
                          type="button"
                          style={{ 
                            width: '64px', 
                            height: '64px', 
                            borderRadius: '16px', 
                            background: isEraserActive 
                              ? 'linear-gradient(135deg, rgba(139, 92, 246, 0.2), rgba(236, 72, 153, 0.2))'
                              : 'rgba(255, 255, 255, 0.04)',
                            border: isEraserActive
                              ? '1px solid rgba(139, 92, 246, 0.5)'
                              : '1px solid rgba(255, 255, 255, 0.08)',
                            color: isEraserActive ? '#f472b6' : '#f8fafc',
                            boxShadow: isEraserActive ? '0 0 16px rgba(139, 92, 246, 0.2)' : 'none',
                            cursor: 'pointer',
                            transition: 'all 0.2s',
                            outline: 'none',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                          }}
                          onMouseOver={e => {
                            e.currentTarget.style.transform = 'scale(1.05)';
                            if (!isEraserActive) {
                              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
                              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)';
                            }
                          }}
                          onMouseOut={e => {
                            e.currentTarget.style.transform = 'none';
                            if (!isEraserActive) {
                              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
                              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                            }
                          }}
                          title="Eraser Tool"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={isEraserActive ? 'text-pink-400' : 'text-slate-300'} aria-hidden="true"><path d="M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21"></path><path d="m5.082 11.09 8.828 8.828"></path></svg>
                        </button>

                        {/* Undo Button */}
                        <button
                          onClick={() => {
                            if (undoStack.length === 0) return;
                            const previous = undoStack[undoStack.length - 1];
                            setUndoStack(undoStack.slice(0, -1));
                            setRedoStack(prev => [...prev, [...form.pixels]]);
                            setForm(prev => ({ ...prev, pixels: previous }));
                          }}
                          type="button"
                          disabled={undoStack.length === 0}
                          style={{
                            width: '64px',
                            height: '64px',
                            borderRadius: '16px',
                            background: 'rgba(255, 255, 255, 0.04)',
                            border: '1px solid rgba(255, 255, 255, 0.08)',
                            color: '#f8fafc',
                            cursor: undoStack.length ? 'pointer' : 'not-allowed',
                            transition: 'all 0.2s',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            opacity: undoStack.length ? 1 : 0.5,
                          }}
                          onMouseOver={e => { if (undoStack.length) { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)'; e.currentTarget.style.transform = 'scale(1.05)'; } }}
                          onMouseOut={e => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)'; e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)'; e.currentTarget.style.transform = 'none'; }}
                          title="Undo"
                        >
                          <Undo2 size={24} className="text-slate-300" />
                        </button>

                        {/* Redo Button */}
                        <button
                          onClick={() => {
                            if (redoStack.length === 0) return;
                            const next = redoStack[redoStack.length - 1];
                            setRedoStack(redoStack.slice(0, -1));
                            setUndoStack(prev => [...prev, [...form.pixels]]);
                            setForm(prev => ({ ...prev, pixels: next }));
                          }}
                          type="button"
                          disabled={redoStack.length === 0}
                          style={{
                            width: '64px',
                            height: '64px',
                            borderRadius: '16px',
                            background: 'rgba(255, 255, 255, 0.04)',
                            border: '1px solid rgba(255, 255, 255, 0.08)',
                            color: '#f8fafc',
                            cursor: redoStack.length ? 'pointer' : 'not-allowed',
                            transition: 'all 0.2s',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            opacity: redoStack.length ? 1 : 0.5,
                          }}
                          onMouseOver={e => { if (redoStack.length) { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)'; e.currentTarget.style.transform = 'scale(1.05)'; } }}
                          onMouseOut={e => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)'; e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)'; e.currentTarget.style.transform = 'none'; }}
                          title="Redo"
                        >
                          <Redo2 size={24} className="text-slate-300" />
                        </button>
                      </div>
                    </div>
                  ) : form.mode === 'text' ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <label className="text-[10px] font-bold text-slate-500 uppercase ml-1">Display Text (Max 25 chars)</label>
                      <input 
                        className="input-field w-full" 
                        value={form.text} 
                        maxLength={25}
                        onChange={e => {
                          const val = e.target.value;
                          setForm(prev => ({...prev, text: val}));
                        }} 
                        placeholder="Type something..."
                      />
                    </div>
                  ) : null}
                </div>

                {/* Image / Video Controls */}
                {form.mode === 'image' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="btn-styled text-[10px] px-3 py-2 flex items-center gap-1.5"
                          style={{ borderRadius: '12px' }}
                        >
                          <Upload size={13} />
                        </button>
                          {form.imgSrc && (
                            <button
                              type="button"
                              onClick={exportOriginalMedia}
                              className="btn-styled text-[10px] px-3 py-2 flex items-center gap-1.5"
                              style={{ borderRadius: '12px' }}
                              title="Download the original uploaded media at its original quality"
                            >
                              <Download size={13} />
                            </button>
                          )}
                      </div>

                      {/* Visual Tools Toggles */}
                      {form.imgSrc && <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {form.imgSrc && (
                          <button
                            type="button"
                            onClick={() => {
                              if (!imageObjRef.current) return;
                              const newX = (64 - form.dwBase * form.zoom) / 2;
                              const newY = (20 - form.dhBase * form.zoom) / 2;
                              const nextPixels = runCropRender(imageObjRef.current, newX, newY, form.dwBase * form.zoom, form.dhBase * form.zoom, form.bgColor || '#000000');
                              setForm(prev => ({ ...prev, canvasX: newX, canvasY: newY, pixels: nextPixels }));
                            }}
                            className="btn-styled text-[10px] px-3 py-2"
                            style={{ borderRadius: '12px' }}
                            title="Center media"
                          >
                            <Crosshair size={13} />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setShowGrid(prev => !prev)}
                          className={`btn-styled text-[10px] px-3 py-2 ${!showGrid ? 'inactive' : ''}`}
                          style={{ borderRadius: '12px' }}
                          title="Toggle pixel matrix grid"
                        >
                          <Grid3X3 size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowGuides(prev => !prev)}
                          className={`btn-styled text-[10px] px-3 py-2 ${!showGuides ? 'inactive' : ''}`}
                          style={{ borderRadius: '12px' }}
                          title="Toggle centering guides"
                        >
                          <ScanLine size={13} />
                        </button>
                      </div>}
                    </div>

                    {form.imgSrc && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '4px' }}>
                        {/* Zoom Slider */}
                        <div className="brightness-rail glass-panel" style={{ padding: '12px 16px', width: '100%', display: 'flex', alignItems: 'center', gap: '14px' }}>
                          <Search className="text-emerald-400 flex-shrink-0" size={17} />
                          <input 
                            type="range" min="0.1" max="10.0" step="0.05" 
                            value={form.zoom || 1} 
                            onChange={e => {
                              const newZoom = parseFloat(e.target.value);
                              if (!imageObjRef.current) return;
                              const oldZoom = form.zoom || 1.0;
                              const oldX = form.canvasX || 0;
                              const oldY = form.canvasY || 0;
                              
                              const newX = 32 - (32 - oldX) * (newZoom / oldZoom);
                              const newY = 10 - (10 - oldY) * (newZoom / oldZoom);
                              
                              const nextPixels = runCropRender(
                                imageObjRef.current,
                                newX,
                                newY,
                                form.dwBase * newZoom,
                                form.dhBase * newZoom,
                                form.bgColor || '#000000'
                              );
                              
                              setForm(prev => ({
                                ...prev,
                                zoom: newZoom,
                                canvasX: newX,
                                canvasY: newY,
                                pixels: nextPixels
                              }));
                            }}
                            className="h-slider"
                            style={{ flex: 1 }}
                          />
                          <span className="font-bold text-slate-400 w-12 text-[11px] text-right">{(form.zoom || 1).toFixed(1)}x</span>
                          <div
                            className="power-btn off"
                            style={{
                              width: '34px',
                              height: '34px',
                              borderRadius: '10px',
                              background: 'rgba(255, 255, 255, 0.04)',
                              border: '1px solid rgba(255, 255, 255, 0.08)',
                              color: '#f8fafc',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              cursor: 'pointer',
                              transition: 'all 0.2s',
                              flexShrink: 0
                            }}
                            title="Fit to Width"
                            onMouseOver={e => {
                              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
                              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)';
                              e.currentTarget.style.transform = 'scale(1.05)';
                            }}
                            onMouseOut={e => {
                              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
                              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                              e.currentTarget.style.transform = 'none';
                            }}
                            onClick={() => {
                              if (!imageObjRef.current) return;
                              const targetZoom = Math.min(Math.max(64 / (form.dwBase || 64), 0.1), 10.0);
                              const newX = 0;
                              const newY = (20 - (form.dhBase || 20) * targetZoom) / 2;
                              const nextPixels = runCropRender(
                                imageObjRef.current,
                                newX,
                                newY,
                                (form.dwBase || 64) * targetZoom,
                                (form.dhBase || 20) * targetZoom,
                                form.bgColor || '#000000'
                              );
                              setForm(prev => ({
                                ...prev,
                                zoom: targetZoom,
                                canvasX: newX,
                                canvasY: newY,
                                pixels: nextPixels
                              }));
                            }}
                          >
                            <StretchHorizontal size={16} />
                          </div>

                          <div
                            className="power-btn off"
                            style={{
                              width: '34px',
                              height: '34px',
                              borderRadius: '10px',
                              background: 'rgba(255, 255, 255, 0.04)',
                              border: '1px solid rgba(255, 255, 255, 0.08)',
                              color: '#f8fafc',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              cursor: 'pointer',
                              transition: 'all 0.2s',
                              flexShrink: 0
                            }}
                            title="Fit to Height"
                            onMouseOver={e => {
                              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
                              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)';
                              e.currentTarget.style.transform = 'scale(1.05)';
                            }}
                            onMouseOut={e => {
                              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
                              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                              e.currentTarget.style.transform = 'none';
                            }}
                            onClick={() => {
                              if (!imageObjRef.current) return;
                              const targetZoom = Math.min(Math.max(20 / (form.dhBase || 20), 0.1), 10.0);
                              const newY = 0;
                              const newX = (64 - (form.dwBase || 64) * targetZoom) / 2;
                              const nextPixels = runCropRender(
                                imageObjRef.current,
                                newX,
                                newY,
                                (form.dwBase || 64) * targetZoom,
                                (form.dhBase || 20) * targetZoom,
                                form.bgColor || '#000000'
                              );
                              setForm(prev => ({
                                ...prev,
                                zoom: targetZoom,
                                canvasX: newX,
                                canvasY: newY,
                                pixels: nextPixels
                              }));
                            }}
                          >
                            <StretchVertical size={16} />
                          </div>

                          <div
                            className="power-btn off"
                            style={{
                              width: '34px',
                              height: '34px',
                              borderRadius: '10px',
                              background: 'rgba(255, 255, 255, 0.04)',
                              border: '1px solid rgba(255, 255, 255, 0.08)',
                              color: '#f8fafc',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              cursor: 'pointer',
                              transition: 'all 0.2s',
                              flexShrink: 0
                            }}
                            title="Reset Zoom (1.0x)"
                            onMouseOver={e => {
                              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
                              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)';
                              e.currentTarget.style.transform = 'scale(1.05)';
                            }}
                            onMouseOut={e => {
                              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
                              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                              e.currentTarget.style.transform = 'none';
                            }}
                            onClick={() => {
                              if (!imageObjRef.current) return;
                              const newZoom = 1.0;
                              const oldZoom = form.zoom || 1.0;
                              const oldX = form.canvasX || 0;
                              const oldY = form.canvasY || 0;
                              const newX = 32 - (32 - oldX) * (newZoom / oldZoom);
                              const newY = 10 - (10 - oldY) * (newZoom / oldZoom);
                              const nextPixels = runCropRender(
                                imageObjRef.current,
                                newX,
                                newY,
                                form.dwBase * newZoom,
                                form.dhBase * newZoom,
                                form.bgColor || '#000000'
                              );
                              setForm(prev => ({
                                ...prev,
                                zoom: newZoom,
                                canvasX: newX,
                                canvasY: newY,
                                pixels: nextPixels
                              }));
                            }}
                          >
                            <RotateCcw size={16} />
                          </div>
                        </div>

                        {/* Background Color Slider */}
                        <HslColorSlider 
                          label="Background Colour" 
                          value={form.bgColor || '#000000'} 
                          onChange={val => {
                            setForm(prev => ({ ...prev, bgColor: val }));
                            if (imageObjRef.current) {
                              const nextPixels = runCropRender(
                                imageObjRef.current,
                                form.canvasX,
                                form.canvasY,
                                form.dwBase * (form.zoom || 1),
                                form.dhBase * (form.zoom || 1),
                                val
                              );
                              setForm(prev => ({ ...prev, bgColor: val, pixels: nextPixels }));
                            }
                          }} 
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* Conditional Form Options */}
                {form.mode === 'text' && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px', marginTop: '20px' }}>
                    <HslColorSlider 
                      label="Text Colour" 
                      value={form.textColor || '#ffffff'} 
                      onChange={val => setForm(prev => ({ ...prev, textColor: val }))} 
                    />
                    <HslColorSlider 
                      label="Background Colour" 
                      value={form.bgColor || '#000000'} 
                      onChange={val => setForm(prev => ({ ...prev, bgColor: val }))} 
                    />
                  </div>
                )}

                {form.mode === 'text' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '24px' }}>
                    <label style={{ fontSize: '11px', fontWeight: 'bold', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
                      Animation
                    </label>
                    <div style={{ position: 'relative', width: '215px', flexShrink: 0 }}>
                      <button
                        type="button"
                        className="input-field"
                        style={{
                          width: '100%',
                          background: '#1a1a1f',
                          color: '#fff',
                          cursor: 'pointer',
                          padding: '10px 14px',
                          borderRadius: '14px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          textAlign: 'left'
                        }}
                        onClick={() => setAnimDropdownOpen(prev => !prev)}
                      >
                        <span style={{ fontSize: '12px', textTransform: 'none', whiteSpace: 'nowrap' }}>{form.animation || 'continuous left shift'}</span>
                        <ChevronDown 
                          size={14} 
                          className="text-slate-400 transition-transform duration-200" 
                          style={{ transform: animDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)' }} 
                        />
                      </button>

                      {animDropdownOpen && (
                        <>
                          <div 
                            className="fixed inset-0 z-40" 
                            onClick={() => setAnimDropdownOpen(false)} 
                          />
                          <div 
                            className="glass-panel z-50"
                            style={{
                              position: 'absolute',
                              bottom: 'calc(100% + 6px)',
                              left: 0,
                              width: '100%',
                              background: '#1a1a1f',
                              border: '1px solid rgba(255, 255, 255, 0.15)',
                              borderRadius: '14px',
                              overflow: 'hidden',
                              boxShadow: '0 -10px 25px -5px rgba(0, 0, 0, 0.6)',
                              maxHeight: '320px',
                              overflowY: 'auto'
                            }}
                          >
                            {['bubble', 'continuous left shift', 'flicker', 'move down', 'move right', 'move up', 'shift left', 'show now', 'snow'].map(a => {
                              const isSelected = (form.animation || 'continuous left shift') === a;
                              return (
                                <div
                                  key={a}
                                  onClick={() => {
                                    setForm(prev => ({ ...prev, animation: a }));
                                    setAnimDropdownOpen(false);
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
                                  <span style={{ whiteSpace: 'nowrap' }}>{a}</span>
                                  {isSelected && <Check size={13} className="text-emerald-400" />}
                                </div>
                              );
                            })}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}



                {saveError && <div role="alert" style={{ color: '#f87171', marginTop: 16 }}>
                  Error saving preset: {saveError}
                </div>}
                <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
                  <button 
                    className="btn-styled py-4" 
                    style={{ flex: 3 }}
                    onClick={handleSave}
                    disabled={isSaving || !hasRequiredPresetContent}
                  >
                    <Save size={16} /> {isSaving ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span>Processing...</span>
                      <span
                        aria-label={`Saving progress: ${saveProgress ?? 0}%`}
                        style={{ width: 72, height: 6, borderRadius: 999, background: 'rgba(255,255,255,0.28)', overflow: 'hidden' }}
                      >
                        <span style={{ display: 'block', width: `${saveProgress ?? 0}%`, height: '100%', background: '#ffffff', borderRadius: 'inherit', transition: 'width 0.15s ease' }} />
                      </span>
                      <span>{saveProgress ?? 0}%</span>
                    </span> : (editingId ? 'Update Preset' : 'Save Preset')}
                  </button>
                  {editingId && (
                    <button 
                      className="btn-styled py-4 bg-red-500/10 border-red-500/20 text-red-400 hover:bg-red-500/20" 
                      style={{ flex: 1, minWidth: 'auto' }}
                      onClick={() => deletePreset()}
                    >
                      <Trash2 size={18} /> Delete
                    </button>
                  )}
                </div>
              </div>
            </motion.div>
          </div>
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
}
