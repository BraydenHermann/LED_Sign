import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { savePresetToSign, processVideoMedia } from './serverApi';
import { fitEventSignText } from './eventText';
import GeminiMediaGenerator, { GeminiLogo, OpenAILogo } from './GeminiMediaGenerator';

import { motion, AnimatePresence } from 'framer-motion';
import {
  Power, Sun, Calendar, Image as ImageIcon, Bluetooth, Wifi,
  Activity, Upload, Clock, ExternalLink, Link2Off, Link2,
  FileSearch, Search, RefreshCw, RotateCcw, StretchHorizontal, StretchVertical, EyeOff, ChevronRight, ChevronDown, X,
  ChevronLeft, AlertCircle, Eraser, Undo2, Redo2, Plus, Pencil, Zap, Gauge, Check,
  Trash2, Pipette, Save, Send, Star, Download, Crosshair, Grid3X3, ScanLine, Type,
  LogOut, Laptop, Settings, Hand
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

function cleanEventTitle(title, isClean = true) {
  if (!title) return 'Untitled Event';
  if (!isClean) return title;

  let cleaned = title;
  const names = ['Brayden Hermann', 'Brayden', 'Hermann'];

  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // " and Name", " & Name", ", and Name", ", & Name"
    cleaned = cleaned.replace(new RegExp(`[\\s,]+(?:and|&)\\s+${escaped}\\b`, 'gi'), '');
    // "Name and ", "Name & "
    cleaned = cleaned.replace(new RegExp(`\\b${escaped}\\s+(?:and|&)\\s*`, 'gi'), '');
    // " with Name"
    cleaned = cleaned.replace(new RegExp(`\\s*(?:with)\\s+${escaped}\\b`, 'gi'), '');
    // " - Name", " / Name", " : Name", " | Name"
    cleaned = cleaned.replace(new RegExp(`\\s*[-/:|]\\s*${escaped}\\b`, 'gi'), '');
    cleaned = cleaned.replace(new RegExp(`\\b${escaped}\\s*[-/:|]\\s*`, 'gi'), '');
    // ", Name"
    cleaned = cleaned.replace(new RegExp(`,\\s*${escaped}\\b`, 'gi'), '');
    // Standalone Name
    cleaned = cleaned.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), '');
  }

  // Clean trailing or leading punctuation and dangling conjunctions
  cleaned = cleaned.replace(/\s*(?:and|&|\/|\-|:|,)\s*$/gi, '');
  cleaned = cleaned.replace(/^\s*(?:and|&|\/|\-|:|,)\s*/gi, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned || title.trim() || 'Untitled Event';
}

function getEventDisplayString(ev, isClean = null) {
  if (!ev) return 'IN A MEETING';
  if (isClean === null) {
    isClean = localStorage.getItem('loy_clean_name') !== 'false';
  }
  const rawSummary = ev.summary || 'Untitled Event';
  const summary = normalizeForSign(isClean ? cleanEventTitle(rawSummary, true) : rawSummary);
  try {
    const endD = new Date(ev.end_iso);
    const timeFmt = new Intl.DateTimeFormat(undefined, { 
      hour: 'numeric', 
      minute: '2-digit', 
      hour12: true 
    });
    const rawEndTimeStr = timeFmt.format(endD).toLowerCase();
    const signText = fitEventSignText(summary, rawEndTimeStr);

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
      frameDurationsMs={preset.frameDurationsMs}
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

const MediaPixelPreview = ({ imgSrc, fileType, canvasX, canvasY, dw, dh, bgColor, pixels, speed, frameDurationMs, frameDurationsMs }) => {
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

  // Canvas render loop. Frame rate matches AnimatedPresetCardPreview exactly.
  useLayoutEffect(() => {
    let animId;
    let timeoutId;
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

    ctx.imageSmoothingEnabled = false;

    // 1) Multi-frame pixels from saved preset (copied from AnimatedPresetCardPreview)
    if (parsedPixelFrames && parsedPixelFrames.length > 1) {
      const numFrames = parsedPixelFrames.length;
      const presetSpeed = speed || 8;
      const clampedSpeed = Math.max(1, Math.min(15, presetSpeed));
      const defaultDelayMs = frameDurationMs
        ? Math.max(16, frameDurationMs)
        : Math.max(50, (0.4 - (clampedSpeed * 0.025)) * 1000);
      const durationsList = Array.isArray(frameDurationsMs) && frameDurationsMs.length > 0 ? frameDurationsMs : null;

      const play = () => {
        ctx.putImageData(parsedPixelFrames[currentFrameIdx], 0, 0);
        const delayMs = Math.max(16, durationsList?.[currentFrameIdx] || defaultDelayMs);
        currentFrameIdx = (currentFrameIdx + 1) % numFrames;
        timeoutId = setTimeout(play, delayMs);
      };

      play();

      return () => {
        clearTimeout(timeoutId);
      };
    }

    // 2) Video playback
    if (fileType === 'video') {
      const render = () => {
        const v = videoRef.current;
        if (v && v.readyState >= 2) {
          try {
            ctx.fillStyle = bgColor || '#000000';
            ctx.fillRect(0, 0, 64, 20);
            ctx.drawImage(v, canvasX, canvasY, dw, dh);
          } catch {}
        }
        animId = requestAnimationFrame(render);
      };
      animId = requestAnimationFrame(render);
      return () => cancelAnimationFrame(animId);
    }

    // 3) Decoded GIF playback (copied timing from AnimatedPresetCardPreview)
    if (fileType === 'gif' && gifBitmapsRef.current.length > 0) {
      const frames = gifBitmapsRef.current;
      const numFrames = frames.length;
      const presetSpeed = speed || 8;
      const clampedSpeed = Math.max(1, Math.min(15, presetSpeed));
      const defaultDelayMs = frameDurationMs
        ? Math.max(16, frameDurationMs)
        : Math.max(50, (0.4 - (clampedSpeed * 0.025)) * 1000);
      const durationsList = Array.isArray(frameDurationsMs) && frameDurationsMs.length > 0 ? frameDurationsMs : null;

      const play = () => {
        const frameToDraw = frames[currentFrameIdx];
        if (frameToDraw && frameToDraw.bitmap) {
          try {
            ctx.fillStyle = bgColor || '#000000';
            ctx.fillRect(0, 0, 64, 20);
            ctx.drawImage(frameToDraw.bitmap, canvasX, canvasY, dw, dh);
          } catch {}
        }
        const delayMs = Math.max(16, durationsList?.[currentFrameIdx] || frameToDraw?.duration || defaultDelayMs);
        currentFrameIdx = (currentFrameIdx + 1) % numFrames;
        timeoutId = setTimeout(play, delayMs);
      };

      play();

      return () => {
        clearTimeout(timeoutId);
      };
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
  }, [imgSrc, fileType, canvasX, canvasY, dw, dh, bgColor, pixels, gifDecoded, speed, frameDurationMs, frameDurationsMs]);

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
  const [brightness, setBrightness] = useState(() => {
    const saved = parseInt(localStorage.getItem('loy_brightness'), 10);
    return saved >= 1 && saved <= 15 ? saved : 15;
  });
  useEffect(() => {
    try { localStorage.setItem('loy_brightness', String(brightness)); } catch (e) {}
  }, [brightness]);
  const brightnessSyncedRef = useRef(false);
  useEffect(() => {
    if (!status.connected) { brightnessSyncedRef.current = false; return; }
    if (brightnessSyncedRef.current || pushingRef.current) return;
    brightnessSyncedRef.current = true;
    if (status.brightness !== undefined && status.brightness !== brightness) {
      axios.post(`${API_BASE}/brightness?level=${brightness}`).catch(() => { brightnessSyncedRef.current = false; });
    }
  }, [status.connected, status.brightness]);
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
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [connectionTarget, setConnectionTarget] = useState(null);
  const [connectionError, setConnectionError] = useState('');
  const [passcodeTarget, setPasscodeTarget] = useState(null);
  const [bluetoothPasscode, setBluetoothPasscode] = useState('');
  const [passcodeError, setPasscodeError] = useState('');
  const [scanOpen, setScanOpen] = useState(false);
  const [apiError, setApiError] = useState(false);
  const [hasFetchedStatus, setHasFetchedStatus] = useState(false);
  const hadLiveConnectionRef = useRef(false);
  const disconnectedStatusPollsRef = useRef(0);
  const [pushMessage, setPushMessage] = useState('');
  const [localPushMessage, setLocalPushMessage] = useState('');
  const [pushing, setPushingState] = useState(false);
  const [pushingPresetTarget, setPushingPresetTarget] = useState(null);
  const [slotSaveProgress, setSlotSaveProgress] = useState(null);
  const [slotSavePhase, setSlotSavePhase] = useState('');
  const isSignUpdating = Boolean(pushing || slotSavePhase || slotSaveProgress !== null);
  const isSignUpdatingRef = useRef(false);
  isSignUpdatingRef.current = isSignUpdating;
  const autoConnectTried = useRef(false);
  const manuallyDisconnectedRef = useRef(false);

  const sessionPasscodesRef = useRef({});
  const getSessionPasscode = (addr) => {
    if (!addr) return '';
    const norm = addr.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    try {
      const fromSession = sessionStorage.getItem(`loy_session_passcode_${norm}`);
      if (fromSession) return fromSession;
    } catch (e) {}
    return sessionPasscodesRef.current[norm] || '';
  };
  const setSessionPasscode = (addr, code) => {
    if (!addr || !code) return;
    const norm = addr.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    sessionPasscodesRef.current[norm] = code;
    try {
      sessionStorage.setItem(`loy_session_passcode_${norm}`, code);
    } catch (e) {}
  };
  const clearSessionPasscode = (addr) => {
    if (!addr) return;
    const norm = addr.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    delete sessionPasscodesRef.current[norm];
    try {
      sessionStorage.removeItem(`loy_session_passcode_${norm}`);
    } catch (e) {}
  };

  const isSignConnecting = Boolean(
    isConnecting || 
    (!status.connected && !manuallyDisconnectedRef.current && Boolean(localStorage.getItem('loy_last_connected_mac')) && !autoConnectTried.current && !connectionFailed)
  );

  const [presetView, setPresetView] = useState('local');
  const pushingRef = useRef(false);

  const setPushing = (value, target = null) => {
    pushingRef.current = value;
    setPushingState(value);
    if (!value) {
      setPushingPresetTarget(null);
    } else if (target) {
      setPushingPresetTarget(target);
    }
  };

  const activeConnectRef = useRef(null);
  const preferredSignRef = useRef(null);
  const choosingSignRef = useRef(false);

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

  const [previewStamp, setPreviewStamp] = useState(Date.now());
  const lastPreviewTs = useRef(0);
  const lastFramesRef = useRef(-1);

  const fetchStatus = async () => {
    try {
      const res = await axios.get(`${API_BASE}/status`);
      // Do not let a late poll for the previous sign replace the selected
      // target while the user is connecting or entering its Passcode.
      if (res.data?.connected && preferredSignRef.current &&
          res.data.address?.toUpperCase() !== preferredSignRef.current.toUpperCase()) {
        return res.data;
      }
      if (manuallyDisconnectedRef.current && res.data?.connected) {
        return res.data;
      }
      // BLE can briefly report disconnected while it is recovering. Keep the
      // last live UI state through two status polls so the page does not race
      // the backend's reconnect worker or visibly flap on a refresh.
      if (res.data?.connected) {
        hadLiveConnectionRef.current = true;
        disconnectedStatusPollsRef.current = 0;
        autoConnectTried.current = false;
      } else if (hadLiveConnectionRef.current) {
        disconnectedStatusPollsRef.current += 1;
        if (disconnectedStatusPollsRef.current < 3) return res.data;
      }
      setStatus(res.data);
      if (res.data && res.data.connected && res.data.address) {
        if (!choosingSignRef.current && (!preferredSignRef.current || preferredSignRef.current.toUpperCase() === res.data.address.toUpperCase())) {
          setMacAddress(res.data.address);
          try {
            localStorage.setItem('loy_last_connected_mac', res.data.address);
            localStorage.setItem('loy_mac', res.data.address);
          } catch (e) {}
        }
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

  // Give the user time to choose another sign before trying the last one.
  useEffect(() => {
    const target = preferredSignRef.current || localStorage.getItem('loy_last_connected_mac');
    if (!hasFetchedStatus || status.connected || !target || autoConnectTried.current || isConnecting || apiError || scanOpen || manuallyDisconnectedRef.current) return;
    const timer = window.setTimeout(() => {
      if (autoConnectTried.current || choosingSignRef.current || manuallyDisconnectedRef.current) return;
      console.log("[auto-connect] Attempting to reconnect to sign:", target);
      autoConnectTried.current = true;
      doConnect(target, false, true);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [hasFetchedStatus, status.connected, isConnecting, apiError, scanOpen]);

  const doConnect = async (addr, isRetry = false, isAuto = false, passcode = '') => {
    if (!addr) return;
    const effectivePasscode = passcode || getSessionPasscode(addr) || getSessionPasscode(localStorage.getItem('loy_last_connected_mac'));
    if (!isAuto) {
      manuallyDisconnectedRef.current = false;
      autoConnectTried.current = true;
      preferredSignRef.current = addr;
      choosingSignRef.current = false;
      setConnectionTarget(addr);
      setConnectionError('');
    }
    if (activeConnectRef.current && !isRetry) {
      if (isAuto) return;
      // Dispatch the human-selected request immediately. The backend's
      // connection intent then supersedes the older attempt.
      activeConnectRef.current.controller.abort();
    }
    const controller = new AbortController();
    const requestId = Symbol('sign-connect');
    activeConnectRef.current = { id: requestId, isAuto, controller };
    setIsConnecting(true);
    setConnectionFailed(false);
    console.log(`[connect] ${isRetry ? 'Retry attempt' : 'Connecting'} to:`, addr, isAuto ? '(auto)' : '');
    try {
      const timeoutMs = 75000;
      const resPost = await axios.post(`${API_BASE}/connect`, { address: addr, ...(effectivePasscode ? { passcode: effectivePasscode } : {}) }, { timeout: timeoutMs, signal: controller.signal });
      if (activeConnectRef.current?.id !== requestId) return;
      const connectedAddr = resPost.data?.address || addr;
      if (connectedAddr && connectedAddr.toUpperCase().startsWith('FF:24:10:29:') && (!isAuto || !choosingSignRef.current)) {
        setMacAddress(connectedAddr);
        localStorage.setItem('loy_last_connected_mac', connectedAddr);
        localStorage.setItem('loy_mac', connectedAddr);
      }
      const res = await axios.get(`${API_BASE}/status`);
      if (activeConnectRef.current?.id !== requestId) return;
      if (res.data.connected && res.data.address?.toUpperCase() === addr.toUpperCase()) {
        setStatus(res.data);
        if (!choosingSignRef.current) setScanOpen(false);
        setConnectionFailed(false);
        if (!isAuto) setConnectionTarget(null);
        if (effectivePasscode) {
          setSessionPasscode(addr, effectivePasscode);
          setSessionPasscode(connectedAddr, effectivePasscode);
          if (res.data.address) setSessionPasscode(res.data.address, effectivePasscode);
          setPasscodeTarget(null);
          setBluetoothPasscode(effectivePasscode);
        }
        if (!isAuto || !choosingSignRef.current) {
          localStorage.setItem('loy_last_connected_mac', res.data.address || connectedAddr);
          localStorage.setItem('loy_mac', res.data.address || connectedAddr);
        }
        if (res.data.power !== undefined) setPower(res.data.power);
        else setPower(true);
      } else {
        throw new Error(`The selected sign did not connect${res.data.address ? `; still connected to ${res.data.address}` : ''}.`);
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      console.error(`[connect] ${isRetry ? 'Retry' : 'Attempt 1'} failed:`, e.message);
      if (e.response?.status === 401 && ['passcode_required', 'invalid_passcode'].includes(e.response?.data?.detail?.code)) {
        // Keep the credential transient: it is never written to persistent
        // storage, recent-device entries, or backend logs.
        if (e.response.data.detail.code === 'invalid_passcode') {
          clearSessionPasscode(addr);
          clearSessionPasscode(localStorage.getItem('loy_last_connected_mac'));
        }
        autoConnectTried.current = true;
        setConnectionTarget(null);
        setScanOpen(true);
        setPasscodeTarget(addr);
        setBluetoothPasscode(getSessionPasscode(addr));
        setPasscodeError(e.response.data.detail.code === 'invalid_passcode'
          ? 'Incorrect Passcode. Please try again.'
          : effectivePasscode ? 'The sign still requires authentication. Please check the Passcode and try again.' : '');
        return;
      }
      if (!e.response) {
        axios.get(`${API_BASE}/status`).then(() => setApiError(false)).catch(() => setApiError(true));
      }
      if (!isAuto) {
        setConnectionTarget(null);
        const detail = e.response?.data?.detail;
        const message = typeof detail === 'string' ? detail : detail?.message || `Could not connect to ${addr}. Please try again.`;
        setConnectionError(message);
        if (passcode) {
          setScanOpen(true);
          setPasscodeTarget(addr);
          setPasscodeError(message);
        }
      }
      setConnectionFailed(true);
    } finally {
      if (activeConnectRef.current?.id === requestId) {
        activeConnectRef.current = null;
        setIsConnecting(false);
      }
    }
  };

  const handleDisconnect = async () => {
    manuallyDisconnectedRef.current = true;
    hadLiveConnectionRef.current = false;
    disconnectedStatusPollsRef.current = 0;
    preferredSignRef.current = null;
    activeConnectRef.current?.controller.abort();
    activeConnectRef.current = null;
    setConnectionTarget(null);
    setConnectionError('');
    setConnectionFailed(false);
    setStatus(prev => ({ ...prev, connected: false, address: null, preview_url: null }));
    setIsConnecting(false);
    autoConnectTried.current = true; // Prevent immediate auto-reconnect loop on manual disconnect
    setPushMessage('');
    setLocalPushMessage('');
    setIsManualOverride(false);
    setLastPushedId(null);
    try { await axios.post(`${API_BASE}/disconnect`, {}, { timeout: 3000 }); } catch (e) {}
  };

  const submitBluetoothPasscode = async (event) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(bluetoothPasscode)) {
      setPasscodeError('Enter exactly six digits.');
      return;
    }
    const target = passcodeTarget;
    if (!target) return;
    setPasscodeError('');
    await doConnect(target, false, false, bluetoothPasscode);
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
  const isModalOpenRef = useRef(false);
  isModalOpenRef.current = isModalOpen;

  const scanOpenRef = useRef(false);
  scanOpenRef.current = scanOpen;

  const wasConnectingRef = useRef(false);

  useEffect(() => {
    if (isSignConnecting || isSignUpdating || pushing) {
      setPresetView('local');
      if (isSignConnecting) {
        wasConnectingRef.current = true;
      }
    } else if (wasConnectingRef.current) {
      if (status.connected && !isSignUpdating && !pushing) {
        wasConnectingRef.current = false;
        if (!isModalOpenRef.current && !scanOpenRef.current) {
          setPresetView('saved');
        }
      }
    } else if (!status.connected) {
      setPresetView('local');
      wasConnectingRef.current = false;
    }
  }, [isSignConnecting, status.connected, isModalOpen, scanOpen, isSignUpdating, pushing]);
  const [lastPushedId, setLastPushedId] = useState(null);

  useEffect(() => {
    if (lastPushedId && status?.address && playbackSignRef.current === status.address.toUpperCase()) {
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
  const playbackSignRef = useRef(null);
  useEffect(() => {
    if (!status.connected || !status.address) return;
    const signMac = status.address.toUpperCase();
    if (playbackSignRef.current && playbackSignRef.current !== signMac) {
      // Playback and calendar-return state belong to the previous sign.
      setLastPushedId(null);
      calendarReturnPresetRef.current = null;
      lastActiveEventIdRef.current = null;
      setIsManualOverrideState(false);
      isManualOverrideRef.current = false;
    }
    playbackSignRef.current = signMac;
  }, [status.connected, status.address]);
  // A transient BLE disconnect (for example while the PC is locked) must not
  // replay the default and overwrite the preset the user deliberately chose.
  const initializedConnectionMacsRef = useRef(new Set());
  const initializingConnectionRef = useRef(false);
  const setIsManualOverride = (val) => {
    isManualOverrideRef.current = val;
    setIsManualOverrideState(val);
  };
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
      const rawEvs = res.data?.events || [];
      const evs = rawEvs.map(ev => ({
        ...ev,
        summary: cleanEventTitle(ev.summary, isClean)
      }));
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
    if (!status?.connected || !dbLoaded || isSignUpdating || pushingRef.current || initializingConnectionRef.current ||
        !initializedConnectionMacsRef.current.has(status.address?.toUpperCase())) return;

    // Check for calendar event transitions to clear manual override (5 min early)
    try {
      if (events) {
        const nextEvent = selectCalendarEvent(events, now);
        const nextEventId = nextEvent ? `${nextEvent.id}-${nextEvent.start_iso}` : null;
        if (nextEventId && lastActiveEventIdRef.current && nextEventId !== lastActiveEventIdRef.current) {
          console.log(`[auto-push] Event window transition: ${lastActiveEventIdRef.current} -> ${nextEventId}. Clearing manual override.`);
          setIsManualOverride(false);
        }
        lastActiveEventIdRef.current = nextEventId;
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
                body: `${cleanEventTitle(currentEvent.summary, true)} starts ${timeLabel}`,
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
      const targetMac = status.address.toUpperCase();
      if (initializedConnectionMacsRef.current.has(targetMac)) return;
      if (pushingRef.current) return;
      initializedConnectionMacsRef.current.add(targetMac);
      initializingConnectionRef.current = true;
      setIsManualOverride(false);
      isManualOverrideRef.current = false;

      const pushDefaultOrActive = async () => {
        // 1. Check if hardware slot 1 (Default Preset, slot 2 in UI) is synced to this sign's hardware
        const def = presets.find(p => p.isDefault);
        const isDefaultSynced = localStorage.getItem('loy_hw_default_synced_' + targetMac);
        if (def && !isDefaultSynced) {
          console.log("[connect] Pushing local default preset to new sign default slot (slot 1)...");
          try {
            setPushing(true);
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
            if (e.response?.status === 409) throw e;
          } finally {
            setPushing(false);
          }
        }

        // 2. Calendar Slot (hardware slot 0, slot 1 in UI)
        let evs = events;
        if (!evs || evs.length === 0) {
          try {
            evs = await fetchEvents();
          } catch (e) {}
        }

        const activeEvents = (evs || []).filter(ev => isEventInWindow(ev, new Date()) && ev.response_status?.toLowerCase() !== 'declined');
        const active = activeEvents.sort((a, b) => new Date(b.start_iso) - new Date(a.start_iso))[0];

        if (active) {
          const activeStr = getEventDisplayString(active);
          console.log("[connect] Pushing active event on connect to slot 0:", active.summary);
          await handlePush(activeStr, false, true, `event-${active.id}-${activeStr}`);
          localStorage.setItem('loy_hw_cal_synced_' + targetMac, 'true');
        } else {
          // Calendar slot 0 is sign-specific. Without an active event, never
          // seed it from another sign's cached calendar preset.
          const savedLastPushedId = localStorage.getItem(`loy_last_pushed_id_${targetMac}`);
          if (savedLastPushedId && savedLastPushedId !== 'hw-slot-1') {
            console.log(`[connect] Resuming previously pushed preset: ${savedLastPushedId}`);
            setLastPushedId(savedLastPushedId);
            if (savedLastPushedId.startsWith('hw-slot-')) {
              const slotNum = parseInt(savedLastPushedId.replace('hw-slot-', ''), 10);
              if (!isNaN(slotNum)) {
                try {
                  await axios.post(`${API_BASE}/preset?id=${slotNum}&mac=${encodeURIComponent(targetMac)}`);
                } catch (e) {
                  console.warn(`[connect] Failed to resume slot ${slotNum}:`, e);
                }
              }
            }
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
      pushDefaultOrActive().catch(e => {
        if (e.response?.status === 409) initializedConnectionMacsRef.current.delete(targetMac);
        handleSetPushMessage(`Error: ${e.message}`);
      }).finally(() => {
        initializingConnectionRef.current = false;
        fetchStatus();
        if (!isModalOpenRef.current && !scanOpenRef.current) {
          setPresetView('saved');
        }
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
    const isPayloadEvent = typeof payload === 'string' || Boolean(payload?.text?.includes('|||'));
    if ((pushingRef.current || isSignUpdatingRef.current) && !skipMessages) {
      if (isPayloadEvent && manual) {
        handleSetPushMessage('Sign is currently updating. Please wait...');
      }
      return;
    }
    pushingRef.current = true;
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
      setPushingPresetTarget({
        type: 'local',
        id: data.id,
        isDefault: Boolean(data.isDefault)
      });
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
        if (status.connected && manual) {
          setPresetView('saved');
        }
        if (status.connected) {
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
            const isCurrentlyPlaying = (lastPushedId === 'hw-slot-0') || (status?.display_mode === 'preset-0');
            const saveRes = await savePresetToSign({
              slot_id: 0,
              address: targetMac,
              preset: eventPresetCopy,
              is_currently_playing: isCurrentlyPlaying
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
          } catch (saveErr) {
            console.warn('[push-event] Saved preset to slot 0 error:', saveErr);
            handleSetPushMessage(`Error saving to Slot 1: ${saveErr.response?.data?.detail || saveErr.message}`);
            throw saveErr;
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
      pushingRef.current = false;
      setPushing(false);
      setPushingPresetTarget(null);
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
          <div 
            className="px-3 py-1.5 bg-red-500/20 text-red-400 rounded-full border border-red-500/20 animate-pulse"
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <span>⚠</span>
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
              connectionTarget={connectionTarget}
              connectionError={connectionError}
              onDisconnect={handleDisconnect}
              onBeginChooseSign={() => {
                autoConnectTried.current = true;
                choosingSignRef.current = true;
                return axios.post(`${API_BASE}/pause-reconnect`).catch(() => {});
              }}
              isConnecting={isSignConnecting}
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
              pushingRef={pushingRef}
              pushingPresetTarget={pushingPresetTarget}
              setPushingPresetTarget={setPushingPresetTarget}
              scanOpen={scanOpen}
              setScanOpen={setScanOpen}
              passcodeTarget={passcodeTarget}
              bluetoothPasscode={bluetoothPasscode}
              setBluetoothPasscode={setBluetoothPasscode}
              passcodeError={passcodeError}
              setPasscodeError={setPasscodeError}
              onSubmitPasscode={submitBluetoothPasscode}
              onClosePasscode={() => { setPasscodeTarget(null); setBluetoothPasscode(''); setPasscodeError(''); }}
              setSessionPasscode={setSessionPasscode}
              clearSessionPasscode={clearSessionPasscode}
              syncHardwareSlots={syncHardwareSlots}
              fetchStatus={fetchStatus}
              presetView={presetView}
              setPresetView={setPresetView}
              slotSaveProgress={slotSaveProgress}
              setSlotSaveProgress={setSlotSaveProgress}
              slotSavePhase={slotSavePhase}
              setSlotSavePhase={setSlotSavePhase}
              isSignUpdating={isSignUpdating}
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
            pushingRef={pushingRef}
            pushingPresetTarget={pushingPresetTarget}
            setPushingPresetTarget={setPushingPresetTarget}
            savedPresets={savedPresets}
            setSavedPresets={setSavedPresets}
            syncHardwareSlots={syncHardwareSlots}
            lastPushedId={lastPushedId}
            setLastPushedId={setLastPushedId}
            presetView={presetView}
            setPresetView={setPresetView}
            isConnecting={isSignConnecting}
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
            isSignUpdating={isSignUpdating}
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
function DashboardView({ status, power, setPower, brightness, setBrightness, speed, setSpeed, macAddress, onMacInput, onMacBlur, onConnect, onDisconnect, onBeginChooseSign, isConnecting, connectionTarget, connectionError, onClear, isModalOpen, onPush, connectionFailed, apiError, deviceNames, setDeviceName, previewStamp, lastPushedId, setLastPushedId, setIsManualOverride, presets, savedPresets, setSavedPresets, savedDraggedIdx, setSavedDraggedIdx, savedDragOverIdx, setSavedDragOverIdx, now, pushMessage, setPushMessage, pushing, setPushing, pushingRef, pushingPresetTarget, setPushingPresetTarget, scanOpen, setScanOpen, passcodeTarget, bluetoothPasscode, setBluetoothPasscode, passcodeError, setPasscodeError, onSubmitPasscode, onClosePasscode, setSessionPasscode, clearSessionPasscode, syncHardwareSlots, fetchStatus, presetView, setPresetView, slotSaveProgress, setSlotSaveProgress, slotSavePhase, setSlotSavePhase, isSignUpdating }) {
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
  const [scanFailed, setScanFailed] = useState(false);
  const [scanSearch, setScanSearch] = useState('');
  const [scanPage, setScanPage] = useState(0);
  const [nameEditValue, setNameEditValue] = useState('');
  const [passwordSettingsOpen, setPasswordSettingsOpen] = useState(false);
  const [passwordEnabled, setPasswordEnabled] = useState(null);
  const [passwordStatusLoading, setPasswordStatusLoading] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [recoveryContact, setRecoveryContact] = useState('');
  const [passwordSettingsError, setPasswordSettingsError] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

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

  useEffect(() => {
    if (!status.connected) setPasswordSettingsOpen(false);
  }, [status.connected]);
  const openPasswordSettings = async () => {
    setPasswordSettingsError('');
    setNameEditValue(deviceNames[status.address?.toUpperCase()] || defaultDisplayName || '');
    const knownStatus = status.password_enabled;
    setPasswordEnabled(typeof knownStatus === 'boolean' ? knownStatus : null);
    setPasswordStatusLoading(typeof knownStatus !== 'boolean');
    setPasswordSettingsOpen(true);
    if (typeof knownStatus === 'boolean') return;
    try {
      const response = await axios.get(`${API_BASE}/sign-password`);
      setPasswordEnabled(typeof response.data.enabled === 'boolean' ? response.data.enabled : null);
    } catch (error) {
      setPasswordSettingsError(error.response?.status === 405
        ? 'Please restart the LED Sign app to load the updated passcode settings backend.'
        : (error.response?.data?.detail || 'Please try again: could not read the sign passcode setting.'));
    } finally {
      setPasswordStatusLoading(false);
    }
  };
  const [assigningSlotIndex, setAssigningSlotIndex] = useState(null);
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

  const [brightnessDragging, setBrightnessDragging] = useState(false);
  // The slider works in percent (7–100; the sign's 15 levels map to ~7–100%).
  const [brightnessRaw, setBrightnessRaw] = useState(() => {
    const savedPct = parseFloat(localStorage.getItem('loy_brightness_pct'));
    if (savedPct >= 7 && savedPct <= 100 && Math.max(1, Math.min(15, Math.round(savedPct * 15 / 100))) === brightness) return savedPct;
    return Math.max(7, Math.min(100, Math.round(brightness * 100 / 15)));
  });
  useEffect(() => {
    try { localStorage.setItem('loy_brightness_pct', String(brightnessRaw)); } catch (e) {}
  }, [brightnessRaw]);

  useEffect(() => {
    if (!brightnessDragging) return;
    const stop = () => setBrightnessDragging(false);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [brightnessDragging]);

  const brightnessRailRef = useRef(null);
  useEffect(() => {
    const rail = brightnessRailRef.current;
    if (!rail) return;
    const preventPageScroll = (e) => {
      if (status?.connected && !pushing && !isConnecting) {
        e.preventDefault();
      }
    };
    rail.addEventListener('wheel', preventPageScroll, { passive: false });
    return () => rail.removeEventListener('wheel', preventPageScroll);
  }, [status?.connected, pushing, isConnecting]);

  const onBrightnessChange = async (rawPct) => {
    if (pushingRef?.current || pushing) return;
    // Magnetic snap to 25% / 50% / 75% inside a small window; the lowest and
    // highest values are the slider's own ends. Everything between stays selectable.
    const snapPoints = [25, 50, 75];
    const near = snapPoints.find(p => Math.abs(p - rawPct) <= 1.5);
    const shown = Math.max(7, Math.min(100, near !== undefined ? near : rawPct));
    setBrightnessRaw(shown);
    const finalVal = Math.max(1, Math.min(15, Math.round(shown * 15 / 100)));
    if (finalVal === brightness) return;
    setBrightness(finalVal);
    try { await axios.post(`${API_BASE}/brightness?level=${finalVal}`); } catch (e) {}
  };

  const onSpeedChange = async (val) => {
    setSpeed(val);
    try { await axios.post(`${API_BASE}/speed?level=${val}`); } catch (e) {}
  };

  const startScan = async (forcedTab) => {
    if (forcedTab) setScanTab(forcedTab);
    setScanPage(0);
    setIsScanning(true);
    setScanFailed(false);
    setScanResults([]);
    try {
      const res = await axios.get(`${API_BASE}/scan`, { timeout: 30000 });
      setScanResults(res.data.filter(d => d.is_led));
    } catch (e) {
      console.error("Scan error or timeout:", e);
      setScanFailed(true);
    }
    setIsScanning(false);
  };

  const handleScanOpen = async () => {
    await onBeginChooseSign();
    onClosePasscode();
    setScanOpen(true);
    setScanSearch('');
    setScanPage(0);
    startScan();
  };

  const handleConnectOrScan = () => {
    handleScanOpen();
  };

  const closeScanPopup = () => {
    onClosePasscode();
    setScanOpen(false);
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (assigningSlotIndex !== null) {
          e.preventDefault();
          setAssigningSlotIndex(null);
        } else if (passwordSettingsOpen) {
          e.preventDefault();
          setPasswordSettingsOpen(false);
        } else if (scanOpen) {
          e.preventDefault();
          closeScanPopup();
        }
        return;
      }

      if (e.key === 'Tab') {
        if (scanOpen || passwordSettingsOpen || assigningSlotIndex !== null || isModalOpen) {
          return;
        }

        const targetTag = e.target?.tagName?.toLowerCase();
        const isInputFocused = (targetTag === 'input' && e.target?.type !== 'range') || targetTag === 'textarea' || e.target?.isContentEditable;
        if (isInputFocused) return;

        e.preventDefault();
        if (e.repeat) return;

        if (presetView === 'saved') {
          setPresetView('local');
        } else if (presetView === 'local') {
          if (status?.connected && !isSignUpdating) {
            setPresetView('saved');
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [scanOpen, passwordSettingsOpen, assigningSlotIndex, isModalOpen, isSignUpdating, presetView, status?.connected, setPresetView, onClosePasscode]);

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
    setIsManualOverride(false);
    setLastPushedId(null);
    onMacInput(addr);
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
    if (pushingRef?.current || pushing) return;
    if (pushingRef) pushingRef.current = true;
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
      if (typeof setPushingPresetTarget === 'function') {
        setPushingPresetTarget({
          type: 'saved',
          globalIdx,
          hwSlotId,
          id: preset.id || `saved-clock-${globalIdx}`,
          isDefault: false
        });
      }
      setPushing(true);
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
      } finally {
        if (pushingRef) pushingRef.current = false;
        setPushing(false);
        if (typeof setPushingPresetTarget === 'function') setPushingPresetTarget(null);
      }
      return;
    }

    const presetCopy = { ...preset };
    if (presetCopy.mode === 'text') {
      delete presetCopy.pixels;
    }

    if (globalIdx >= 12) {
      if (typeof setPushingPresetTarget === 'function') {
        setPushingPresetTarget({
          type: 'saved',
          globalIdx,
          id: presetCopy.id || `saved-${Date.now()}-${globalIdx}`,
          isDefault: false
        });
      }
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
        if (pushingRef) pushingRef.current = false;
        setPushing(false);
        if (typeof setPushingPresetTarget === 'function') setPushingPresetTarget(null);
      }
      return;
    }

    const slotObjForPush = savedPresets[globalIdx];
    const hwSlotIdForPush = slotObjForPush?.hwSlotId !== undefined 
      ? slotObjForPush.hwSlotId 
      : (slotObjForPush?.slotNumber ? slotObjForPush.slotNumber - 1 : globalIdx);
    if (typeof setPushingPresetTarget === 'function') {
      setPushingPresetTarget({
        type: 'saved',
        globalIdx,
        hwSlotId: hwSlotIdForPush,
        id: presetCopy.id,
        isDefault: Boolean(globalIdx === 1 || hwSlotIdForPush === 1 || presetCopy.isDefault)
      });
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

      const isCurrentlyPlaying = (lastPushedId === `hw-slot-${hwSlotId}`) || 
        (lastPushedId === `preset-${hwSlotId}`) || 
        (lastPushedId && slotObj?.preset?.id && lastPushedId === slotObj.preset.id) || 
        (status?.display_mode === `preset-${hwSlotId}`);
      const res = await savePresetToSign({
        slot_id: hwSlotId,
        address: status.address || DEFAULT_MAC,
        preset: presetForUpload,
        progress_id: progressId,
        is_currently_playing: isCurrentlyPlaying
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
      if (pushingRef) pushingRef.current = false;
      setPushing(false);
      if (typeof setPushingPresetTarget === 'function') setPushingPresetTarget(null);
    }
  };

  const playSavedPreset = async (globalIdx, preset) => {
    if (pushingRef?.current || pushing || isSignUpdating) return;
    if (!preset) return; // Do nothing when clicking empty slots!
    if (pushingRef) pushingRef.current = true;

    if (preset.mode === 'clock' || preset.id === 'clock-default') {
      if (typeof setPushingPresetTarget === 'function') {
        setPushingPresetTarget({
          type: 'saved',
          globalIdx,
          id: preset.id || `saved-clock-${globalIdx}`,
          isDefault: false
        });
      }
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
        if (pushingRef) pushingRef.current = false;
        setPushing(false);
        if (typeof setPushingPresetTarget === 'function') setPushingPresetTarget(null);
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

    if (typeof setPushingPresetTarget === 'function') {
      setPushingPresetTarget({
        type: 'saved',
        globalIdx,
        hwSlotId,
        id: preset.id || `hw-slot-${hwSlotId}`,
        isDefault: Boolean(globalIdx === 1 || hwSlotId === 1 || preset.isDefault)
      });
    }
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
      if (pushingRef) pushingRef.current = false;
      setPushing(false);
      if (typeof setPushingPresetTarget === 'function') setPushingPresetTarget(null);
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
    if (pushingRef?.current || pushing) return;
    if (pushingRef) pushingRef.current = true;
    try {
      await onPush(p, true, true);
    } catch (err) {
      console.error('[push] Failed:', err);
      throw err;
    } finally {
      if (pushingRef) pushingRef.current = false;
    }
  };

  const dragStartPos = useRef({ x: 0, y: 0, time: 0 });
  const handlePointerDown = (e) => {
    if (pushingRef?.current || pushing) return;
    dragStartPos.current = { 
      x: e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0), 
      y: e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : 0), 
      time: Date.now() 
    };
  };
  const handlePointerUp = (e, callback) => {
    if (pushingRef?.current || pushing) {
      dragStartPos.current = null;
      return;
    }
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

  return (
    <div className="flex flex-col items-center">
      <div className="dashboard-hero">
        {/* Power btn — top aligned */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div 
            onClick={isConnecting ? undefined : togglePower} 
            className={`power-btn ${power ? 'on' : 'off'} ${(!status.connected || isConnecting) ? 'disabled' : ''}`} 
            style={{ 
              cursor: (!status.connected || isConnecting) ? 'not-allowed' : 'pointer',
              pointerEvents: 'auto'
            }}
            title={isConnecting ? "Sign is connecting..." : (!status.connected ? "Connect to a sign to control power" : (power ? 'Turn Off' : 'Turn On'))}
          >
            <Power size={26} />
          </div>
          <div 
            onClick={() => {
              if (isConnecting || pushingRef?.current || pushing) return;
              const defPreset = (presets || []).find(p => p.isDefault);
              if (defPreset && status?.connected) {
                setIsManualOverride(true);
                pushPreset(defPreset);
              }
            }} 
            className={`power-btn off ${(!status.connected || pushing || isConnecting) ? 'disabled' : ''}`} 
            style={{ 
              background: 'rgba(255, 255, 255, 0.04)', 
              border: '1px solid rgba(255,255,255,0.08)', 
              color: '#f8fafc', 
              opacity: (status.connected && !pushing && !isConnecting) ? 1 : 0.2, 
              pointerEvents: 'auto',
              cursor: (!status.connected || pushing || isConnecting) ? 'not-allowed' : 'pointer'
            }} 
            title={isConnecting ? "Sign is connecting..." : (!status.connected ? "Connect to a sign to trigger default preset" : "Trigger Default Preset")} 
            onMouseOver={e => { 
              if (!status.connected || pushing || isConnecting) return;
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)'; 
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)'; 
              e.currentTarget.style.transform = 'scale(1.05)'; 
            }} 
            onMouseOut={e => { 
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)'; 
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)'; 
              e.currentTarget.style.transform = 'none'; 
            }}
          >
            <img src="https://static.thenounproject.com/png/5507757-200.png" alt="Default" width="34" height="34" style={{ filter: 'invert(100%)', opacity: (status.connected && !isConnecting) ? 0.9 : 0.4 }} />
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
                <>
                  <img
                    ref={previewRef}
                    src={`${API_BASE}${status.preview_url}?t=${previewStamp}`}
                    className={`${status.width && status.width > 64 ? "scrolling-preview" : "static-preview"} ${isLoaded ? 'loaded' : ''}`}
                    style={status.width && status.width > 64 ? { '--scroll-duration': `${((64 + status.width) * Math.max(10, 80 - (activePreset?.speed !== undefined ? activePreset.speed : (status?.speed !== undefined ? status.speed : speed)) * 5)) / 1000}s` } : {}}
                    onLoad={() => setIsLoaded(true)}
                    onError={() => setIsLoaded(true)}
                  />
                  {!isLoaded && (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000000', zIndex: 5 }}>
                      <RefreshCw size={26} className="animate-spin text-violet-400" />
                    </div>
                  )}
                </>
              ) : (
                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000000' }}>
                  <RefreshCw size={26} className="animate-spin text-violet-400" />
                </div>
              )
            ) : (
              <div style={{width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: '12px'}}>
                Disconnected
              </div>
            )}

            {Boolean(pushing && pushingPresetTarget) && (
              <div
                className="preview-push-overlay"
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'rgba(0, 0, 0, 0.4)',
                  backdropFilter: 'blur(2px)',
                  WebkitBackdropFilter: 'blur(2px)',
                  zIndex: 20,
                  pointerEvents: 'none',
                  borderRadius: 'inherit'
                }}
              >
                <RefreshCw size={28} className="animate-spin text-white" aria-label="Pushing to sign" style={{ color: '#ffffff' }} />
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
            <div 
              ref={brightnessRailRef}
              className="brightness-rail glass-panel" 
              onClick={(e) => {
                const input = e.currentTarget.querySelector('input[type="range"]');
                if (input && status.connected && !pushing && !isConnecting) input.focus();
              }}
              onWheel={(e) => {
                if (!status.connected || pushing || isConnecting) return;
                const dir = e.deltaY < 0 ? 1 : -1;
                const step = e.shiftKey ? 10 : 2;
                onBrightnessChange(Math.max(7, Math.min(100, Math.round(brightnessRaw) + dir * step)));
              }}
              style={{ 
                opacity: status.connected ? (pushing || isConnecting ? 0.5 : 1) : 0.2, 
                pointerEvents: 'auto', 
                cursor: (!status.connected || pushing || isConnecting) ? 'not-allowed' : 'default',
                padding: '12px 16px', 
                flex: 1 
              }}
              title={isConnecting ? "Sign is connecting..." : (!status.connected ? "Connect to a sign to adjust brightness" : undefined)}
            >
              <Sun className="text-amber-400 flex-shrink-0" size={17} />
              <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex', alignItems: 'center' }}>
                <div aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, pointerEvents: 'none', opacity: brightnessDragging ? 1 : 0, transition: 'opacity 0.15s ease' }}>
                  {[25, 50, 75].map(v => (
                    <span key={v} style={{
                      position: 'absolute',
                      left: `calc(8px + (100% - 16px) * ${(v - 7) / 93})`,
                      top: '50%',
                      width: '2px',
                      height: '12px',
                      marginLeft: '-1px',
                      marginTop: '-6px',
                      borderRadius: '1px',
                      background: 'rgba(255, 255, 255, 0.28)'
                    }} />
                  ))}
                </div>
                <input 
                  type="range" min="7" max="100" step="0.5"
                  tabIndex={0}
                  value={brightnessRaw}
                  onPointerDown={(e) => {
                    e.currentTarget.focus();
                    setBrightnessDragging(true);
                  }}
                  onMouseDown={(e) => e.currentTarget.focus()}
                  onClick={(e) => e.currentTarget.focus()}
                  onKeyDown={(e) => {
                    const isArrowKey = ['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'].includes(e.key);
                    const isPlusKey = e.key === '+' || e.key === '=' || e.code === 'NumpadAdd';
                    const isMinusKey = e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract';

                    if (isArrowKey || isPlusKey || isMinusKey) {
                      e.preventDefault();
                      e.stopPropagation();
                      const dir = (e.key === 'ArrowLeft' || e.key === 'ArrowDown' || isMinusKey) ? -1 : 1;
                      const step = e.shiftKey ? 10 : 5;
                      onBrightnessChange(Math.max(7, Math.min(100, Math.round(brightnessRaw) + dir * step)));
                    }
                  }}
                  onChange={(e) => onBrightnessChange(parseFloat(e.target.value))} 
                  className="brightness-slider" 
                  style={{ position: 'relative', width: '100%', outline: 'none', boxShadow: 'none', '--fill': `calc(8px + (100% - 16px) * ${(brightnessRaw - 7) / 93})`, cursor: (!status.connected || pushing || isConnecting) ? 'not-allowed' : 'pointer' }}
                  disabled={!status.connected || pushing || isConnecting}
                  title={isConnecting ? "Sign is connecting..." : undefined}
                />
              </div>
              <span className="font-bold text-slate-500 text-[10px] text-right flex-shrink-0" style={{ width: '36px', minWidth: '36px', maxWidth: '36px', fontVariantNumeric: 'tabular-nums', display: 'inline-block' }}>{Math.round(brightnessRaw)}%</span>
            </div>
          </div>
        </div>
      </div>

      {/* Connection row */}
      <div className="connection-row" style={{ position: 'relative' }}>
        {status.connected ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button 
                className="btn-disconnect" 
                style={{ height: '42px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onClick={onDisconnect}
              >
                <Link2Off size={16} /> Disconnect
              </button>
              <div
                title={isConnecting ? "Sign is connecting..." : "Change sign"}
                style={{ display: 'inline-flex', cursor: isConnecting ? 'not-allowed' : 'pointer' }}
              >
                <button
                  className="btn-styled flex items-center justify-center"
                  disabled={isConnecting}
                  style={{
                    height: '42px',
                    width: '42px',
                    padding: 0,
                    backgroundRepeat: 'no-repeat',
                    backgroundOrigin: 'border-box',
                    backgroundClip: 'padding-box',
                    border: 'none',
                    outline: 'none',
                    opacity: isConnecting ? 0.4 : 1,
                    cursor: isConnecting ? 'not-allowed' : 'pointer',
                    pointerEvents: isConnecting ? 'none' : 'auto'
                  }}
                  onClick={isConnecting ? undefined : handleScanOpen}
                >
                  <Search size={15} />
                </button>
              </div>
            </div>
            <div 
              className="mac-display cursor-pointer group" 
              onClick={() => openPasswordSettings()} 
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '12px',
                height: '42px',
                padding: '0 18px',
                boxSizing: 'border-box',
                cursor: 'pointer'
              }}
              title="Sign settings"
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 1 }}>{deviceNames[status.address?.toUpperCase()] || defaultDisplayName}</span>
              <Settings size={14} className="text-slate-400 group-hover:text-white transition-colors" style={{ display: 'block', flexShrink: 0 }} />
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button 
              className="btn-styled flex items-center justify-center gap-2" 
              style={{
                whiteSpace: 'nowrap',
                minWidth: '140px',
                height: '42px',
                padding: '0 18px',
                backgroundRepeat: 'no-repeat',
                backgroundOrigin: 'border-box',
                backgroundClip: 'padding-box',
                border: 'none',
                outline: 'none',
                overflow: 'hidden',
              }} 
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
            <div
              title={isConnecting ? "Sign is connecting..." : "Change sign"}
              style={{ display: 'inline-flex', cursor: isConnecting ? 'not-allowed' : 'pointer' }}
            >
              <button
                className="btn-styled flex items-center justify-center"
                style={{
                  height: '42px',
                  width: '42px',
                  padding: 0,
                  backgroundRepeat: 'no-repeat',
                  backgroundOrigin: 'border-box',
                  backgroundClip: 'padding-box',
                  border: 'none',
                  outline: 'none',
                  overflow: 'hidden',
                  opacity: isConnecting ? 0.4 : 1,
                  cursor: isConnecting ? 'not-allowed' : 'pointer',
                  pointerEvents: isConnecting ? 'none' : 'auto'
                }}
                disabled={isConnecting}
                onClick={isConnecting ? undefined : handleScanOpen}
              >
                <Search size={15} />
              </button>
            </div>
            {connectionFailed && !isConnecting && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                fontSize: '11px', color: '#f87171', fontWeight: 600,
                background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.25)',
                borderRadius: '8px', padding: '6px 10px', whiteSpace: 'nowrap'
              }}>
                <span>⚠</span>
                <span>{apiError ? 'Server Offline' : 'Connection failed — power cycle the sign and retry'}</span>
              </div>
            )}
          </div>
        )}

        {/* Scan popup — floats above, doesn't push layout */}
        <AnimatePresence>
          {scanOpen && (
            <>
              {/* Backdrop to close on click outside */}
              <div className="fixed inset-0 z-40" onClick={closeScanPopup} />
              
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className="scan-popup glass-panel z-50"
              >
                <div className="scan-popup-header">
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {!passcodeTarget && isScanning && <RefreshCw size={12} className="animate-spin text-violet-400" aria-label="Scanning for signs" />}
                    <span className="text-xs font-bold uppercase tracking-widest text-slate-400">
                      {passcodeTarget ? 'Enter Passcode' : isScanning ? 'Scanning...' : scanTab === 'recents' ? 'Recent Devices' : 'Nearby Devices'}
                    </span>
                  </div>
                  <button 
                    onClick={closeScanPopup}
                    className="modal-close-btn"
                    style={{ marginLeft: 16 }}
                    title="Close scan"
                  >
                    <X size={24} />
                  </button>
                </div>

                {passcodeTarget ? (
                  <form className="scan-passcode-form" onSubmit={onSubmitPasscode}>
                    <p className="scan-passcode-description">
                      Please enter the sign's password to connect.
                    </p>
                    <input
                      autoFocus
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={bluetoothPasscode}
                      onChange={(event) => { setBluetoothPasscode(event.target.value.replace(/\D/g, '').slice(0, 6)); setPasscodeError(''); }}
                      aria-label="Six-digit Bluetooth Passcode"
                      className="scan-passcode-input"
                    />
                    {passcodeError && <p role="alert" className="scan-passcode-error">{passcodeError}</p>}
                    <p className="scan-passcode-recovery">
                      Forgot your Passcode? Open LOY SPACE from the{' '}
                      <a href="https://apps.apple.com/app/loy-space/id1636648229" target="_blank" rel="noopener noreferrer">App Store</a>
                      {' '}or{' '}
                      <a href="https://play.google.com/store/apps/details?id=com.yskd.loywf" target="_blank" rel="noopener noreferrer">Google Play</a>,
                      select this sign, and tap Retrieve Password.
                    </p>
                    <div className="scan-passcode-actions">
                      <button type="button" className="btn-styled inactive" onClick={onClosePasscode}>
                        Back
                      </button>
                      <button type="submit" className="btn-styled scan-passcode-connect" disabled={isConnecting}>
                        {isConnecting && <RefreshCw size={12} className="animate-spin" aria-hidden="true" />}
                        <span>{isConnecting ? 'Connecting...' : 'Connect'}</span>
                      </button>
                    </div>
                  </form>
                ) : (<>
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
                    const availabilityLabel = isScanning ? 'Checking' : 'Not Found';
                    
                    return (
                      <div 
                        key={dev.address} 
                        className="scan-item"
                        aria-disabled={!isAvailable}
                        title={!isAvailable ? (isScanning ? 'Checking for this sign...' : 'Not found in the latest scan. Please scan again to connect.') : undefined}
                        style={!isAvailable ? {
                          opacity: 0.55,
                          filter: 'grayscale(100%)',
                          cursor: 'not-allowed'
                        } : {
                          cursor: 'pointer'
                        }}
                        onClick={() => {
                          if (isAvailable) pickDevice(dev.address, rawName);
                        }}
                      >
                        <div className="scan-item-main">
                          <div className="scan-item-heading" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
                            <p className="scan-item-name font-bold text-sm text-slate-100" style={!isAvailable ? { color: '#94a3b8' } : {}}>
                              {displayName}
                            </p>
                            {connectionTarget?.toLowerCase() === dev.address?.toLowerCase() ? (
                              <span className="scan-item-status" style={{ fontSize: '10px', padding: '1px 7px', borderRadius: '999px', background: 'rgba(34,197,94,0.15)', color: '#4ade80', border: '1px solid rgba(34,197,94,0.3)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}><RefreshCw size={11} className="animate-spin" />Connecting</span>
                            ) : isConnected ? (
                              <span className="scan-item-status" style={{ fontSize: '10px', padding: '1px 7px', borderRadius: '999px', background: 'rgba(34,197,94,0.15)', color: '#4ade80', border: '1px solid rgba(34,197,94,0.3)', fontWeight: 600 }}>
                                Connected
                              </span>
                            ) : isAvailable ? (
                              <span className="scan-item-status" style={{ fontSize: '10px', padding: '1px 7px', borderRadius: '999px', background: 'rgba(56,189,248,0.15)', color: '#38bdf8', border: '1px solid rgba(56,189,248,0.3)', fontWeight: 600 }}>
                                Available
                              </span>
                            ) : (
                              <span className="scan-item-status" style={{ fontSize: '10px', padding: '1px 7px', borderRadius: '999px', background: 'rgba(255,255,255,0.06)', color: '#94a3b8', border: '1px solid rgba(255,255,255,0.1)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                {isScanning && <RefreshCw size={11} className="animate-spin" />}{availabilityLabel}
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
                {connectionError && <p role="alert" style={{ margin: '4px 2px', color: '#fca5a5', fontSize: 11 }}>{connectionError}</p>}

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
                </>)}
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
              <div
                title={isConnecting ? "Sign is connecting..." : (!status.connected ? 'Connect to a sign to view saved presets' : (isSignUpdating ? 'Sign is updating...' : 'View saved sign presets'))}
                style={{ display: 'inline-flex', cursor: (status.connected && !isSignUpdating && !isConnecting) ? 'default' : 'not-allowed' }}
              >
                <button
                  role="tab"
                  aria-selected={presetView === 'saved'}
                  disabled={!status.connected || isSignUpdating || isConnecting}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => status.connected && !isSignUpdating && !isConnecting && setPresetView('saved')}
                  className={`btn-styled ${presetView === 'saved' && status.connected ? '' : 'inactive'}`}
                  style={{ 
                    height: 34, 
                    padding: '0 14px', 
                    fontSize: 14, 
                    opacity: (status.connected && !isSignUpdating && !isConnecting) ? 1 : 0.4, 
                    cursor: (status.connected && !isSignUpdating && !isConnecting) ? 'pointer' : 'not-allowed', 
                    display: 'inline-flex', 
                    alignItems: 'center', 
                    gap: 6,
                    pointerEvents: (!status.connected || isSignUpdating || isConnecting) ? 'none' : 'auto'
                  }}
                >
                  <Save size={14} />
                  <span>Saved</span>
                </button>
              </div>
              <button
                role="tab"
                aria-selected={presetView === 'local'}
                disabled={false}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setPresetView('local')}
                className={`btn-styled ${presetView === 'local' ? '' : 'inactive'}`}
                style={{
                  height: 34,
                  padding: '0 14px',
                  fontSize: 14,
                  opacity: 1,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6
                }}
                title="View local presets"
              >
                <Laptop size={14} />
                <span>Local</span>
              </button>
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
                        className={`preset-card empty-slot relative transition-all cursor-pointer ${isReserved ? 'preset-card-reserved' : ''} ${globalIdx === savedDragOverIdx ? 'preset-card-drag-target' : ''}`}
                        style={{
                          '--reserved-color': reservedColor,
                          opacity: pushing ? (isReserved ? 0.4 : 0.3) : (isReserved ? 0.7 : 1),
                          cursor: pushing ? 'not-allowed' : 'pointer',
                          pointerEvents: pushing ? 'none' : undefined,
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
                          (pushing && pushingPresetTarget && pushingPresetTarget.type === 'saved' && pushingPresetTarget.globalIdx === globalIdx) ? (
                            <div
                              className="preview-push-overlay"
                              style={{
                                position: 'absolute',
                                inset: 0,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: 'rgba(0, 0, 0, 0.4)',
                                backdropFilter: 'blur(2px)',
                                WebkitBackdropFilter: 'blur(2px)',
                                zIndex: 20,
                                pointerEvents: 'auto',
                                cursor: 'wait',
                                borderRadius: 'inherit'
                              }}
                            >
                              <RefreshCw size={24} className="animate-spin text-white" aria-label="Pushing to sign" style={{ color: '#ffffff' }} />
                            </div>
                          ) : (
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
                          )
                        )}
                      </div>
                    );
                  }

                  return (
                    <div
                      key={slot.hwSlotId !== undefined ? `hw-${slot.hwSlotId}` : `slot-${slot.slotNumber || globalIdx}`}
                      className={`preset-card relative group overflow-hidden transition-all ${isReserved ? 'preset-card-reserved' : ''} ${globalIdx === savedDragOverIdx ? 'preset-card-drag-target' : ''}`}
                      onPointerDown={handlePointerDown}
                      onPointerUp={(e) => handlePointerUp(e, () => playSavedPreset(globalIdx, p))}
                      draggable={!isReserved}
                      onDragStart={!isReserved ? (e) => {
                        e.dataTransfer.setData('text/plain', `saved-slot:${globalIdx}`);
                        e.dataTransfer.effectAllowed = 'move';
                        setSavedDraggedIdx(globalIdx);
                        document.body.classList.add('preset-dragging');
                      } : undefined}
                      onDragEnd={!isReserved ? () => {
                        setSavedDraggedIdx(null);
                        setSavedDragOverIdx(null);
                        document.body.classList.remove('preset-dragging');
                      } : undefined}
                      onDragOver={!isReserved ? (e) => { e.preventDefault(); setSavedDragOverIdx(globalIdx); } : undefined}
                      onDragLeave={!isReserved ? () => setSavedDragOverIdx(null) : undefined}
                      onDrop={!isReserved ? (e) => handleDropOnSlot(e, globalIdx) : undefined}
                      title={isSignUpdating ? 'Sign is updating...' : undefined}
                      style={{
                        '--reserved-color': reservedColor,
                        cursor: isSignUpdating ? 'not-allowed' : (isReserved ? 'pointer' : 'grab'),
                        opacity: globalIdx === savedDraggedIdx ? 0.4 : (isSignUpdating && !(pushingPresetTarget && ((pushingPresetTarget.type === 'saved' && pushingPresetTarget.globalIdx === globalIdx) || (isReservedDefault && pushingPresetTarget.isDefault))) ? 0.6 : 1),
                        transform: globalIdx === savedDraggedIdx ? 'scale(0.98)' : 'none',
                        boxShadow: globalIdx === savedDragOverIdx ? 'var(--neon-shadow)' : undefined,
                        pointerEvents: (isSignUpdating && !(pushingPresetTarget && ((pushingPresetTarget.type === 'saved' && pushingPresetTarget.globalIdx === globalIdx) || (isReservedDefault && pushingPresetTarget.isDefault)))) ? 'none' : undefined,
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

                      {(pushing && pushingPresetTarget && (
                        (pushingPresetTarget.type === 'saved' && pushingPresetTarget.globalIdx === globalIdx) ||
                        (isReservedDefault && pushingPresetTarget.isDefault)
                      )) ? (
                        <div
                          className="preview-push-overlay"
                          style={{
                            position: 'absolute',
                            inset: 0,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: 'rgba(0, 0, 0, 0.4)',
                            backdropFilter: 'blur(2px)',
                            WebkitBackdropFilter: 'blur(2px)',
                            zIndex: 20,
                            pointerEvents: 'auto',
                            cursor: 'wait',
                            borderRadius: 'inherit'
                          }}
                        >
                          <RefreshCw size={24} className="animate-spin text-white" aria-label="Pushing to sign" style={{ color: '#ffffff' }} />
                        </div>
                      ) : (
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
                      )}
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
                          disabled={pushing}
                          onMouseOver={e => {
                            if (pushing) return;
                            e.currentTarget.style.background = 'rgba(239, 68, 68, 0.2)';
                          }}
                          onMouseOut={e => {
                            if (pushing) return;
                            e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)';
                          }}
                          className="btn-disconnect flex items-center"
                          style={{
                            padding: '4px 12px',
                            fontSize: '12px',
                            height: '32px',
                            background: 'rgba(239, 68, 68, 0.1)',
                            border: '1px solid rgba(239, 68, 68, 0.2)',
                            color: '#ef4444',
                            whiteSpace: 'nowrap',
                            opacity: pushing ? 0.45 : 1,
                            cursor: pushing ? 'not-allowed' : 'pointer'
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
      {passwordSettingsOpen && createPortal(
        <div 
          style={{ position: 'fixed', inset: 0, zIndex: 10000, display: 'grid', placeItems: 'center', padding: 20, background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)' }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setPasswordSettingsOpen(false);
          }}
        >
          <form className="glass-panel" style={{ width: 'min(100%, 420px)', padding: 26 }} onSubmit={async (event) => {
            event.preventDefault();
            setPasswordSettingsError('');
            if (status.address) {
              setDeviceName(status.address, nameEditValue.trim());
            }
            if (passwordEnabled === true) {
              if (!/^\d{6}$/.test(newPassword) || newPassword !== confirmPassword) {
                setPasswordSettingsError('Please enter matching six-digit passcodes.');
                return;
              }
              const recoveryValue = recoveryContact.trim();
              const normalizedPhone = recoveryValue.replace(/[\s().-]/g, '');
              const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(recoveryValue);
              const validPhone = /^\+?[1-9]\d{6,14}$/.test(normalizedPhone);
              if (!(validEmail || validPhone)) {
                setPasswordSettingsError('Please enter a valid recovery email address or phone number.');
                return;
              }
            }
            if (passwordEnabled !== null) {
              setSavingPassword(true);
              try {
                await axios.put(`${API_BASE}/sign-password`, {
                  enabled: passwordEnabled,
                  ...(passwordEnabled ? { passcode: newPassword, recovery_contact: recoveryContact.trim() } : {})
                });
                const currentAddr = status?.address || macAddress;
                if (passwordEnabled) {
                  if (typeof setSessionPasscode === 'function') setSessionPasscode(currentAddr, newPassword);
                  setBluetoothPasscode(newPassword);
                } else {
                  if (typeof clearSessionPasscode === 'function') clearSessionPasscode(currentAddr);
                  setBluetoothPasscode('');
                }
                if (typeof fetchStatus === 'function') await fetchStatus();
              } catch (error) {
                setPasswordSettingsError(error.response?.data?.detail || error.message);
                return;
              } finally {
                setSavingPassword(false);
              }
            }
            setPasswordSettingsOpen(false);
            setNewPassword('');
            setConfirmPassword('');
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: 19 }}>Settings</h3>
              <button 
                type="button" 
                onClick={() => setPasswordSettingsOpen(false)} 
                style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', display: 'grid', placeItems: 'center', padding: 0 }} 
                onMouseOver={e => e.currentTarget.style.color='#fff'} 
                onMouseOut={e => e.currentTarget.style.color='#64748b'}
              >
                <X size={24} />
              </button>
            </div>

            {/* Sign Name input above the require passcode toggle */}
            <div style={{ marginTop: '20px', marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
                Sign Name
              </label>
              <input
                className="input-field"
                style={{ width: '100%', fontSize: '13px', padding: '10px 14px' }}
                value={nameEditValue}
                placeholder="Enter sign name…"
                onChange={e => setNameEditValue(e.target.value)}
              />
            </div>

            <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '0 0 14px', fontSize: 14, cursor: passwordEnabled === null ? 'not-allowed' : 'pointer', opacity: passwordEnabled === null ? 0.6 : 1, userSelect: 'none' }}>
              <input type="checkbox" checked={passwordEnabled === true} disabled={passwordEnabled === null} onChange={e => setPasswordEnabled(e.target.checked)} style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }} />
              <span style={{ width: 18, height: 18, borderRadius: 6, background: passwordEnabled ? 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))' : 'rgba(255, 255, 255, 0.08)', border: passwordEnabled ? '1px solid rgba(255, 255, 255, 0.3)' : '1px solid rgba(255, 255, 255, 0.2)', boxShadow: passwordEnabled ? '0 0 10px rgba(139, 92, 246, 0.45)' : 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', flexShrink: 0 }}>
                {passwordEnabled && <Check size={13} strokeWidth={3.5} />}
              </span>
              Require passcode
            </label>
            {passwordEnabled === null && <p role="status" style={{ color: '#94a3b8', fontSize: 12, marginTop: -5, display: 'flex', alignItems: 'center', gap: 6 }}>{passwordStatusLoading && <RefreshCw size={12} className="animate-spin" aria-label="Checking passcode status" />}{passwordStatusLoading ? 'Reading passcode status from sign…' : 'Passcode status unavailable from sign.'}</p>}
            {passwordEnabled && <>
              <input className="input-field" inputMode="numeric" maxLength={6} placeholder="New six-digit passcode" value={newPassword} onChange={e => setNewPassword(e.target.value.replace(/\D/g, '').slice(0, 6))} style={{ width: '100%', marginBottom: 10 }} />
              <input className="input-field" inputMode="numeric" maxLength={6} placeholder="Confirm passcode" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value.replace(/\D/g, '').slice(0, 6))} style={{ width: '100%', marginBottom: 10 }} />
              <input className="input-field" type="text" placeholder="Recovery email or phone" value={recoveryContact} onChange={e => setRecoveryContact(e.target.value)} style={{ width: '100%' }} />
            </>}
            {passwordSettingsError && <p role="alert" style={{ color: '#fca5a5', fontSize: 12, marginTop: 10 }}>{passwordSettingsError}</p>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <button 
                type="submit" 
                className="btn-styled" 
                style={{ width: 40, height: 38, padding: 0, display: 'grid', placeItems: 'center' }} 
                disabled={savingPassword} 
                title="Save settings"
              >
                <Save size={16} className={savingPassword ? 'animate-pulse' : ''} />
              </button>
            </div>
          </form>
        </div>, document.body
      )}
    </div>
  );
}

/* ─── Calendar ───────────────────────────────────────────────────────── */
function CalendarView({ status, events, loading, fetchEvents, now, onPush, pushMessage, pushing, cleanName, setCleanName, isSignUpdating }) {
  const [calError, setCalError] = useState('');

  useEffect(() => {
    // Clear error if we successfully fetched events
    if (status.calendar_connected && events?.length > 0) {
      setCalError('');
    }
  }, [status.calendar_connected, events]);


  const [signingIn, setSigningIn] = useState(false);

  const handleSignIn = async () => {
    if (signingIn) return;
    setSigningIn(true);
    setCalError('');
    try {
      const res = await axios.get(`${API_BASE}/auth/url`);
      window.open(res.data.url, '_blank');
    } catch (e) {
      setCalError(e.response?.data?.detail || e.message);
    } finally {
      setTimeout(() => setSigningIn(false), 2500);
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
              <button 
                onClick={async () => { await axios.post(`${API_BASE}/auth/logout`); window.location.reload(); }} 
                className="btn-styled inactive" 
                style={{ padding: '6px 12px', fontSize: 12, marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <LogOut size={13} />
                <span>Sign out</span>
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
            style={{ 
              fontSize: '13px', 
              fontWeight: 700, 
              color: '#cbd5e1', 
              cursor: 'pointer', 
              display: 'flex', 
              alignItems: 'center', 
              gap: '8px',
              userSelect: 'none'
            }}
            onClick={() => {
              const val = !cleanName;
              setCleanName(val);
              localStorage.setItem('loy_clean_name', val.toString());
              setTimeout(() => fetchEvents(), 0);
            }}
          >
            <div
              style={{
                width: '18px',
                height: '18px',
                borderRadius: '6px',
                background: cleanName 
                  ? 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))' 
                  : 'rgba(255, 255, 255, 0.08)',
                border: cleanName 
                  ? '1px solid rgba(255, 255, 255, 0.3)' 
                  : '1px solid rgba(255, 255, 255, 0.2)',
                boxShadow: cleanName ? '0 0 10px rgba(139, 92, 246, 0.45)' : 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.2s ease',
                color: '#ffffff',
                flexShrink: 0
              }}
            >
              {cleanName && <Check size={13} strokeWidth={3.5} />}
            </div>
            <span>
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
            disabled={signingIn}
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
              cursor: signingIn ? 'not-allowed' : 'pointer',
              opacity: signingIn ? 0.7 : 1,
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
            {signingIn ? 'Connecting...' : 'Sign in with Google'}
          </button>
        </div>
      ) : events?.length === 0 ? (
        <div className="glass-panel w-full" style={{ padding: '48px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
          <p className="text-slate-400">No events scheduled today.</p>
        </div>
      ) : (
        <div className="w-full grid grid-cols-1 gap-4">
          {events?.map((ev, i) => (
            <EventCard
              key={i}
              ev={ev}
              now={now}
              onPush={onPush}
              cleanName={cleanName}
              isSignUpdating={isSignUpdating}
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

function EventCard({ ev, now, onPush, cleanName, isSignUpdating }) {
  const isClean = cleanName !== false;
  const timeStr = formatEventTime(ev);
  const rawSummary = ev?.summary || 'Untitled Event';
  const summary = cleanEventTitle(rawSummary, isClean);
  const isDeclined = ev?.response_status?.toLowerCase() === 'declined' || summary.toLowerCase().includes('[declined]');
  const isActive = isEventActive(ev, now);

  const handleCardClick = (e) => {
    if (isSignUpdating) return;
    // If the click was on the link (title/time), don't push
    if (e.target.closest('a')) return;
    const displayStr = getEventDisplayString(ev, isClean);
    onPush(displayStr, true);
  };

  return (
    <div
      className="glass-panel transition-all group"
      onClick={handleCardClick}
      title={isSignUpdating ? 'Sign is updating...' : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: isActive && !isDeclined ? '15px 21px' : '14px 20px',
        cursor: isSignUpdating ? 'not-allowed' : (isDeclined ? 'default' : 'pointer'),
        opacity: isDeclined ? 0.5 : (isSignUpdating ? 0.55 : 1),
        filter: isDeclined ? 'grayscale(0.8)' : 'none',
        position: 'relative',
        overflow: 'hidden',
        ...(isActive && !isDeclined ? {
          background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
          backgroundRepeat: 'no-repeat',
          backgroundOrigin: 'border-box',
          backgroundClip: 'padding-box',
          border: 'none',
          outline: 'none',
          boxShadow: isSignUpdating ? 'none' : 'var(--neon-shadow)',
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

function HslColorSlider({ label, value, onChange, disabled = false }) {
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
    if (disabled) return;
    const val = e.target.value;
    setLocalHex(val);
    if (isValidHex(val)) {
      onChange(normalizeHex(val));
    }
  };

  const handleHexBlur = () => {
    if (disabled) return;
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
    if (disabled) return;
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', opacity: disabled ? 0.45 : 1, pointerEvents: disabled ? 'none' : 'auto', cursor: disabled ? 'not-allowed' : 'default' }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '12px', flexWrap: 'nowrap', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '10px', fontWeight: 'bold', color: '#64748b', textTransform: 'uppercase', whiteSpace: 'nowrap', marginLeft: '4px' }}>{label}</span>
        
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
          <input 
            type="text"
            value={localHex}
            disabled={disabled}
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
              fontFamily: 'monospace',
              cursor: disabled ? 'not-allowed' : 'text'
            }}
          />
          <button
            type="button"
            disabled={disabled}
            onClick={disabled ? undefined : handlePickColor}
            title={disabled ? undefined : "Pick color from screen"}
            style={{
              width: '24px',
              height: '24px',
              borderRadius: '6px',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: disabled ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s ease',
              color: '#94a3b8',
              flexShrink: 0
            }}
            onMouseOver={e => {
              if (disabled) return;
              e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)';
              e.currentTarget.style.color = '#ffffff';
            }}
            onMouseOut={e => {
              if (disabled) return;
              e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
              e.currentTarget.style.color = '#94a3b8';
            }}
          >
            <Pipette size={12} />
          </button>
          <div 
            onClick={disabled ? undefined : () => colorInputRef.current?.click()}
            style={{
              width: '32px',
              height: '18px',
              borderRadius: '99px',
              background: value,
              boxShadow: `0 0 8px ${value}`,
              border: '2px solid rgba(255,255,255,0.2)',
              transition: 'background-color 0.2s, box-shadow 0.2s',
              flexShrink: 0,
              cursor: disabled ? 'not-allowed' : 'pointer'
            }}
            title={disabled ? undefined : "Click to open color selector"}
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
            cursor: disabled ? 'not-allowed' : 'pointer',
            border: 'none',
            boxShadow: 'none',
            overflow: 'hidden'
          }}
          onMouseDown={disabled ? undefined : (e) => {
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
        onChange={(e) => !disabled && onChange(e.target.value)}
        disabled={disabled}
        style={{ display: 'none' }}
      />
    </div>
  );
}

/* ─── Media ──────────────────────────────────────────────────────────── */
function MediaView({ status, isModalOpen, setIsModalOpen, presets, setPresets, onPush, onPushSuccess, now, pushMessage, setPushMessage, setLocalPushMessage, setUnifiedPushMessage, pushing, setPushing, pushingRef, pushingPresetTarget, setPushingPresetTarget, savedPresets, setSavedPresets, syncHardwareSlots, lastPushedId, setLastPushedId, presetView, setPresetView, isConnecting }) {
  const fontReady = useFontReady();
  const [draggedId, setDraggedId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);

  const dragStartPos = useRef({ x: 0, y: 0, time: 0 });
  const handlePointerDown = (e) => {
    if (pushingRef?.current || pushing) return;
    dragStartPos.current = { 
      x: e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0), 
      y: e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : 0), 
      time: Date.now() 
    };
  };
  const handlePointerUp = (e, callback) => {
    if (pushingRef?.current || pushing) {
      dragStartPos.current = null;
      return;
    }
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
    document.body.classList.add('preset-dragging');
  };

  const syncDefaultPresetToSavedSlot = async (defaultPreset) => {
    // A new local default invalidates every sign's previous slot-1 upload.
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('loy_hw_default_synced_')) localStorage.removeItem(key);
    }
    const presetForSign = { ...defaultPreset };
    if (presetForSign.mode === 'text') delete presetForSign.pixels;
    setSavedPresets(prev => {
      const next = [...prev];
      next[1] = {
        slotNumber: 2,
        hwSlotId: 1,
        preset: { ...defaultPreset, id: 'hw-slot-1', hwSlotId: 1 }
      };
      return next;
    });
    if (!status?.connected) return;

    setPresetView('saved');
    setPushing(true, { type: 'local', id: defaultPreset.id, isDefault: true });
    setPushMessage('Saving default to Slot 2...');
    try {
      const isCurrentlyPlaying = lastPushedId === 'hw-slot-1' || status.display_mode === 'preset-1';
      const response = await savePresetToSign({
        slot_id: 1,
        address: status.address || DEFAULT_MAC,
        preset: presetForSign,
        is_currently_playing: isCurrentlyPlaying
      });
      const thumbnail = response.data?.preview_url
        ? `${API_BASE}${response.data.preview_url}?t=${Date.now()}`
        : defaultPreset.thumbnail;
      setSavedPresets(prev => {
        const next = [...prev];
        next[1] = {
          slotNumber: 2,
          hwSlotId: 1,
          preset: { ...defaultPreset, id: 'hw-slot-1', hwSlotId: 1, thumbnail }
        };
        return next;
      });
      localStorage.setItem('loy_hw_default_synced_' + status.address.toUpperCase(), 'true');
      setLastPushedId('hw-slot-1');
      setPushMessage('Saved to Slot 2!');
      syncHardwareSlots();
    } catch (error) {
      console.warn('[preset-save] Failed to save default to hardware slot 1:', error);
      setPushMessage('Error saving default to Slot 2');
    } finally {
      setPushing(false);
    }
  };

  const handleDragOver = (e, id) => {
    if (presets.find(p => p.id === id)?.isDefault) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDragOverId(id);
      return;
    }
    e.preventDefault();
    if (id !== draggedId) {
      setDragOverId(id);
    }
  };

  const handleDrop = async (e, targetId) => {
    e.preventDefault();
    if (presets.find(p => p.id === targetId)?.isDefault) {
      const replacement = presets.find(p => p.id === draggedId);
      if (replacement && !replacement.isDefault) {
        const nextPresets = presets.map(p => ({ ...p, isDefault: p.id === replacement.id }));
        try {
          await savePresetsToDB(nextPresets);
          setPresets(nextPresets);
          await syncDefaultPresetToSavedSlot({ ...replacement, isDefault: true });
        } catch (error) {
          console.error('[preset-default] Could not update local default:', error);
          setPushMessage('Error changing local default preset');
        }
      }
      setDraggedId(null);
      setDragOverId(null);
      return;
    }
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
    document.body.classList.remove('preset-dragging');
  };

  const imageObjRef = useRef(null);
  const initialFormRef = useRef(null);

  const isPresetFormDirty = (cur, init) => {
    if (!init || !cur) return false;
    if (cur.mode !== init.mode) return true;
    if ((cur.name || '') !== (init.name || '')) return true;
    if (Boolean(cur.isDefault) !== Boolean(init.isDefault)) return true;

    if (cur.mode === 'text') {
      if ((cur.text || '') !== (init.text || '')) return true;
      if ((cur.textColor || '#ffffff').toLowerCase() !== (init.textColor || '#ffffff').toLowerCase()) return true;
      if ((cur.bgColor || '#000000').toLowerCase() !== (init.bgColor || '#000000').toLowerCase()) return true;
      if ((cur.animation || 'continuous left shift') !== (init.animation || 'continuous left shift')) return true;
      if (Number(cur.speed ?? 8) !== Number(init.speed ?? 8)) return true;
      if (Number(cur.rotation ?? 0) !== Number(init.rotation ?? 0)) return true;
      return false;
    }

    if (cur.mode === 'drawing') {
      if ((cur.textColor || '#ffffff').toLowerCase() !== (init.textColor || '#ffffff').toLowerCase()) return true;
      if ((cur.bgColor || '#000000').toLowerCase() !== (init.bgColor || '#000000').toLowerCase()) return true;
      const curPixels = Array.isArray(cur.pixels) ? cur.pixels : [];
      const initPixels = Array.isArray(init.pixels) ? init.pixels : [];
      if (curPixels.length !== initPixels.length) return true;
      for (let i = 0; i < curPixels.length; i++) {
        const cp = curPixels[i] || 0;
        const ip = initPixels[i] || 0;
        const normCp = typeof cp === 'string' ? cp.toLowerCase() : cp;
        const normIp = typeof ip === 'string' ? ip.toLowerCase() : ip;
        if (normCp !== normIp) return true;
      }
      return false;
    }

    if (cur.mode === 'clock') {
      if ((cur.timeFormat || '12h') !== (init.timeFormat || '12h')) return true;
      if (Boolean(cur.showSeconds !== false) !== Boolean(init.showSeconds !== false)) return true;
      if ((cur.clockStyle || 'default') !== (init.clockStyle || 'default')) return true;
      return false;
    }

    if (cur.mode === 'image') {
      if (cur.imgSrc !== init.imgSrc) return true;
      if (cur.fileType !== init.fileType) return true;
      if (Math.abs((cur.canvasX || 0) - (init.canvasX || 0)) > 0.01) return true;
      if (Math.abs((cur.canvasY || 0) - (init.canvasY || 0)) > 0.01) return true;
      if (Math.abs((cur.zoom || 1) - (init.zoom || 1)) > 0.001) return true;
      if (cur.dwBase !== init.dwBase) return true;
      if (cur.dhBase !== init.dhBase) return true;
      if ((cur.bgColor || '#000000').toLowerCase() !== (init.bgColor || '#000000').toLowerCase()) return true;
      if (cur.frameDurationMs !== init.frameDurationMs) return true;
      if (cur.speed !== init.speed) return true;

      const curDurations = Array.isArray(cur.frameDurationsMs) ? cur.frameDurationsMs : [];
      const initDurations = Array.isArray(init.frameDurationsMs) ? init.frameDurationsMs : [];
      if (curDurations.length !== initDurations.length) return true;
      for (let i = 0; i < curDurations.length; i++) {
        if (curDurations[i] !== initDurations[i]) return true;
      }
      return false;
    }

    return false;
  };

  // Form State for Modal
  const [editingId, setEditingId] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingMedia, setIsLoadingMedia] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveProgress, setSaveProgress] = useState(null);
  const processedMediaSignatureRef = useRef('');
  const [animDropdownOpen, setAnimDropdownOpen] = useState(false);
  const fileInputRef = useRef(null);
  const mediaLoadIdRef = useRef(0);
  const [showGrid, setShowGrid] = useState(true);
  const [showGuides, setShowGuides] = useState(false);

  const closePresetModal = () => {
    if (isSaving) return;
    setIsModalOpen(false);
    setAnimDropdownOpen(false);
    setEditingId(null);
    setSaveError('');
    initialFormRef.current = null;
  };
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

  const [isAiExpanded, setIsAiExpanded] = useState(false);
  const [aiProvider, setAiProvider] = useState(() => localStorage.getItem('led_ai_provider') || 'gemini');
  const aiGeneratorRef = useRef(null);

  useEffect(() => {
    if (!isModalOpen || form.mode !== 'image') {
      setIsAiExpanded(false);
    }
  }, [isModalOpen, form.mode]);

  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(600);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const handleMediaFile = (file) => {
    if (!file) return;
    setSaveError('');
    setIsLoadingMedia(true);
    const loadId = ++mediaLoadIdRef.current;
    const failMediaLoad = (message) => {
      if (loadId !== mediaLoadIdRef.current) return;
      setIsLoadingMedia(false);
      setSaveError(message);
      if (fileInputRef.current) fileInputRef.current.value = '';
    };
    const finishMediaLoad = (mediaEl, source, fileType) => {
      if (loadId !== mediaLoadIdRef.current) return;
      const width = fileType === 'video' ? mediaEl.videoWidth : mediaEl.width;
      const height = fileType === 'video' ? mediaEl.videoHeight : mediaEl.height;
      if (!width || !height) {
        failMediaLoad('This media has no usable dimensions. Please choose another file.');
        return;
      }
      try {
        imageObjRef.current = mediaEl;
        initializeMediaCrop(mediaEl, source, fileType);
        setIsLoadingMedia(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      } catch (error) {
        failMediaLoad(`Could not load this media: ${error.message}`);
      }
    };

    // Keep the current source intact until the replacement has decoded.
    // A failed replacement must not leave the existing preview unusable.

    const isVideo = file.type.startsWith('video/') || file.name.toLowerCase().endsWith('.mp4') || file.name.toLowerCase().endsWith('.webm');
    const isGif = file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');
    const fileType = isVideo ? 'video' : (isGif ? 'gif' : 'image');

    if (fileType === 'video') {
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.onloadedmetadata = () => {
        finishMediaLoad(video, url, 'video');
        video.play().catch(err => console.log('Video play error:', err));
      };
      video.onerror = () => {
        failMediaLoad('Unsupported video format or corrupt file. Please try MP4/H.264.');
        URL.revokeObjectURL(url);
      };
      video.src = url;
    } else {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          finishMediaLoad(img, reader.result, fileType);
        };
        img.onerror = () => {
          failMediaLoad('Unsupported image format or corrupt file. Please choose another image.');
        };
        img.src = reader.result;
      };
      reader.onerror = () => failMediaLoad('Could not read this file. Please try again.');
      try {
        reader.readAsDataURL(file);
      } catch (error) {
        failMediaLoad(`Could not read this file: ${error.message}`);
      }
    }
  };

  const openMediaFilePicker = () => {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleMediaInputChange = (event) => {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) return;
    setForm(prev => ({ ...prev, mode: 'image' }));
    handleMediaFile(selectedFile);
  };

  useEffect(() => {
    if (!isModalOpen) {
      mediaLoadIdRef.current += 1;
      setIsLoadingMedia(false);
    }
  }, [isModalOpen]);

  // A media file dropped over the preset editor becomes an image/video preset,
  // even while the AI side panel is open. The AI panel handles only drops on
  // its own surface.
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
      setForm(prev => ({ ...prev, mode: 'image' }));
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
    if (!isModalOpen || (form.mode !== 'image' && form.mode !== 'drawing') || !container) return;
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
    
    setForm(prev => ({
      ...prev,
      mode: 'image',
      imgSrc,
      fileType,
      canvasX,
      canvasY,
      zoom,
      dwBase,
      dhBase,
      pixels
    }));
  };

  // Clipboard paste support (CTRL + V)
  useEffect(() => {
    if (!isModalOpen) return;

    const handlePaste = (e) => {
      const activeTag = document.activeElement?.tagName?.toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea') {
        return;
      }

      const items = e.clipboardData?.items;
      if (!items) return;

      const mediaFiles = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type && (items[i].type.startsWith('image/') || items[i].type.startsWith('video/'))) {
          const file = items[i].getAsFile();
          if (file) mediaFiles.push(file);
        }
      }

      if (mediaFiles.length > 0) {
        if (isAiExpanded && aiGeneratorRef.current?.handleAddFiles) {
          e.preventDefault();
          aiGeneratorRef.current.handleAddFiles(mediaFiles);
          return;
        }

        if (form.mode === 'image') {
          e.preventDefault();
          handleMediaFile(mediaFiles[0]);
        }
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [isModalOpen, form.mode, isAiExpanded]);

  // Global arrow key support for cropping and canvas panning (no need to click to focus first)
  useEffect(() => {
    if (!isModalOpen || (form.mode !== 'image' && form.mode !== 'drawing')) return;
    if (form.mode === 'image' && !form.imgSrc) return;

    const handleKeyDown = (e) => {
      // Don't intercept if user is typing in an input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      
      const step = e.shiftKey ? 5 : 1;
      
      if (form.mode === 'image') {
        let newX = form.mediaCanvasX ?? form.canvasX ?? 0;
        let newY = form.mediaCanvasY ?? form.canvasY ?? 0;
        
        if (e.key === 'ArrowUp') newY -= step;
        else if (e.key === 'ArrowDown') newY += step;
        else if (e.key === 'ArrowLeft') newX -= step;
        else if (e.key === 'ArrowRight') newX += step;
        else return;

        e.preventDefault();
        
        if (imageObjRef.current) {
          const currentZoom = form.mediaZoom ?? form.zoom ?? 1;
          const nextPixels = runCropRender(
            imageObjRef.current,
            newX,
            newY,
            (form.dwBase || 64) * currentZoom,
            (form.dhBase || 20) * currentZoom,
            form.bgColor || '#000000'
          );
          setForm(prev => ({ ...prev, canvasX: newX, canvasY: newY, mediaCanvasX: newX, mediaCanvasY: newY, pixels: nextPixels }));
        } else {
          setForm(prev => ({ ...prev, canvasX: newX, canvasY: newY, mediaCanvasX: newX, mediaCanvasY: newY }));
        }
      } else if (form.mode === 'drawing') {
        let newX = form.drawCanvasX || 0;
        let newY = form.drawCanvasY || 0;
        
        if (e.key === 'ArrowUp') newY -= step;
        else if (e.key === 'ArrowDown') newY += step;
        else if (e.key === 'ArrowLeft') newX -= step;
        else if (e.key === 'ArrowRight') newX += step;
        else return;

        e.preventDefault();
        setForm(prev => ({ ...prev, drawCanvasX: newX, drawCanvasY: newY }));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isModalOpen, form.mode, form.imgSrc, form.canvasX, form.canvasY, form.mediaCanvasX, form.mediaCanvasY, form.drawCanvasX, form.drawCanvasY, form.dwBase, form.dhBase, form.zoom, form.mediaZoom, form.bgColor, form.pixels]);

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
  const [isPanActive, setIsPanActive] = useState(false);
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const isSpacePressedRef = useRef(false);
  const isDragActive = isPanActive || isSpacePressed;
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [previewTime, setPreviewTime] = useState(new Date());
  const [scrollOffset, setScrollOffset] = useState(0);

  const editingModeRef = useRef(null);

  // Reset eraser, pan, undo/redo stacks, and editing mode ref on modal toggle
  useEffect(() => {
    setIsEraserActive(false);
    setIsPanActive(false);
    setIsSpacePressed(false);
    isSpacePressedRef.current = false;
    setUndoStack([]);
    setRedoStack([]);
    if (!isModalOpen) {
      editingModeRef.current = null;
    }
  }, [isModalOpen]);

  // Spacebar pan mode support in drawing editor
  useEffect(() => {
    if (!isModalOpen || form.mode !== 'drawing') return;
    const onKeyDown = (e) => {
      const isTextInput = (e.target.tagName === 'INPUT' && e.target.type !== 'range') || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable;
      if (e.code === 'Space' && !isTextInput) {
        e.preventDefault();
        if (!isSpacePressedRef.current) {
          isSpacePressedRef.current = true;
          setIsSpacePressed(true);
        }
        const container = containerRef.current?.classList?.contains('preview-box')
          ? containerRef.current
          : containerRef.current?.querySelector?.('.preview-box');
        if (container) container.style.cursor = 'grab';
      }
    };
    const onKeyUp = (e) => {
      if (e.code === 'Space') {
        isSpacePressedRef.current = false;
        setIsSpacePressed(false);
        const container = containerRef.current?.classList?.contains('preview-box')
          ? containerRef.current
          : containerRef.current?.querySelector?.('.preview-box');
        if (container) container.style.cursor = isPanActive ? 'grab' : 'crosshair';
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [isModalOpen, form.mode, isPanActive]);

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
    if (isSaving || isLoadingMedia) return;
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

      if (form.isDefault) await syncDefaultPresetToSavedSlot(savedPreset);

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
  const hasFormChanges = isPresetFormDirty(form, initialFormRef.current);
  const canSavePreset = !isSaving && !isLoadingMedia && hasRequiredPresetContent && hasFormChanges;

  useEffect(() => {
    if (!isModalOpen) return;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        if (!isSaving) {
          event.preventDefault();
          closePresetModal();
        }
        return;
      }
      if (event.key === 'Enter') {
        if (event.isComposing || event.repeat) return;
        if (event.target?.closest('[data-ai-side-panel]')) return;
        if (event.target?.tagName === 'BUTTON' && event.target?.innerText?.toLowerCase().includes('delete')) return;
        if (canSavePreset) {
          event.preventDefault();
          handleSave();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isModalOpen, isSaving, form, canSavePreset, handleSave]);

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
    if (p.imgSrc) {
      if (fileType === 'video') {
        const video = document.createElement('video');
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.onloadedmetadata = () => {
          imageObjRef.current = video;
        };
        video.src = p.imgSrc;
      } else {
        const img = new Image();
        img.onload = () => {
          imageObjRef.current = img;
        };
        img.src = p.imgSrc;
      }
    } else {
      imageObjRef.current = null;
    }

    const initialForm = {
      ...p,
      fileType,
      pixels: [...normalizedPixels],
      animation: p.animation || 'continuous left shift',
      mediaZoom: p.mediaZoom ?? p.zoom ?? 1,
      mediaCanvasX: p.mediaCanvasX ?? p.canvasX ?? 0,
      mediaCanvasY: p.mediaCanvasY ?? p.canvasY ?? 0,
      mediaPixels: (p.mode === 'image' || p.imgSrc) ? [...(p.pixels || [])] : null,
      drawZoom: p.drawZoom ?? 1,
      drawCanvasX: p.drawCanvasX ?? 0,
      drawCanvasY: p.drawCanvasY ?? 0,
      drawPixels: p.mode === 'drawing' ? [...normalizedPixels] : Array(64 * 20).fill(0)
    };
    initialFormRef.current = initialForm;
    setForm(initialForm);
    setIsModalOpen(true);
  };

  const deletePreset = (id, e) => {
    if (e) e.stopPropagation();
    setPresets(presets.filter(p => p.id !== (id || editingId)));
    if (!id) {
      closePresetModal();
    }
  };

  const canPushLocalPresetDirectly = (preset) => {
    if (!preset) return false;
    if (preset.mode === 'clock' || preset.id === 'clock-default') return true;

    // Multi-frame pixels (> 1280) indicates animation, which must be assigned to hardware
    if (Array.isArray(preset.pixels) && preset.pixels.length > 1280) return false;

    // Animated GIF or video must be assigned to hardware
    if (preset.fileType === 'gif' || preset.fileType === 'video') return false;

    // Animated text must be assigned to hardware; static / show now text is supported directly
    if (preset.mode === 'text' || preset.text) {
      const anim = (preset.animation || '').trim().toLowerCase();
      return anim === 'show now' || anim === 'static' || anim === '';
    }

    if (preset.mode === 'drawing') return true;
    if (preset.mode === 'image') return true;

    // Static pixel preset fallback
    if (Array.isArray(preset.pixels) && preset.pixels.length <= 1280) return true;

    // Static image source
    if (preset.imgSrc && preset.fileType !== 'gif' && preset.fileType !== 'video') return true;

    return false;
  };

  const pushPreset = async (p) => {
    if (pushingRef?.current || pushing) return;
    if (!canPushLocalPresetDirectly(p)) {
      if (typeof setLocalPushMessage === 'function') {
        setLocalPushMessage('Please assign animated text, GIFs, and videos to a Saved Preset before pushing.');
      }
      return;
    }

    if (p.isDefault && status?.connected) {
      if (pushingRef) pushingRef.current = true;
      try {
        if (typeof setPushingPresetTarget === 'function') {
          setPushingPresetTarget({
            type: 'local',
            id: p.id,
            isDefault: true
          });
        }
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
            if (pushingRef) pushingRef.current = false;
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
        if (pushingRef) pushingRef.current = false;
        if (typeof setPushing === 'function') setPushing(false);
        if (typeof setPushingPresetTarget === 'function') setPushingPresetTarget(null);
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
                editingModeRef.current = 'text'; setEditingId(null);
                imageObjRef.current = null;
                const initialForm = {
                  name: '', text: '', textColor: '#ffffff', bgColor: '#000000',
                  animation: 'continuous left shift', speed: 8, rotation: 0,
                  mode: 'text', pixels: Array(64 * 20).fill(0), spacing: 1, views: 1,
                  imgSrc: null, canvasX: 0, canvasY: 0, zoom: 1, dwBase: 64, dhBase: 20,
                  mediaZoom: 1, mediaCanvasX: 0, mediaCanvasY: 0, mediaPixels: null,
                  drawZoom: 1, drawCanvasX: 0, drawCanvasY: 0, drawPixels: Array(64 * 20).fill(0),
                  timeFormat: '12h', showSeconds: true, clockStyle: 'default', isDefault: false
                };
                initialFormRef.current = initialForm;
                setForm(initialForm);
                setIsModalOpen(true);
              }}
            >
              <Plus className="text-emerald-400" size={24} />
              <p className="text-xs font-black text-emerald-500/60 uppercase tracking-widest">Create Preset</p>
            </div>

            {presets
              ?.filter(p => p?.id)
              ?.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0))
              ?.map(p => {
              const isClock = p.mode === 'clock' || p.id === 'clock-default';
              const canPushDirectly = canPushLocalPresetDirectly(p);
              const isThisPresetPushing = pushing && pushingPresetTarget && (
                (pushingPresetTarget.type === 'local' && pushingPresetTarget.id === p.id) ||
                (p.isDefault && pushingPresetTarget.isDefault)
              );
              return (
              <div 
                key={p.id} 
                className={`preset-card relative group overflow-hidden transition-all ${p.isDefault ? 'preset-card-reserved' : ''} ${p.id === dragOverId ? 'preset-card-drag-target' : ''}`}
                draggable={!p.isDefault}
                onDragStart={(e) => handleDragStart(e, p.id)}
                onDragOver={(e) => handleDragOver(e, p.id)}
                onDrop={(e) => handleDrop(e, p.id)}
                onDragEnd={handleDragEnd}
                style={{
                  '--reserved-color': '#facc15',
                  cursor: isThisPresetPushing ? 'wait' : (p.isDefault ? 'default' : (canPushDirectly ? 'grab' : 'pointer')),
                  opacity: p.id === draggedId ? 0.4 : (isConnecting ? 1 : (pushing && !isThisPresetPushing ? 0.8 : 1)),
                  transform: p.id === draggedId ? 'scale(0.98)' : 'none',
                  boxShadow: p.id === dragOverId ? 'var(--neon-shadow)' : 'none',
                  transition: 'all 0.15s ease',
                  userSelect: 'none'
                }}
                onPointerDown={handlePointerDown}
                onPointerUp={(e) => handlePointerUp(e, () => {
                  if (isConnecting) {
                    setLocalPushMessage('Sign is currently connecting. Please wait...');
                    return;
                  }
                  if (pushing) {
                    setLocalPushMessage('Sign is currently updating. Please wait...');
                    return;
                  }
                  if (status?.connected) {
                    pushPreset(p);
                  } else {
                    setLocalPushMessage('Error: Sign is not connected');
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
                {(pushing && pushingPresetTarget && (
                  (pushingPresetTarget.type === 'local' && pushingPresetTarget.id === p.id) ||
                  (p.isDefault && pushingPresetTarget.isDefault)
                )) ? (
                  <div
                    className="preview-push-overlay"
                    style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'rgba(0, 0, 0, 0.4)',
                      backdropFilter: 'blur(2px)',
                      WebkitBackdropFilter: 'blur(2px)',
                      zIndex: 20,
                      pointerEvents: 'auto',
                      cursor: 'wait',
                      borderRadius: 'inherit'
                    }}
                  >
                    <RefreshCw size={24} className="animate-spin text-white" aria-label="Pushing to sign" style={{ color: '#ffffff' }} />
                  </div>
                ) : (
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
                )}
              </div>
              );
            })}
          </div>
        </div>
      )}

      {isModalOpen && createPortal(
        <AnimatePresence>
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', overflow: 'hidden' }}>
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)', cursor: isSaving ? 'not-allowed' : 'default' }}
              onClick={() => !isSaving && closePresetModal()}
            />
            <div 
              style={{ 
                position: 'relative', 
                zIndex: 1, 
                display: 'flex', 
                flexDirection: 'row', 
                alignItems: 'flex-start',
                justifyContent: 'flex-start',
                gap: '16px', 
                width: isAiExpanded && form.mode === 'image' ? '1244px' : '768px',
                maxWidth: 'none',
                maxHeight: '92vh',
                transition: 'max-width 0.3s cubic-bezier(0.16, 1, 0.3, 1)'
              }}
            >
              <motion.div 
                initial={{ scale: 0.9, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.9, opacity: 0, y: 20 }}
                className={`relative glass-panel ${isSaving ? 'media-processing-lock' : ''}`}
                style={{ 
                  position: 'relative', 
                  padding: '32px', 
                  width: '768px',
                  flex: '0 0 768px',
                  overflowY: 'auto', 
                  maxHeight: '92vh',
                  borderRadius: '24px'
                }}
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
                <button 
                  className="modal-close-btn" 
                  disabled={isSaving}
                  onClick={() => !isSaving && closePresetModal()}
                  style={{ opacity: isSaving ? 0.4 : 1, cursor: isSaving ? 'not-allowed' : 'pointer' }}
                  title={isSaving ? undefined : "Close"}
                >
                  <X size={24} />
                </button>
              </div>

              <div style={{ marginBottom: '32px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', width: '100%', opacity: isSaving ? 0.5 : 1, pointerEvents: isSaving ? 'none' : 'auto' }}>
                <div className="preview-stack opacity-100 scale-100" style={{ margin: '0 auto', width: '100%', maxWidth: 'var(--preview-width)' }}>
                  {form.mode === 'image' ? (
                    <>
                      <input 
                        type="file" 
                        ref={fileInputRef} 
                        id="img-upload" 
                        hidden 
                        accept="image/*,video/*"
                        onChange={handleMediaInputChange}
                      />
                      {!form.imgSrc ? (
                        <div 
                          ref={containerRef}
                          onClick={openMediaFilePicker}
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
                            <div className="media-drop-overlay">
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
                            setForm(prev => ({ ...prev, canvasX: newX, canvasY: newY }));
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
                                mediaCanvasX: newCanvasX,
                                mediaCanvasY: newCanvasY,
                                pixels: nextPixels,
                                mediaPixels: nextPixels
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
                              mediaZoom: newZoom,
                              mediaCanvasX: newX,
                              mediaCanvasY: newY,
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
                            frameDurationsMs={form.frameDurationsMs}
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
                            <div className="media-drop-overlay">
                              <Upload size={32} className="animate-bounce mb-2" />
                              <span className="text-sm">Drop to Upload Media</span>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  ) : form.mode === 'drawing' ? (
                    <div 
                      ref={containerRef}
                      className="preview-box"
                      tabIndex={0}
                      style={{ 
                        position: 'relative',
                        width: '100%', 
                        aspectRatio: '64/20', 
                        boxSizing: 'border-box',
                        overflow: 'hidden',
                        backgroundColor: '#000000',
                        userSelect: 'none',
                        overscrollBehavior: 'contain',
                        cursor: isDragActive ? 'grab' : 'crosshair'
                      }}
                      onWheel={(e) => {
                        e.preventDefault();
                        const zoomFactor = e.deltaY < 0 ? 1.05 : 0.95;
                        const currentZoom = form.drawZoom || 1.0;
                        const newZoom = Math.min(Math.max(currentZoom * zoomFactor, 0.1), 10.0);
                        const oldZoom = currentZoom;
                        const oldX = form.drawCanvasX || 0;
                        const oldY = form.drawCanvasY || 0;
                        const newX = 32 - (32 - oldX) * (newZoom / oldZoom);
                        const newY = 10 - (10 - oldY) * (newZoom / oldZoom);
                        setForm(prev => ({ ...prev, drawZoom: newZoom, drawCanvasX: newX, drawCanvasY: newY }));
                      }}
                      onMouseDown={(e) => {
                        const isPan = isDragActive || e.button === 1 || e.button === 2;
                        if (isPan) {
                          e.preventDefault();
                          const container = e.currentTarget;
                          const scale = (container.clientWidth || 512) / 64;
                          const startX = e.clientX;
                          const startY = e.clientY;
                          const initialCanvasX = form.drawCanvasX || 0;
                          const initialCanvasY = form.drawCanvasY || 0;
                          
                          container.style.cursor = 'grabbing';
                          
                          const handleDragMove = (moveEvent) => {
                            const dx = moveEvent.clientX - startX;
                            const dy = moveEvent.clientY - startY;
                            
                            let newCanvasX = initialCanvasX + dx / scale;
                            let newCanvasY = initialCanvasY + dy / scale;
                            
                            const snapThreshold = 2.0;
                            const canvasW = 64 * (form.drawZoom || 1);
                            const canvasH = 20 * (form.drawZoom || 1);
                            
                            if (Math.abs(newCanvasX + canvasW / 2 - 32) < snapThreshold) {
                              newCanvasX = 32 - canvasW / 2;
                            }
                            if (Math.abs(newCanvasY + canvasH / 2 - 10) < snapThreshold) {
                              newCanvasY = 10 - canvasH / 2;
                            }
                            if (Math.abs(newCanvasX) < snapThreshold) newCanvasX = 0;
                            if (Math.abs(newCanvasX + canvasW - 64) < snapThreshold) newCanvasX = 64 - canvasW;
                            if (Math.abs(newCanvasY) < snapThreshold) newCanvasY = 0;
                            if (Math.abs(newCanvasY + canvasH - 20) < snapThreshold) newCanvasY = 20 - canvasH;
                            
                            setForm(prev => ({
                              ...prev,
                              drawCanvasX: newCanvasX,
                              drawCanvasY: newCanvasY
                            }));
                          };
                          
                          const handleDragEnd = () => {
                            container.style.cursor = isDragActive ? 'grab' : 'crosshair';
                            window.removeEventListener('mousemove', handleDragMove);
                            window.removeEventListener('mouseup', handleDragEnd);
                          };
                          
                          window.addEventListener('mousemove', handleDragMove);
                          window.addEventListener('mouseup', handleDragEnd);
                          return;
                        }
                        
                        if (e.button === 0) {
                          setUndoStack(prev => [...prev, [...form.pixels]]);
                          setRedoStack([]);
                        }
                      }}
                      onContextMenu={(e) => e.preventDefault()}
                    >
                      {/* Scalable, pannable drawing matrix */}
                      <div
                        style={{
                          position: 'absolute',
                          left: `${((form.drawCanvasX || 0) / 64) * 100}%`,
                          top: `${((form.drawCanvasY || 0) / 20) * 100}%`,
                          width: `${(form.drawZoom || 1) * 100}%`,
                          height: `${(form.drawZoom || 1) * 100}%`,
                          display: 'grid',
                          gridTemplateColumns: 'repeat(64, 1fr)',
                          gridTemplateRows: 'repeat(20, 1fr)',
                          gap: showGrid ? '1px' : '0px',
                          background: showGrid ? 'rgba(255, 255, 255, 0.08)' : (form.bgColor || '#000000'),
                          boxSizing: 'border-box'
                        }}
                      >
                        {(Array.isArray(form.pixels) ? form.pixels : Array(1280).fill(0)).map((p, i) => {
                          const activeColor = form.textColor || '#ffffff';
                          return (
                            <div 
                              key={i} 
                              onMouseDown={(e) => {
                                const isPan = isDragActive || e.button === 1 || e.button === 2;
                                if (isPan) return;
                                if (e.button !== 0) return;
                                e.preventDefault();
                                const next = [...form.pixels];
                                const currentColor = form.textColor || '#ffffff';
                                if (isEraserActive) {
                                  next[i] = 0;
                                } else {
                                  next[i] = next[i] === currentColor ? 0 : currentColor;
                                }
                                setForm(prev => ({ ...prev, pixels: next, drawPixels: next }));
                              }}
                              onMouseEnter={(e) => {
                                const isPan = isDragActive;
                                if (isPan || form.mode !== 'drawing' || e.buttons !== 1) return;
                                const next = [...form.pixels];
                                const currentColor = form.textColor || '#ffffff';
                                if (isEraserActive) {
                                  next[i] = 0;
                                } else {
                                  next[i] = currentColor;
                                }
                                setForm(prev => ({ ...prev, pixels: next, drawPixels: next }));
                              }}
                              onDragStart={(e) => e.preventDefault()}
                              style={{ 
                                background: (p && p !== 0 ? (typeof p === 'string' && p.startsWith('#') ? p : activeColor) : (form.bgColor || '#000000')),
                                cursor: isDragActive ? 'inherit' : 'crosshair',
                                userSelect: 'none'
                              }}
                            />
                          );
                        })}
                      </div>

                      {/* Photoshop-style Centering Guides */}
                      {showGuides && (() => {
                        const canvasW = 64 * (form.drawZoom || 1);
                        const canvasH = 20 * (form.drawZoom || 1);
                        const isHCenter = Math.abs(((form.drawCanvasX || 0) + canvasW / 2) - 32) < 0.35;
                        const isVCenter = Math.abs(((form.drawCanvasY || 0) + canvasH / 2) - 10) < 0.35;
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
                        disabled={isSaving}
                        onClick={() => { if (isSaving) return; editingModeRef.current = 'text'; setForm({...form, mode: 'text'}); }}
                        className={`btn-styled text-[10px] px-4 py-1.5 rounded-full transition-all ${form.mode !== 'text' ? 'inactive' : ''}`}
                        style={{ fontSize: 10, fontWeight: 900, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', opacity: isSaving ? 0.45 : undefined, cursor: isSaving ? 'not-allowed' : 'pointer' }}
                      >
                        <Type size={12} />
                        <span>TEXT</span>
                      </button>
                      <button 
                        disabled={isSaving}
                        onClick={() => {
                          if (isSaving) return;
                          editingModeRef.current = 'drawing';
                          setIsPanActive(false);
                          if (form.mode !== 'drawing') {
                            setForm(prev => {
                              const originalPreset = presets?.find(pr => pr.id === editingId);
                              const isOriginalDrawing = originalPreset && originalPreset.mode === 'drawing';
                              
                              let nextPixels;
                              if (prev.drawPixels && Array.isArray(prev.drawPixels) && prev.drawPixels.length === 1280) {
                                nextPixels = prev.drawPixels;
                              } else if (isOriginalDrawing) {
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
                              
                              return { 
                                ...prev, 
                                mode: 'drawing', 
                                mediaPixels: prev.mode === 'image' ? prev.pixels : prev.mediaPixels,
                                pixels: normalized 
                              };
                            });
                          }
                        }}
                        className={`btn-styled text-[10px] px-4 py-1.5 rounded-full transition-all ${form.mode !== 'drawing' ? 'inactive' : ''}`}
                        style={{ fontSize: 10, fontWeight: 900, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', opacity: isSaving ? 0.45 : undefined, cursor: isSaving ? 'not-allowed' : 'pointer' }}
                      >
                        <Pencil size={12} />
                        <span>DRAW</span>
                      </button>
                      <button 
                        disabled={isSaving}
                        onClick={() => { 
                          if (isSaving) return;
                          editingModeRef.current = 'image'; 
                          setForm(prev => {
                            const originalPreset = presets?.find(pr => pr.id === editingId);
                            const originalImgSrc = (originalPreset && (originalPreset.mode === 'image' || originalPreset.imgSrc)) ? originalPreset.imgSrc : null;
                            const targetImgSrc = prev.imgSrc || originalImgSrc;
                            const restoredZoom = prev.mediaZoom ?? 1;
                            const restoredX = prev.mediaCanvasX ?? 0;
                            const restoredY = prev.mediaCanvasY ?? 0;
                            
                            let nextPixels = prev.mediaPixels;
                            if (!nextPixels && originalPreset && (originalPreset.mode === 'image' || originalPreset.imgSrc) && originalPreset.pixels) {
                              nextPixels = originalPreset.pixels;
                            }
                            if (!nextPixels) {
                              if (targetImgSrc && imageObjRef.current) {
                                nextPixels = runCropRender(
                                  imageObjRef.current,
                                  restoredX,
                                  restoredY,
                                  (prev.dwBase || 64) * restoredZoom,
                                  (prev.dhBase || 20) * restoredZoom,
                                  prev.bgColor || '#000000'
                                );
                              } else {
                                nextPixels = Array(64 * 20).fill(0);
                              }
                            }
                            return {
                              ...prev,
                              mode: 'image',
                              zoom: restoredZoom,
                              canvasX: restoredX,
                              canvasY: restoredY,
                              drawPixels: prev.mode === 'drawing' ? prev.pixels : prev.drawPixels,
                              pixels: nextPixels
                            };
                          }); 
                        }}
                        className={`btn-styled text-[10px] px-4 py-1.5 rounded-full transition-all ${form.mode !== 'image' ? 'inactive' : ''}`}
                        style={{ fontSize: 10, fontWeight: 900, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', opacity: isSaving ? 0.45 : undefined, cursor: isSaving ? 'not-allowed' : 'pointer' }}
                      >
                        <ImageIcon size={12} />
                        <span>MEDIA</span>
                      </button>
                      <button 
                        disabled={isSaving}
                        onClick={() => { if (isSaving) return; editingModeRef.current = 'clock'; setForm({...form, mode: 'clock'}); }}
                        className={`btn-styled text-[10px] px-4 py-1.5 rounded-full transition-all ${form.mode !== 'clock' ? 'inactive' : ''}`}
                        style={{ fontSize: 10, fontWeight: 900, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', opacity: isSaving ? 0.45 : undefined, cursor: isSaving ? 'not-allowed' : 'pointer' }}
                      >
                        <Clock size={12} />
                        <span>CLOCK</span>
                      </button>
                    </div>
                    
                    {/* Default Toggle */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingRight: '4px', paddingTop: '12px', paddingBottom: '12px', opacity: isSaving ? 0.45 : 1, pointerEvents: isSaving ? 'none' : 'auto' }}>
                      <div 
                        onClick={() => !isSaving && setForm(prev => ({ ...prev, isDefault: !prev.isDefault }))}
                        style={{ 
                          fontSize: '13px', 
                          fontWeight: 700, 
                          color: '#cbd5e1', 
                          cursor: isSaving ? 'not-allowed' : 'pointer', 
                          display: 'flex', 
                          alignItems: 'center', 
                          gap: '8px',
                          userSelect: 'none'
                        }}
                      >
                        <div
                          style={{
                            width: '18px',
                            height: '18px',
                            borderRadius: '6px',
                            background: form.isDefault 
                              ? 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))' 
                              : 'rgba(255, 255, 255, 0.08)',
                            border: form.isDefault 
                              ? '1px solid rgba(255, 255, 255, 0.3)' 
                              : '1px solid rgba(255, 255, 255, 0.2)',
                            boxShadow: form.isDefault ? '0 0 10px rgba(139, 92, 246, 0.45)' : 'none',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            transition: 'all 0.2s ease',
                            color: '#ffffff',
                            flexShrink: 0
                          }}
                        >
                          {form.isDefault && <Check size={13} strokeWidth={3.5} />}
                        </div>
                        <span>Use as Default</span>
                      </div>
                    </div>
                  </div>

                  {form.mode === 'drawing' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '16px' }}>
                      {/* Action Buttons Row */}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          {/* Clear Canvas */}
                          <button
                            type="button"
                            disabled={isSaving}
                            onClick={() => {
                              if (isSaving) return;
                              setUndoStack(prev => [...prev, [...form.pixels]]);
                              setRedoStack([]);
                              setForm(prev => ({ ...prev, pixels: Array(64 * 20).fill(0), drawPixels: Array(64 * 20).fill(0) }));
                            }}
                            className="btn-styled text-[10px] px-3 py-2 flex items-center justify-center gap-1.5"
                            style={{ borderRadius: '12px', opacity: isSaving ? 0.35 : 1, cursor: isSaving ? 'not-allowed' : 'pointer', pointerEvents: isSaving ? 'none' : 'auto' }}
                            title={isSaving ? undefined : "Clear Canvas"}
                          >
                            <img src="https://static.thenounproject.com/png/5507757-200.png" alt="Clear" width="13" height="13" style={{ width: '13px', height: '13px', objectFit: 'contain', display: 'block', filter: isSaving ? 'invert(50%)' : 'invert(100%)', opacity: isSaving ? 0.35 : 1.0 }} />
                          </button>

                          {/* Eraser Tool */}
                          <button
                            type="button"
                            disabled={isSaving}
                            onClick={() => {
                              if (isSaving) return;
                              setIsEraserActive(prev => !prev);
                              if (!isEraserActive) setIsPanActive(false);
                            }}
                            className={`btn-styled text-[10px] px-3 py-2 flex items-center justify-center gap-1.5 ${!isEraserActive ? 'inactive' : ''}`}
                            style={{ borderRadius: '12px', opacity: isSaving ? 0.35 : 1, cursor: isSaving ? 'not-allowed' : 'pointer', pointerEvents: isSaving ? 'none' : 'auto' }}
                            title={isSaving ? undefined : "Eraser Tool"}
                          >
                            <Eraser size={13} />
                          </button>

                          {/* Undo Button */}
                          <button
                            type="button"
                            disabled={undoStack.length === 0 || isSaving}
                            onClick={() => {
                              if (undoStack.length === 0 || isSaving) return;
                              const previous = undoStack[undoStack.length - 1];
                              setUndoStack(undoStack.slice(0, -1));
                              setRedoStack(prev => [...prev, [...form.pixels]]);
                              setForm(prev => ({ ...prev, pixels: previous, drawPixels: previous }));
                            }}
                            className={`btn-styled text-[10px] px-3 py-2 flex items-center justify-center gap-1.5 ${undoStack.length === 0 ? 'inactive' : ''}`}
                            style={{ borderRadius: '12px', opacity: (undoStack.length > 0 && !isSaving) ? 1 : 0.35, cursor: (undoStack.length > 0 && !isSaving) ? 'pointer' : 'not-allowed', pointerEvents: isSaving ? 'none' : 'auto' }}
                            title={isSaving ? undefined : "Undo"}
                          >
                            <Undo2 size={13} />
                          </button>

                          {/* Redo Button */}
                          <button
                            type="button"
                            disabled={redoStack.length === 0 || isSaving}
                            onClick={() => {
                              if (redoStack.length === 0 || isSaving) return;
                              const next = redoStack[redoStack.length - 1];
                              setRedoStack(redoStack.slice(0, -1));
                              setUndoStack(prev => [...prev, [...form.pixels]]);
                              setForm(prev => ({ ...prev, pixels: next, drawPixels: next }));
                            }}
                            className={`btn-styled text-[10px] px-3 py-2 flex items-center justify-center gap-1.5 ${redoStack.length === 0 ? 'inactive' : ''}`}
                            style={{ borderRadius: '12px', opacity: (redoStack.length > 0 && !isSaving) ? 1 : 0.35, cursor: (redoStack.length > 0 && !isSaving) ? 'pointer' : 'not-allowed', pointerEvents: isSaving ? 'none' : 'auto' }}
                            title={isSaving ? undefined : "Redo"}
                          >
                            <Redo2 size={13} />
                          </button>
                        </div>

                        {/* Visual Tools (Drag canvas, Pixel matrix, Centering Guides) */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          {/* Drag / Draw Canvas Button */}
                          <button
                            type="button"
                            disabled={isSaving}
                            onClick={() => {
                              if (isSaving) return;
                              setIsPanActive(prev => !prev);
                              if (!isPanActive) setIsEraserActive(false);
                            }}
                            className={`btn-styled text-[10px] px-3 py-2 flex items-center justify-center gap-1.5 ${!isDragActive ? 'inactive' : ''}`}
                            style={{ borderRadius: '12px', opacity: isSaving ? 0.35 : 1, cursor: isSaving ? 'not-allowed' : 'pointer', pointerEvents: isSaving ? 'none' : 'auto' }}
                            title={isSaving ? undefined : (isDragActive ? "Draw mode" : "Drag canvas")}
                          >
                            {isDragActive ? <Hand size={13} /> : <Pencil size={13} />}
                          </button>

                          {/* Toggle Pixel Matrix Grid Button */}
                          <button
                            type="button"
                            disabled={isSaving}
                            onClick={() => !isSaving && setShowGrid(prev => !prev)}
                            className={`btn-styled text-[10px] px-3 py-2 flex items-center justify-center gap-1.5 ${!showGrid ? 'inactive' : ''}`}
                            style={{ borderRadius: '12px', opacity: isSaving ? 0.35 : 1, cursor: isSaving ? 'not-allowed' : 'pointer', pointerEvents: isSaving ? 'none' : 'auto' }}
                            title={isSaving ? undefined : "Toggle pixel matrix grid"}
                          >
                            <Grid3X3 size={13} />
                          </button>

                          {/* Toggle Centering Guides Button */}
                          <button
                            type="button"
                            disabled={isSaving}
                            onClick={() => !isSaving && setShowGuides(prev => !prev)}
                            className={`btn-styled text-[10px] px-3 py-2 flex items-center justify-center gap-1.5 ${!showGuides ? 'inactive' : ''}`}
                            style={{ borderRadius: '12px', opacity: isSaving ? 0.35 : 1, cursor: isSaving ? 'not-allowed' : 'pointer', pointerEvents: isSaving ? 'none' : 'auto' }}
                            title={isSaving ? undefined : "Toggle centering guides"}
                          >
                            <ScanLine size={13} />
                          </button>
                        </div>
                      </div>

                      {/* Nested controls container to match Media spacing */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '4px' }}>
                        {/* Zoom Slider Rail */}
                        <div 
                          className="brightness-rail glass-panel" 
                          onClick={(e) => {
                            const input = e.currentTarget.querySelector('input[type="range"]');
                            if (input && !isSaving) input.focus();
                          }}
                          onWheel={(e) => {
                            if (isSaving) return;
                            e.preventDefault();
                            const dir = e.deltaY < 0 ? 1 : -1;
                            const step = e.shiftKey ? 0.5 : 0.05;
                            const currentZoom = form.drawZoom || 1.0;
                            const newZoom = Math.min(10.0, Math.max(0.1, Math.round((currentZoom + dir * step) * 100) / 100));
                            const oldZoom = currentZoom;
                            const oldX = form.drawCanvasX || 0;
                            const oldY = form.drawCanvasY || 0;
                            const newX = 32 - (32 - oldX) * (newZoom / oldZoom);
                            const newY = 10 - (10 - oldY) * (newZoom / oldZoom);
                            setForm(prev => ({
                              ...prev,
                              drawZoom: newZoom,
                              drawCanvasX: newX,
                              drawCanvasY: newY
                            }));
                          }}
                          style={{ padding: '12px 16px', width: '100%', display: 'flex', alignItems: 'center', gap: '14px', opacity: isSaving ? 0.35 : 1, pointerEvents: isSaving ? 'none' : 'auto', cursor: isSaving ? 'not-allowed' : 'default' }}
                        >
                          <Search className="text-emerald-400 flex-shrink-0" size={17} />
                          <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex', alignItems: 'center' }}>
                            <input 
                              type="range" min="0.1" max="10.0" step="0.05" 
                              tabIndex={0}
                              value={form.drawZoom || 1} 
                              disabled={isSaving}
                              onPointerDown={(e) => e.currentTarget.focus()}
                              onMouseDown={(e) => e.currentTarget.focus()}
                              onClick={(e) => e.currentTarget.focus()}
                              onKeyDown={(e) => {
                                const isArrowKey = ['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'].includes(e.key);
                                const isPlusKey = e.key === '+' || e.key === '=' || e.code === 'NumpadAdd';
                                const isMinusKey = e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract';

                                if (e.code === 'Space' || e.key === ' ') {
                                  e.preventDefault();
                                  return;
                                }

                                if (isArrowKey || isPlusKey || isMinusKey) {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  const dir = (e.key === 'ArrowLeft' || e.key === 'ArrowDown' || isMinusKey) ? -1 : 1;
                                  const step = e.shiftKey ? 0.5 : 0.05;
                                  const currentZoom = form.drawZoom || 1.0;
                                  const newZoom = Math.min(10.0, Math.max(0.1, Math.round((currentZoom + dir * step) * 100) / 100));
                                  const oldZoom = currentZoom;
                                  const oldX = form.drawCanvasX || 0;
                                  const oldY = form.drawCanvasY || 0;
                                  const newX = 32 - (32 - oldX) * (newZoom / oldZoom);
                                  const newY = 10 - (10 - oldY) * (newZoom / oldZoom);
                                  setForm(prev => ({
                                    ...prev,
                                    drawZoom: newZoom,
                                    drawCanvasX: newX,
                                    drawCanvasY: newY
                                  }));
                                }
                              }}
                              onChange={e => {
                                if (isSaving) return;
                                const newZoom = parseFloat(e.target.value);
                                const oldZoom = form.drawZoom || 1.0;
                                const oldX = form.drawCanvasX || 0;
                                const oldY = form.drawCanvasY || 0;
                                const newX = 32 - (32 - oldX) * (newZoom / oldZoom);
                                const newY = 10 - (10 - oldY) * (newZoom / oldZoom);
                                setForm(prev => ({
                                  ...prev,
                                  drawZoom: newZoom,
                                  drawCanvasX: newX,
                                  drawCanvasY: newY
                                }));
                              }}
                              className="brightness-slider"
                              style={{
                                position: 'relative',
                                width: '100%',
                                outline: 'none',
                                boxShadow: 'none',
                                '--fill': `calc(8px + (100% - 16px) * ${Math.max(0, Math.min(1, ((form.drawZoom || 1) - 0.1) / 9.9))})`,
                                cursor: isSaving ? 'not-allowed' : 'pointer'
                              }}
                            />
                          </div>
                          <span className="font-bold text-slate-400 text-[11px] text-right flex-shrink-0" style={{ width: '42px', minWidth: '42px', maxWidth: '42px', flexShrink: 0, fontVariantNumeric: 'tabular-nums', display: 'inline-block' }}>{(form.drawZoom || 1).toFixed(1)}x</span>
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
                              cursor: isSaving ? 'not-allowed' : 'pointer',
                              opacity: isSaving ? 0.45 : 1,
                              transition: 'all 0.2s',
                              flexShrink: 0
                            }}
                            title={isSaving ? undefined : "Reset Zoom (1.0x)"}
                            onMouseOver={e => {
                              if (isSaving) return;
                              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
                              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)';
                              e.currentTarget.style.transform = 'scale(1.05)';
                            }}
                            onMouseOut={e => {
                              if (isSaving) return;
                              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
                              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                              e.currentTarget.style.transform = 'none';
                            }}
                            onClick={() => {
                              if (isSaving) return;
                              setForm(prev => ({
                                ...prev,
                                drawZoom: 1.0,
                                drawCanvasX: 0,
                                drawCanvasY: 0
                              }));
                            }}
                          >
                            <RotateCcw size={16} />
                          </div>
                        </div>

                        {/* Pen Colour and Background Colour Sliders */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px', opacity: isSaving ? 0.35 : 1, pointerEvents: isSaving ? 'none' : 'auto' }}>
                          <HslColorSlider 
                            label="Pen Colour" 
                            value={form.textColor || '#ffffff'} 
                            onChange={val => setForm(prev => ({ ...prev, textColor: val }))} 
                            disabled={isSaving}
                          />
                          <HslColorSlider 
                            label="Background Colour" 
                            value={form.bgColor || '#000000'} 
                            onChange={val => setForm(prev => ({ ...prev, bgColor: val }))} 
                            disabled={isSaving}
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {form.mode === 'text' ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', opacity: isSaving ? 0.35 : 1, pointerEvents: isSaving ? 'none' : 'auto' }}>
                      <label className="text-[10px] font-bold text-slate-500 uppercase ml-1">Display Text (Max 25 chars)</label>
                      <input 
                        className="input-field w-full" 
                        value={form.text} 
                        maxLength={25}
                        disabled={isSaving}
                        onChange={e => {
                          if (isSaving) return;
                          const val = e.target.value;
                          setForm(prev => ({...prev, text: val}));
                        }} 
                        placeholder="Type something..."
                        style={{
                          opacity: isSaving ? 0.35 : 1,
                          cursor: isSaving ? 'not-allowed' : 'text'
                        }}
                      />
                    </div>
                  ) : null}
                </div>

                {/* Image / Video Controls */}
                {form.mode === 'image' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '16px' }}>
                    {isLoadingMedia && <span role="status" className="text-xs text-slate-300" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><RefreshCw size={11} className="animate-spin" />Loading media...</span>}
                    {saveError && !isLoadingMedia && <span role="alert" style={{ color: '#f87171', fontSize: '12px', fontWeight: 600 }}>{saveError}</span>}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          disabled={isSaving}
                          onClick={isSaving ? undefined : openMediaFilePicker}
                          className="btn-styled text-[10px] px-3 py-2 flex items-center gap-1.5"
                          style={{ borderRadius: '12px', opacity: isSaving ? 0.35 : 1, cursor: isSaving ? 'not-allowed' : 'pointer', pointerEvents: isSaving ? 'none' : 'auto' }}
                          title={isSaving ? undefined : "Upload image or video"}
                        >
                          <Upload size={13} />
                        </button>
                          {form.imgSrc && (
                            <button
                              type="button"
                              disabled={isSaving}
                              onClick={isSaving ? undefined : exportOriginalMedia}
                              className="btn-styled text-[10px] px-3 py-2 flex items-center gap-1.5"
                              style={{ borderRadius: '12px', opacity: isSaving ? 0.35 : 1, cursor: isSaving ? 'not-allowed' : 'pointer', pointerEvents: isSaving ? 'none' : 'auto' }}
                              title={isSaving ? undefined : "Download the original uploaded media at its original quality"}
                            >
                              <Download size={13} />
                            </button>
                          )}
                        <button
                          type="button"
                          disabled={isSaving}
                          onClick={() => !isSaving && setIsAiExpanded(prev => !prev)}
                          className={`btn-styled text-[10px] px-3 py-2 flex items-center gap-1.5 transition-all ${!isAiExpanded ? 'inactive' : ''}`}
                          aria-label={`Create with ${aiProvider === 'gemini' ? 'Gemini' : 'OpenAI'}`}
                          style={{
                            borderRadius: '12px',
                            opacity: isSaving ? 0.35 : 1,
                            cursor: isSaving ? 'not-allowed' : 'pointer',
                            pointerEvents: isSaving ? 'none' : 'auto',
                            background: isSaving
                              ? 'rgba(255, 255, 255, 0.05)'
                              : aiProvider === 'gemini'
                              ? 'linear-gradient(to right, #4796E3 0%, #9177C7 50%, #CA6673 100%)'
                              : '#74AA9C',
                            border: isSaving ? '1px solid rgba(255, 255, 255, 0.08)' : 'none',
                            color: isSaving ? '#64748b' : '#ffffff',
                            boxShadow: isSaving
                              ? 'none'
                              : aiProvider === 'gemini'
                              ? '0 0 0 1px rgba(255, 255, 255, 0.2), 0 2px 8px rgba(71, 150, 227, 0.25)'
                              : '0 0 0 1px rgba(255, 255, 255, 0.2), 0 2px 8px rgba(116, 170, 156, 0.25)'
                          }}
                          title={isAiExpanded ? "Close AI Studio side-panel" : "Create media with AI"}
                        >
                          {aiProvider === 'gemini' ? <GeminiLogo size={13} /> : <OpenAILogo size={13} />}
                        </button>
                      </div>

                      {/* Visual Tools Toggles */}
                      {form.imgSrc && <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {form.imgSrc && (
                          <button
                            type="button"
                            disabled={isSaving}
                            onClick={() => {
                              if (isSaving || !imageObjRef.current) return;
                              const newX = (64 - form.dwBase * form.zoom) / 2;
                              const newY = (20 - form.dhBase * form.zoom) / 2;
                              const nextPixels = runCropRender(imageObjRef.current, newX, newY, form.dwBase * form.zoom, form.dhBase * form.zoom, form.bgColor || '#000000');
                              setForm(prev => ({ ...prev, canvasX: newX, canvasY: newY, mediaCanvasX: newX, mediaCanvasY: newY, pixels: nextPixels, mediaPixels: nextPixels }));
                            }}
                            className="btn-styled text-[10px] px-3 py-2"
                            style={{ borderRadius: '12px', opacity: isSaving ? 0.35 : 1, cursor: isSaving ? 'not-allowed' : 'pointer', pointerEvents: isSaving ? 'none' : 'auto' }}
                            title={isSaving ? undefined : "Center media"}
                          >
                            <Crosshair size={13} />
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={isSaving}
                          onClick={() => !isSaving && setShowGrid(prev => !prev)}
                          className={`btn-styled text-[10px] px-3 py-2 ${!showGrid ? 'inactive' : ''}`}
                          style={{ borderRadius: '12px', opacity: isSaving ? 0.35 : 1, cursor: isSaving ? 'not-allowed' : 'pointer', pointerEvents: isSaving ? 'none' : 'auto' }}
                          title={isSaving ? undefined : "Toggle pixel matrix grid"}
                        >
                          <Grid3X3 size={13} />
                        </button>
                        <button
                          type="button"
                          disabled={isSaving}
                          onClick={() => !isSaving && setShowGuides(prev => !prev)}
                          className={`btn-styled text-[10px] px-3 py-2 ${!showGuides ? 'inactive' : ''}`}
                          style={{ borderRadius: '12px', opacity: isSaving ? 0.35 : 1, cursor: isSaving ? 'not-allowed' : 'pointer', pointerEvents: isSaving ? 'none' : 'auto' }}
                          title={isSaving ? undefined : "Toggle centering guides"}
                        >
                          <ScanLine size={13} />
                        </button>
                      </div>}
                    </div>

                    {form.imgSrc && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '4px' }}>
                        {/* Zoom Slider */}
                        <div 
                          className="brightness-rail glass-panel" 
                          onClick={(e) => {
                            const input = e.currentTarget.querySelector('input[type="range"]');
                            if (input && !isSaving) input.focus();
                          }}
                          onWheel={(e) => {
                            if (isSaving || !imageObjRef.current) return;
                            e.preventDefault();
                            const dir = e.deltaY < 0 ? 1 : -1;
                            const step = e.shiftKey ? 0.5 : 0.05;
                            const currentZoom = form.zoom || 1.0;
                            const newZoom = Math.min(10.0, Math.max(0.1, Math.round((currentZoom + dir * step) * 100) / 100));
                            const oldZoom = currentZoom;
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
                              mediaZoom: newZoom,
                              mediaCanvasX: newX,
                              mediaCanvasY: newY,
                              pixels: nextPixels,
                              mediaPixels: nextPixels
                            }));
                          }}
                          style={{ padding: '12px 16px', width: '100%', display: 'flex', alignItems: 'center', gap: '14px', opacity: isSaving ? 0.35 : 1, pointerEvents: isSaving ? 'none' : 'auto', cursor: isSaving ? 'not-allowed' : 'default' }}
                        >
                          <Search className="text-emerald-400 flex-shrink-0" size={17} />
                          <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex', alignItems: 'center' }}>
                            <input 
                              type="range" min="0.1" max="10.0" step="0.05" 
                              tabIndex={0}
                              value={form.zoom || 1} 
                              disabled={isSaving}
                              onPointerDown={(e) => e.currentTarget.focus()}
                              onMouseDown={(e) => e.currentTarget.focus()}
                              onClick={(e) => e.currentTarget.focus()}
                              onKeyDown={(e) => {
                                const isArrowKey = ['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'].includes(e.key);
                                const isPlusKey = e.key === '+' || e.key === '=' || e.code === 'NumpadAdd';
                                const isMinusKey = e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract';

                                if (e.code === 'Space' || e.key === ' ') {
                                  e.preventDefault();
                                  return;
                                }

                                if (isArrowKey || isPlusKey || isMinusKey) {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  const dir = (e.key === 'ArrowLeft' || e.key === 'ArrowDown' || isMinusKey) ? -1 : 1;
                                  const step = e.shiftKey ? 0.5 : 0.05;
                                  const currentZoom = form.zoom || 1.0;
                                  const newZoom = Math.min(10.0, Math.max(0.1, Math.round((currentZoom + dir * step) * 100) / 100));
                                  if (!imageObjRef.current) {
                                    setForm(prev => ({ ...prev, zoom: newZoom, mediaZoom: newZoom }));
                                    return;
                                  }
                                  const oldZoom = currentZoom;
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
                                    mediaZoom: newZoom,
                                    mediaCanvasX: newX,
                                    mediaCanvasY: newY,
                                    pixels: nextPixels,
                                    mediaPixels: nextPixels
                                  }));
                                }
                              }}
                              onChange={e => {
                                if (isSaving) return;
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
                                  mediaZoom: newZoom,
                                  mediaCanvasX: newX,
                                  mediaCanvasY: newY,
                                  pixels: nextPixels,
                                  mediaPixels: nextPixels
                                }));
                              }}
                              className="brightness-slider"
                              style={{
                                position: 'relative',
                                width: '100%',
                                outline: 'none',
                                boxShadow: 'none',
                                '--fill': `calc(8px + (100% - 16px) * ${Math.max(0, Math.min(1, ((form.zoom || 1) - 0.1) / 9.9))})`,
                                cursor: isSaving ? 'not-allowed' : 'pointer'
                              }}
                            />
                          </div>
                          <span className="font-bold text-slate-400 text-[11px] text-right flex-shrink-0" style={{ width: '42px', minWidth: '42px', maxWidth: '42px', flexShrink: 0, fontVariantNumeric: 'tabular-nums', display: 'inline-block' }}>{(form.zoom || 1).toFixed(1)}x</span>
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
                              cursor: isSaving ? 'not-allowed' : 'pointer',
                              opacity: isSaving ? 0.45 : 1,
                              transition: 'all 0.2s',
                              flexShrink: 0
                            }}
                            title={isSaving ? undefined : "Fit to Width"}
                            onMouseOver={e => {
                              if (isSaving) return;
                              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
                              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)';
                              e.currentTarget.style.transform = 'scale(1.05)';
                            }}
                            onMouseOut={e => {
                              if (isSaving) return;
                              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
                              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                              e.currentTarget.style.transform = 'none';
                            }}
                            onClick={() => {
                              if (isSaving || !imageObjRef.current) return;
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
                                mediaZoom: targetZoom,
                                mediaCanvasX: newX,
                                mediaCanvasY: newY,
                                pixels: nextPixels,
                                mediaPixels: nextPixels
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
                              cursor: isSaving ? 'not-allowed' : 'pointer',
                              opacity: isSaving ? 0.45 : 1,
                              transition: 'all 0.2s',
                              flexShrink: 0
                            }}
                            title={isSaving ? undefined : "Fit to Height"}
                            onMouseOver={e => {
                              if (isSaving) return;
                              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
                              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)';
                              e.currentTarget.style.transform = 'scale(1.05)';
                            }}
                            onMouseOut={e => {
                              if (isSaving) return;
                              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
                              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                              e.currentTarget.style.transform = 'none';
                            }}
                            onClick={() => {
                              if (isSaving || !imageObjRef.current) return;
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
                                mediaZoom: targetZoom,
                                mediaCanvasX: newX,
                                mediaCanvasY: newY,
                                pixels: nextPixels,
                                mediaPixels: nextPixels
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
                              cursor: isSaving ? 'not-allowed' : 'pointer',
                              opacity: isSaving ? 0.45 : 1,
                              transition: 'all 0.2s',
                              flexShrink: 0
                            }}
                            title={isSaving ? undefined : "Reset Zoom (1.0x)"}
                            onMouseOver={e => {
                              if (isSaving) return;
                              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
                              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)';
                              e.currentTarget.style.transform = 'scale(1.05)';
                            }}
                            onMouseOut={e => {
                              if (isSaving) return;
                              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
                              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                              e.currentTarget.style.transform = 'none';
                            }}
                            onClick={() => {
                              if (isSaving || !imageObjRef.current) return;
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
                                mediaZoom: newZoom,
                                mediaCanvasX: newX,
                                mediaCanvasY: newY,
                                pixels: nextPixels,
                                mediaPixels: nextPixels
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
                          disabled={isSaving}
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
                              setForm(prev => ({ ...prev, bgColor: val, pixels: nextPixels, mediaPixels: nextPixels }));
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
                      disabled={isSaving}
                      onChange={val => setForm(prev => ({ ...prev, textColor: val }))} 
                    />
                    <HslColorSlider 
                      label="Background Colour" 
                      value={form.bgColor || '#000000'} 
                      disabled={isSaving}
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
                        disabled={isSaving}
                        style={{
                          width: '100%',
                          background: '#1a1a1f',
                          color: '#fff',
                          cursor: isSaving ? 'not-allowed' : 'pointer',
                          opacity: isSaving ? 0.45 : 1,
                          padding: '10px 14px',
                          borderRadius: '14px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          textAlign: 'left'
                        }}
                        onClick={() => !isSaving && setAnimDropdownOpen(prev => !prev)}
                      >
                        <span style={{ fontSize: '12px', textTransform: 'none', whiteSpace: 'nowrap' }}>{form.animation || 'continuous left shift'}</span>
                        <ChevronDown 
                          size={14} 
                          className="text-slate-400 transition-transform duration-200" 
                          style={{ transform: animDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)' }} 
                        />
                      </button>

                      {animDropdownOpen && !isSaving && (
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



                {saveError && form.mode !== 'image' && <div role="alert" style={{ color: '#f87171', marginTop: 16 }}>
                  Error saving preset: {saveError}
                </div>}
                <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
                  <button 
                    className={`btn-styled py-4 ${isSaving ? 'btn-save-processing' : ''}`}
                    style={{ 
                      flex: 3,
                      background: (!canSavePreset || isSaving) ? 'rgba(255, 255, 255, 0.08)' : undefined,
                      color: (!canSavePreset || isSaving) ? '#94a3b8' : '#ffffff',
                      opacity: (!canSavePreset || isSaving) ? 0.5 : 1,
                      cursor: (!canSavePreset || isSaving) ? 'not-allowed' : 'pointer',
                      boxShadow: (!canSavePreset || isSaving) ? 'none' : undefined,
                      transform: (!canSavePreset || isSaving) ? 'none' : undefined,
                      pointerEvents: (!canSavePreset || isSaving) ? 'none' : 'auto',
                      transition: (!canSavePreset || isSaving) ? 'none' : 'all 0.2s ease',
                      filter: (!canSavePreset || isSaving) ? 'grayscale(1)' : 'none'
                    }}
                    onClick={handleSave}
                    disabled={!canSavePreset || isSaving}
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
                      type="button"
                      className="btn-disconnect py-4" 
                      style={{ 
                        flex: 1, 
                        minWidth: 'auto', 
                        justifyContent: 'center',
                        background: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid rgba(239, 68, 68, 0.2)',
                        color: '#ef4444',
                        opacity: isSaving ? 0.45 : 1, 
                        cursor: isSaving ? 'not-allowed' : 'pointer' 
                      }}
                      onMouseOver={e => {
                        if (isSaving) return;
                        e.currentTarget.style.background = 'rgba(239, 68, 68, 0.2)';
                      }}
                      onMouseOut={e => {
                        if (isSaving) return;
                        e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)';
                      }}
                      disabled={isSaving}
                      onClick={() => !isSaving && deletePreset()}
                    >
                      <Trash2 size={16} /> Delete
                    </button>
                  )}
                </div>
              </div>
            </motion.div>

            {/* AI Studio Side Panel */}
            <AnimatePresence>
              {isAiExpanded && form.mode === 'image' && (
                <motion.div
                  data-ai-side-panel="true"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.22, ease: 'easeOut' }}
                  style={{
                    position: 'absolute',
                    left: '784px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    width: '460px',
                    maxWidth: '460px',
                    maxHeight: '92vh',
                    overflowY: 'auto',
                    borderRadius: '24px',
                    display: 'flex',
                    flexDirection: 'column',
                    opacity: isSaving ? 0.45 : 1,
                    pointerEvents: isSaving ? 'none' : 'auto',
                    cursor: isSaving ? 'not-allowed' : 'default'
                  }}
                >
                  <GeminiMediaGenerator 
                    ref={aiGeneratorRef}
                    isExpanded={true}
                    onToggleExpand={setIsAiExpanded}
                    onCloseSidePanel={() => !isSaving && setIsAiExpanded(false)}
                    onProviderChange={setAiProvider}
                    form={form} 
                    setForm={setForm} 
                    imageObjRef={imageObjRef} 
                    onNotify={setUnifiedPushMessage}
                    style={{
                      height: '100%',
                      borderRadius: '24px',
                      padding: '24px'
                    }}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </AnimatePresence>,
      document.body
    )}
    </div>
  );
}
