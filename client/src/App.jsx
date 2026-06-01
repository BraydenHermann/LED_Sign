import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Power, Sun, Calendar, Image as ImageIcon, Bluetooth, Wifi,
  Activity, Upload, Clock, ExternalLink, Link2Off, Link2,
  FileSearch, Search, RefreshCw, EyeOff, ChevronRight, X,
  ChevronLeft, AlertCircle, Eraser, Undo2, Redo2, Plus, Pencil, Zap, Gauge, Check,
  Trash2, Pipette, Save, Send
} from 'lucide-react';

const API_BASE = '';
const DEFAULT_MAC = 'FF:24:10:29:44:9B';
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
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
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

function getEventDisplayString(ev) {
  if (!ev) return 'IN A MEETING';
  const summary = ev.summary || 'Untitled Event';
  try {
    const startD = new Date(ev.start_iso);
    const endD = new Date(ev.end_iso);
    const timeFmt = new Intl.DateTimeFormat(undefined, { 
      hour: 'numeric', 
      minute: '2-digit', 
      hour12: true 
    });
    const startTimeStr = timeFmt.format(startD).toLowerCase();
    const endTimeStr = timeFmt.format(endD).toLowerCase();
    
    const result = `${summary} ||| ${startTimeStr} - ${endTimeStr}`;
    return result;
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
      className="preset-card-image" 
      style={style || { width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'pixelated' }}
    />
  );
};

const AnimatedPresetCardPreview = ({ preset }) => {
  const canvasRef = useRef(null);
  useEffect(() => {
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
    const delayMs = preset.frameDurationMs
      ? Math.max(16, preset.frameDurationMs)
      : Math.max(50, (0.4 - (clampedSpeed * 0.025)) * 1000);

    const play = () => {
      ctx.putImageData(frames[currentFrameIdx], 0, 0);
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
      className="preset-card-image" 
      style={{ width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'pixelated' }}
    />
  );
};

const TextPresetCardPreview = ({ preset }) => {
  const canvasRef = useRef(null);
  const scrollOffsetRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let textToDraw = preset.text || preset.name || '';
    let isAnimating = preset.animation === 'move-left';
    let animationSpeed = preset.speed !== undefined ? preset.speed : 13;

    ctx.font = '18px Arial, sans-serif';
    ctx.textBaseline = 'middle';
    
    if (!isAnimating) {
       ctx.fillStyle = preset.bgColor || '#000000';
       ctx.fillRect(0, 0, 64, 20);
       ctx.fillStyle = preset.textColor || '#ffffff';
       ctx.textAlign = 'center';
       ctx.fillText(textToDraw, 32, 10);
       return;
    }

    ctx.textAlign = 'left';
    const tw = ctx.measureText(textToDraw).width;
    
    const interval = setInterval(() => {
       scrollOffsetRef.current += 1;
       const x = 64 - (scrollOffsetRef.current % (64 + tw));
       
       ctx.fillStyle = preset.bgColor || '#000000';
       ctx.fillRect(0, 0, 64, 20);
       ctx.fillStyle = preset.textColor || '#ffffff';
       ctx.fillText(textToDraw, x, 10);
    }, Math.max(10, 80 - animationSpeed * 5));

    return () => clearInterval(interval);
  }, [preset]);

  return (
    <canvas 
      ref={canvasRef} 
      width={64} 
      height={20} 
      className="preset-card-image" 
      style={{ width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'pixelated' }}
    />
  );
};


export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [status, setStatus] = useState({
    connected: false, address: null, preview_url: null,
    calendar_connected: false, uptime: '—', frames: 0
  });
  const [brightness, setBrightness] = useState(15);
  const [speed, setSpeed] = useState(13);

  // Drag state for Saved Presets
  const [savedDraggedIdx, setSavedDraggedIdx] = useState(null);
  const [savedDragOverIdx, setSavedDragOverIdx] = useState(null);
  
  const [power, setPower] = useState(false);
  const [macAddress, setMacAddress] = useState(localStorage.getItem('loy_mac') || '');
  const [isConnecting, setIsConnecting] = useState(false);
  const [apiError, setApiError] = useState(false);
  const [hasFetchedStatus, setHasFetchedStatus] = useState(false);
  const [pushMessage, setPushMessage] = useState('');
  const [localPushMessage, setLocalPushMessage] = useState('');
  const [pushing, setPushing] = useState(false);
  const autoConnectTried = useRef(false);

  useEffect(() => {
    if (window.location.hash === '#calendar') {
      setActiveTab('calendar');
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  useEffect(() => { localStorage.setItem('loy_mac', macAddress); }, [macAddress]);

  const [previewStamp, setPreviewStamp] = useState(Date.now());
  const lastPreviewTs = useRef(0);
  const lastFramesRef = useRef(-1);

  const fetchStatus = async () => {
    try {
      const res = await axios.get(`${API_BASE}/status`);
      setStatus(res.data);
      if (res.data && res.data.connected === false) {
        setPushMessage('');
        setLocalPushMessage('');
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
      setApiError(true);
      return null;
    }
  };

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 2000);
    return () => clearInterval(id);
  }, []);

  // Dedicated Auto-Connect Effect
  useEffect(() => {
    if (hasFetchedStatus && !status.connected && macAddress && !autoConnectTried.current && !isConnecting && !apiError) {
      console.log("[auto-connect] Attempting to reconnect to:", macAddress);
      autoConnectTried.current = true;
      doConnect(macAddress);
    }
  }, [hasFetchedStatus, status.connected, macAddress, isConnecting, apiError]);

  const doConnect = async (addr, isRetry = false) => {
    if (!addr || (isConnecting && !isRetry)) return;
    setIsConnecting(true);
    setApiError(false);
    setConnectionFailed(false);
    console.log(`[connect] ${isRetry ? 'Retry attempt' : 'Connecting'} to:`, addr);
    try {
      const resPost = await axios.post(`${API_BASE}/connect`, { address: addr }, { timeout: 35000 });
      const connectedAddr = resPost.data.address || addr;
      setMacAddress(connectedAddr);
      const res = await axios.get(`${API_BASE}/status`);
      setStatus(res.data);
      if (res.data.connected) {
        setScanOpen(false);
        if (res.data.power !== undefined) setPower(res.data.power);
        else setPower(true);
      }
    } catch (e) {
      console.error(`[connect] ${isRetry ? 'Retry' : 'Attempt 1'} failed:`, e.message);
      if (!isRetry) {
        // Silent first-failure is common — auto-retry once after a short pause
        console.log('[connect] Auto-retrying once...');
        await new Promise(r => setTimeout(r, 1500));
        await doConnect(addr, true);
        return;
      }
      setApiError(true);
      setConnectionFailed(true);
    }
    setIsConnecting(false);
  };

  const handleDisconnect = async () => {
    setStatus(prev => ({ ...prev, connected: false, address: null, preview_url: null }));
    setMacAddress('');
    setIsConnecting(false);
    autoConnectTried.current = false;
    setPushMessage('');
    setLocalPushMessage('');
    try { await axios.post(`${API_BASE}/disconnect`); } catch (e) {}
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
  const [isManualOverride, setIsManualOverrideState] = useState(false);
  const isManualOverrideRef = useRef(false);
  const lastActiveEventIdRef = useRef(null);
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
  const [calLoading, setCalLoading] = useState(false);
  const [now, setNow] = useState(new Date());
  const [presets, setPresets] = useState([]);
  const [dbLoaded, setDbLoaded] = useState(false);
  const [allSavedPresets, setAllSavedPresets] = useState({});

  const activeMac = status.address?.toUpperCase() || DEFAULT_MAC;
  const savedPresets = allSavedPresets[activeMac] || Array(36).fill(null).map((_, i) => ({ slotNumber: i + 1, preset: null }));

  const setSavedPresets = (nextSaved) => {
    setAllSavedPresets(prev => ({ ...prev, [activeMac]: nextSaved }));
  };

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
            animation: 'static',
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
      const res = await axios.get(`${API_BASE}/calendar/today`);
      const evs = res.data?.events || [];
      setEvents(evs);
      setCalLoading(false);
      return evs;
    } catch (e) {
      setCalLoading(false);
      return [];
    }
  };

  // Auto-push / Blanking / Default logic based on the local clock
  useEffect(() => {
    if (!status?.connected || !events) return;

    // Check for calendar event transitions to clear manual override
    try {
      const activeEvents = events.filter(ev => isEventActive(ev, now) && ev.response_status?.toLowerCase() !== 'declined');
      const activeEvent = activeEvents.sort((a, b) => new Date(b.start_iso) - new Date(a.start_iso))[0];
      const activeEventId = activeEvent ? activeEvent.id : null;
      if (activeEventId !== lastActiveEventIdRef.current) {
        console.log(`[auto-push] Event transition detected: ${lastActiveEventIdRef.current} -> ${activeEventId}. Clearing manual override.`);
        lastActiveEventIdRef.current = activeEventId;
        setIsManualOverride(false);
      }
    } catch (err) {
      console.error("[auto-push] Error during transition check:", err);
    }

    if (isManualOverride) return;

    try {
      const activeEvents = events.filter(ev => isEventActive(ev, now) && ev.response_status?.toLowerCase() !== 'declined');
      const activeEvent = activeEvents.sort((a, b) => new Date(b.start_iso) - new Date(a.start_iso))[0];
      const defaultPreset = (presets || []).find(p => p.isDefault);
      
      let targetContent = null;
      let targetId = null;

      if (activeEvent) {
        targetContent = { type: 'event', data: activeEvent, summary: getEventDisplayString(activeEvent) };
        targetId = `event-${activeEvent.id}-${targetContent.summary}`;
      } else if (defaultPreset) {
        targetContent = { type: 'preset', data: defaultPreset };
        targetId = `preset-${defaultPreset.id}`;
      }

      if (targetId !== lastPushedId) {
        if (targetContent) {
          if (targetContent.type === 'event') {
            handlePush(targetContent.summary, false);
          } else {
            // Push default preset
            handlePush(targetContent.data, false);
          }
        } else {
          // No event, no default -> clear
          if (lastPushedId) {
            console.log("[auto-push] No active event or default, clearing sign...");
            axios.post(`${API_BASE}/clear`).catch(() => {});
          }
        }
        setLastPushedId(targetId);
      }
    } catch (err) {
      console.error("[auto-push] Error:", err);
    }
  }, [now, events, status.connected, isManualOverride, presets]);

  // Sync on connection
  useEffect(() => {
    if (status.connected) {
      fetchEvents();
      if (isManualOverride && lastPushedId) {
        const lastPreset = presets?.find(p => p.id === lastPushedId);
        if (lastPreset) {
          console.log("[reconnect] Restoring last manually pushed preset:", lastPreset);
          setTimeout(() => {
            handlePush(lastPreset, false).catch(err => {
              console.error("[reconnect] Failed to restore last preset:", err);
            });
          }, 800);
        } else {
          setIsManualOverride(false);
          setLastPushedId(null);
        }
      } else {
        setLastPushedId(null);
      }
    } else {
      setPushMessage('');
    }
  }, [status.connected]);

  // Regular poll
  useEffect(() => {
    fetchEvents();
    const id = setInterval(fetchEvents, 900000); // 15 minutes
    return () => clearInterval(id);
  }, [status.calendar_connected]);


  const handlePush = async (payload, manual = false, skipMessages = false) => {
    if (manual) setIsManualOverride(true);
    setPushing(true);
    if (!skipMessages) {
      if (manual) {
        setLocalPushMessage('Pushing to sign...');
      } else {
        setPushMessage('');
        setLocalPushMessage('');
      }
    }
    
    let data;
    let pushName = '';
    let isEvent = false;
    
    if (typeof payload === 'string') {
      pushName = 'Event';
      isEvent = true;
      data = {
        name: payload.split('|||')[0].trim(),
        text: payload,
        textColor: '#ffffff',
        bgColor: '#000000',
        animation: 'static',
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
      }
    }

    try {
      if (data.mode === 'clock') {
        const pushColor = data.clockStyle === 'default' ? '#ffffff' : (data.textColor || '#10B981');
        await axios.post(`${API_BASE}/clock?on=true&color=${encodeURIComponent(pushColor)}&bg_color=${encodeURIComponent(data.bgColor || '#000000')}&format=${data.timeFormat || '12h'}&show_seconds=${data.showSeconds !== false}&clock_style=${data.clockStyle || 'custom'}`);
      } else {
        // Ensure speed state is applied for text presets
        if (data.mode === 'text') {
          data.speed = speed;
        }
        await axios.post(`${API_BASE}/push-text`, data);
      }
      if (manual && !skipMessages) {
        setLocalPushMessage(`Pushed "${pushName}" to sign!`);
      }
      fetchStatus();
    } catch (e) {
      console.error('[push] Failed:', e);
      const detail = e.response?.data?.detail;
      const errorMsg = typeof detail === 'string' ? detail : (Array.isArray(detail) ? detail[0]?.msg : JSON.stringify(detail));
      if (!isEvent && !skipMessages) {
        setPushMessage('Error: ' + (errorMsg || e.message));
        setLocalPushMessage('Error: ' + (errorMsg || e.message));
      }
      throw e;
    } finally {
      setPushing(false);
    }
  };

  const handlePushManual = (name, status) => {
    setIsManualOverride(true);
    handlePush(name, status);
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
              connectionFailed={connectionFailed}
              deviceNames={deviceNames}
              setDeviceName={setDeviceName}
              previewStamp={previewStamp}
              lastPushedId={lastPushedId}
              setLastPushedId={setLastPushedId}
              presets={presets}
              savedPresets={savedPresets}
              setSavedPresets={setSavedPresets}
              savedDraggedIdx={savedDraggedIdx}
              setSavedDraggedIdx={setSavedDraggedIdx}
              savedDragOverIdx={savedDragOverIdx}
              setSavedDragOverIdx={setSavedDragOverIdx}
              now={now}
              pushMessage={pushMessage}
              setPushMessage={setPushMessage}
              pushing={pushing}
              setPushing={setPushing}
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
            pushing={pushing}
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
            pushMessage={pushMessage}
            pushing={pushing}
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
function DashboardView({ status, power, setPower, brightness, setBrightness, speed, setSpeed, macAddress, onMacInput, onMacBlur, onConnect, onDisconnect, isConnecting, onClear, isModalOpen, onPush, connectionFailed, deviceNames, setDeviceName, previewStamp, lastPushedId, setLastPushedId, presets, savedPresets, setSavedPresets, savedDraggedIdx, setSavedDraggedIdx, savedDragOverIdx, setSavedDragOverIdx, now, pushMessage, setPushMessage, pushing, setPushing }) {
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    setIsLoaded(false);
  }, [status.preview_url, previewStamp]);

  const [scanResults, setScanResults] = useState([]);
  const [recents, setRecents] = useState(JSON.parse(localStorage.getItem('loy_recents') || '[]'));
  const [scanTab, setScanTab] = useState('all');
  const [isScanning, setIsScanning] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanSearch, setScanSearch] = useState('');
  const [scanPage, setScanPage] = useState(0);
  const [nameEditMode, setNameEditMode] = useState(false);
  const [nameEditValue, setNameEditValue] = useState('');
  const [assigningSlotIndex, setAssigningSlotIndex] = useState(null);
  const [isSavedCollapsed, setIsSavedCollapsed] = useState(false);
  const [savedPage, setSavedPage] = useState(0);
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

  const startScan = async () => {
    setScanTab('all');
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
    // Always auto-scan if 'all' tab is active
    if (scanTab === 'all') {
      startScan();
    }
  };

  const handleConnectOrScan = () => {
    handleScanOpen();
  };

  // Helper: detect if a string looks like a raw MAC address
  const isMacAddress = (s) => /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(s);

  const addRecent = (addr, name) => {
    setRecents(prev => {
      const existing = prev.find(d => d.address === addr);
      // If the new name is just the MAC address or undefined, and we already have a real name, keep the real name
      let finalName = name || addr;
      if (existing && existing.name && !isMacAddress(existing.name) && (!name || name === addr)) {
        finalName = existing.name;
      }
      // Don't create a new entry if we only have the MAC and no existing record
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

  // For recents, filter out any MAC-only entries (corrupt/nameless records)
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
    console.log('[assignPresetToSlot] Called with globalIdx:', globalIdx, 'preset:', preset);
    if (!preset) {
      console.warn('[assignPresetToSlot] No preset provided');
      return;
    }

    if (globalIdx < 12 && (preset.mode === 'clock' || preset.id === 'clock-default' || preset.text?.includes('|||'))) {
      console.warn('[assignPresetToSlot] Cannot assign clock/event preset to hardware slots');
      setPushMessage('Dynamic clock and event presets cannot be saved to hardware slots.');
      return;
    }

    const presetCopy = { ...preset };

    if (globalIdx >= 12) {
      console.log('[assignPresetToSlot] Assigning to local UI slot:', globalIdx);
      const nextSaved = [...savedPresets];
      nextSaved[globalIdx] = {
        ...nextSaved[globalIdx],
        preset: { ...presetCopy, id: `saved-${Date.now()}-${globalIdx}` }
      };
      setSavedPresets(nextSaved);
      setPushMessage(`Assigned to local UI slot ${globalIdx + 1}`);
      return;
    }

    setPushing(true);
    setPushMessage(`Saving to slot ${globalIdx + 1}...`);
    console.log('[assignPresetToSlot] Setting pushing=true, sending save-preset request');

    try {
      
      const hwSlotId = globalIdx;
      console.log('[assignPresetToSlot] Mapped hwSlotId:', hwSlotId);

      await axios.post(`${API_BASE}/save-preset`, {
        slot_id: hwSlotId,
        address: status.address || DEFAULT_MAC,
        preset: {
          ...presetCopy,
          speed: presetCopy.speed !== undefined ? presetCopy.speed : speed
        }
      });
      console.log('[assignPresetToSlot] API save-preset call succeeded');

      const nextSaved = [...savedPresets];
      nextSaved[globalIdx] = {
        ...nextSaved[globalIdx],
        preset: { ...presetCopy, id: `saved-${Date.now()}-${globalIdx}` }
      };
      setSavedPresets(nextSaved);
      setPushMessage(`Saved to slot ${globalIdx + 1}!`);
    } catch (err) {
      console.error('Failed to save preset to hardware slot:', err);
      setPushMessage(`Error: ${err.response?.data?.detail || err.message || 'Failed to save preset'}`);
    } finally {
      console.log('[assignPresetToSlot] Setting pushing=false');
      setPushing(false);
    }
  };

  const playSavedPreset = async (globalIdx, preset) => {
    if (globalIdx >= 12 && !preset) return; // Only local UI slots require a valid preset for pushing

    if (preset) {
      setLastPushedId(preset.id);
    }

    if (globalIdx < 12) {
      
      const hwSlotId = globalIdx;
      setPushing(true);
      setPushMessage(`Pushing slot ${globalIdx + 1} to sign...`);
      try {
        await axios.post(`${API_BASE}/preset?id=${hwSlotId}&mac=${encodeURIComponent(status.address || DEFAULT_MAC)}`);
        setPushMessage(`Pushed slot ${globalIdx + 1} to sign!`);
      } catch (err) {
        console.error('Failed to trigger hardware preset play:', err);
        setPushMessage(`Error: ${err.message}`);
      } finally {
        setPushing(false);
      }
    } else {
      try {
        await pushPreset(preset);
        setPushMessage(`Pushed slot ${globalIdx + 1} to sign!`);
      } catch (err) {
        setPushMessage(`Error: ${err.message}`);
      } finally {
        setPushing(false);
      }
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

      console.log('[handleDropOnSlot] Swapping saved slots:', sourceGlobalIndex, '<->', slotGlobalIndex);
      const nextSaved = [...savedPresets];
      const sourcePreset = nextSaved[sourceGlobalIndex].preset;
      const targetPreset = nextSaved[slotGlobalIndex].preset;

      const cleanSourcePreset = sourcePreset ? { ...sourcePreset } : null;
      const cleanTargetPreset = targetPreset ? { ...targetPreset } : null;

      nextSaved[slotGlobalIndex] = {
        ...nextSaved[slotGlobalIndex],
        preset: cleanSourcePreset ? { ...cleanSourcePreset, id: `saved-${Date.now()}-${slotGlobalIndex}` } : null
      };
      nextSaved[sourceGlobalIndex] = {
        ...nextSaved[sourceGlobalIndex],
        preset: cleanTargetPreset ? { ...cleanTargetPreset, id: `saved-${Date.now()}-${sourceGlobalIndex}` } : null
      };
      setSavedPresets(nextSaved);

      if (slotGlobalIndex < 12 && cleanSourcePreset) {
        await assignPresetToSlot(slotGlobalIndex, cleanSourcePreset);
      }
      if (sourceGlobalIndex < 12 && cleanTargetPreset) {
        await assignPresetToSlot(sourceGlobalIndex, cleanTargetPreset);
      }
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

  const activePreset = lastPushedId ? (
    presets.find(p => p.id === lastPushedId) || 
    savedPresets.map(s => s.preset).filter(Boolean).find(p => p.id === lastPushedId)
  ) : null;

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
          <div onClick={onClear} className={`power-btn off ${!status.connected ? 'disabled' : ''}`} style={{ background: 'rgba(255, 255, 255, 0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#f8fafc', opacity: status.connected ? 1 : 0.2, pointerEvents: status.connected ? 'auto' : 'none' }} title="Set to Default" onMouseOver={e => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)'; e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)'; e.currentTarget.style.transform = 'scale(1.05)'; }} onMouseOut={e => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)'; e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)'; e.currentTarget.style.transform = 'none'; }}>
            <img src="https://static.thenounproject.com/png/5507757-200.png" alt="Clear" width="34" height="34" style={{ filter: 'invert(100%)', opacity: status.connected ? 0.9 : 0.4 }} />
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
              ) : status?.preview_url ? (
                <img
                  ref={previewRef}
                  src={`${API_BASE}${status.preview_url}?t=${previewStamp}`}
                  alt="Live"
                  className={`${status.width && status.width > 64 ? "scrolling-preview" : "static-preview"} ${isLoaded ? 'loaded' : ''}`}
                  style={status.width && status.width > 64 ? { '--scroll-duration': `${((64 + status.width) * Math.max(10, 80 - speed * 5)) / 1000}s` } : {}}
                  onLoad={() => setIsLoaded(true)}
                />
              ) : activePreset && (activePreset.mode === 'clock' || activePreset.id === 'clock-default') ? (
                <ClockPresetCardPreview preset={activePreset} style={{ width: '100%', height: '100%', objectFit: 'fill', imageRendering: 'pixelated' }} />
              ) : activePreset && activePreset.thumbnail ? (
                <img
                  ref={previewRef}
                  src={activePreset.thumbnail || ''}
                  alt="Live Fallback"
                  className="static-preview loaded"
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

            <div className="brightness-rail glass-panel" style={{ opacity: status.connected ? 1 : 0.2, pointerEvents: status.connected ? 'auto' : 'none', padding: '12px 16px', flex: 1 }}>
              <Gauge className="text-emerald-400 flex-shrink-0" size={17} />
              <input 
                type="range" min="1" max="15" value={speed} 
                onChange={(e) => onSpeedChange(parseInt(e.target.value))} 
                className="h-slider" 
                disabled={!status.connected}
              />
              <span className="font-bold text-slate-500 w-6 text-[10px] text-right">{speed}</span>
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
          <>
            <button 
              className="btn-styled flex items-center justify-center gap-2" 
              style={{ whiteSpace: 'nowrap', minWidth: '160px', height: '42px', padding: '0 20px' }} 
              onClick={isConnecting ? onDisconnect : handleConnectOrScan} 
              disabled={isScanning}
            >
              {isConnecting ? (
                <><RefreshCw size={14} className="animate-spin" /> Cancel</>
              ) : isScanning ? 'Scanning...' : 'Connect'}
            </button>
          </>
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
                    onClick={() => { setScanTab('all'); setScanPage(0); if (scanResults.length === 0) startScan(); }}
                  >
                    All Devices
                  </button>
                  <button 
                    className={`btn-styled ${scanTab === 'recents' ? '' : 'inactive'}`}
                    style={{ flex: 1, padding: '10px 0', minWidth: 0, fontSize: '12px', textTransform: 'uppercase' }}
                    onClick={() => { setScanTab('recents'); setScanPage(0); }}
                  >
                    Recents
                  </button>
                </div>

                {/* Search */}
                {!isScanning && (
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
                    {scanTab === 'all' && (
                      <button onClick={startScan} className="btn-styled" style={{ padding: '11px', minWidth: 'auto', flexShrink: 0, borderRadius: '14px' }}>
                        <RefreshCw size={14} />
                      </button>
                    )}
                  </div>
                )}

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
                    
                    const isAvailable = scanTab === 'all' || scanResults.some(r => r.address === dev.address);
                    
                    return (
                      <div 
                        key={dev.address} 
                        className="scan-item"
                        style={!isAvailable ? { opacity: 0.4, filter: 'grayscale(100%)' } : {}}
                        onClick={() => {
                          if (isAvailable) pickDevice(dev.address, rawName);
                        }}
                      >
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <p className="font-bold text-sm text-slate-100" style={!isAvailable ? { color: '#94a3b8' } : {}}>
                              {displayName}
                            </p>
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

      {/* Saved Presets Panel */}
      {status.connected && (
        <div className="flex flex-col items-center pt-12 w-full" style={{ borderTop: '1px solid rgba(255,255,255,0.05)', marginTop: '48px' }}>
          <div 
            onClick={() => setIsSavedCollapsed(!isSavedCollapsed)}
            style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%', maxWidth: 1100, marginBottom: 8, cursor: 'pointer' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <ImageIcon className="text-emerald-400 shrink-0" size={24} />
              <h3 className="text-2xl font-black" style={{ margin: 0 }}>Saved Presets</h3>
              {pushMessage && (
                <span 
                  className="text-xs font-bold ml-4 flex items-center gap-1.5" 
                  style={{ color: pushMessage.startsWith('Error') ? '#f87171' : (pushing ? '#38bdf8' : '#34d399') }} 
                  onClick={(e) => e.stopPropagation()}
                >
                  {pushing && <RefreshCw size={12} className="animate-spin text-sky-400" />}
                  {!pushing && !pushMessage.startsWith('Error') && <Check size={12} className="text-emerald-400" />}
                  {pushMessage}
                </span>
              )}
            </div>
            {/* Controls and Collapse Chevron in Top Right */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }} onClick={(e) => e.stopPropagation()}>
              {!isSavedCollapsed && totalSavedPages > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button
                    className="btn-styled inactive"
                    style={{ padding: '4px 8px', minWidth: 'auto', background: 'rgba(255,255,255,0.05)', borderRadius: '6px' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSavedPage(p => Math.max(0, p - 1));
                    }}
                    disabled={savedPage === 0}
                  >
                    <ChevronLeft size={12} />
                  </button>
                  <span className="text-[10px] font-bold text-slate-400">{savedPage + 1} / {totalSavedPages}</span>
                  <button
                    className="btn-styled inactive"
                    style={{ padding: '4px 8px', minWidth: 'auto', background: 'rgba(255,255,255,0.05)', borderRadius: '6px' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSavedPage(p => Math.min(totalSavedPages - 1, p + 1));
                    }}
                    disabled={savedPage >= totalSavedPages - 1}
                  >
                    <ChevronRight size={12} />
                  </button>
                </div>
              )}

              <div 
                onClick={() => setIsSavedCollapsed(!isSavedCollapsed)}
                style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}
              >
                <ChevronRight 
                  size={18} 
                  className="text-slate-400 transition-transform duration-200 hover:text-white" 
                  style={{ transform: isSavedCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' }} 
                />
              </div>
            </div>
          </div>
          <p className="text-slate-400 text-sm w-full mb-8" style={{ maxWidth: 1100 }}>
            Saved hardware preset slots on your LED sign
          </p>

          {!isSavedCollapsed && (
            <div className="glass-panel p-10 w-full" style={{ maxWidth: 1100 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '24px', width: '100%' }}>
                {savedPresets.slice(savedPage * slotsPerPage, (savedPage + 1) * slotsPerPage).map((slot, localIdx) => {
                  const globalIdx = savedPage * slotsPerPage + localIdx;
                  const p = slot.preset;
                  
                  if (!p) {
                    return (
                      <div
                        key={slot.slotNumber}
                        onDragOver={(e) => { e.preventDefault(); setSavedDragOverIdx(globalIdx); }}
                        onDragLeave={() => setSavedDragOverIdx(null)}
                        onDrop={(e) => handleDropOnSlot(e, globalIdx)}
                        onPointerDown={handlePointerDown}
                        onPointerUp={(e) => handlePointerUp(e, () => playSavedPreset(globalIdx, null))}
                        className="preset-card relative flex flex-col items-center justify-center bg-black/30 hover:bg-black/40 transition-all cursor-pointer"
                        style={{
                          border: globalIdx === savedDragOverIdx ? '2px dashed var(--accent-primary)' : '1px dashed rgba(255,255,255,0.1)',
                          boxShadow: globalIdx === savedDragOverIdx ? 'var(--neon-shadow)' : 'none',
                        }}
                      >
                        <div className="absolute top-2 left-2 text-[8px] font-bold text-slate-500 tracking-wider">
                          SLOT {slot.slotNumber}
                        </div>
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
                      </div>
                    );
                  }

                  const isClock = p.mode === 'clock' || p.id === 'clock-default';
                  return (
                    <div
                      key={slot.slotNumber}
                      className="preset-card relative group overflow-hidden transition-all"
                      onPointerDown={handlePointerDown}
                      onPointerUp={(e) => handlePointerUp(e, () => playSavedPreset(globalIdx, p))}
                      draggable={true}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', `saved-slot:${globalIdx}`);
                        e.dataTransfer.effectAllowed = 'move';
                        setSavedDraggedIdx(globalIdx);
                      }}
                      onDragEnd={() => {
                        setSavedDraggedIdx(null);
                        setSavedDragOverIdx(null);
                      }}
                      onDragOver={(e) => { e.preventDefault(); setSavedDragOverIdx(globalIdx); }}
                      onDragLeave={() => setSavedDragOverIdx(null)}
                      onDrop={(e) => handleDropOnSlot(e, globalIdx)}
                      style={{
                        cursor: 'grab',
                        opacity: globalIdx === savedDraggedIdx ? 0.4 : 1,
                        transform: globalIdx === savedDraggedIdx ? 'scale(0.98)' : 'none',
                        border: globalIdx === savedDragOverIdx ? '2px dashed var(--accent-primary)' : '1px solid var(--glass-border)',
                        boxShadow: globalIdx === savedDragOverIdx ? 'var(--neon-shadow)' : 'none',
                        userSelect: 'none'
                      }}
                    >
                      {isClock ? (
                        <ClockPresetCardPreview preset={p} now={now} />
                      ) : p.pixels && p.pixels.length > 1280 ? (
                        <AnimatedPresetCardPreview preset={p} />
                      ) : p.mode === 'text' ? (
                        <TextPresetCardPreview preset={p} />
                      ) : p.thumbnail ? (
                        <img src={p.thumbnail} className="preset-card-image" draggable={false} />
                      ) : (
                        <div className="preset-card-content" style={{ background: p.bgColor || '#000000' }}>
                          <p style={{ color: p.textColor || '#fff', fontSize: 16, fontWeight: 900, transform: `rotate(${p.rotation || 0}deg)`, textAlign: 'center', lineHeight: 1 }}>
                            {p.text || p.name || 'Untitled'}
                          </p>
                        </div>
                      )}

                      <div 
                        className="preset-card-overlay flex gap-2" 
                        onPointerDown={handlePointerDown}
                        onPointerUp={(e) => {
                          e.stopPropagation();
                          handlePointerUp(e, () => playSavedPreset(globalIdx, p));
                        }}
                      >
                        <button
                          onPointerDown={(e) => e.stopPropagation()}
                          onPointerUp={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setAssigningSlotIndex(globalIdx);
                          }}
                          className="btn-styled preset-card-edit-btn"
                          title={p ? "Update Preset" : "Assign Preset"}
                        >
                          {p ? <RefreshCw size={14} className="mr-2" /> : <Plus size={14} className="mr-2" />} 
                          {p ? "Update" : "Assign"}
                        </button>
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
                      Assign Local Preset to Slot {savedPresets[assigningSlotIndex]?.slotNumber}
                    </h3>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0, flexWrap: 'nowrap' }}>
                      {savedPresets[assigningSlotIndex]?.preset && (
                        <button
                          onClick={async () => {
                            
                            if (assigningSlotIndex < 12) {
                              try {
                                setPushing(true);
                                setPushMessage(`Clearing slot ${assigningSlotIndex + 1}...`);
                                await axios.delete(`${API_BASE}/delete-preset/${assigningSlotIndex}?mac=${encodeURIComponent(status.address || DEFAULT_MAC)}`);
                                setPushMessage(`Cleared slot ${assigningSlotIndex + 1}!`);
                                
                                const nextSaved = [...savedPresets];
                                nextSaved[assigningSlotIndex] = { ...nextSaved[assigningSlotIndex], preset: null };
                                setSavedPresets(nextSaved);
                                localStorage.setItem('savedPresets', JSON.stringify(nextSaved));
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

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px', marginBottom: '24px' }}>
                    {presets?.filter(p => {
                      if (!p?.id) return false;
                      if (assigningSlotIndex !== null && assigningSlotIndex < 12) {
                        if (p.mode === 'clock' || p.id === 'clock-default' || p.text?.includes('|||')) {
                          return false;
                        }
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
                          {isClock ? (
                            <ClockPresetCardPreview preset={p} now={now} />
                          ) : p.pixels && p.pixels.length > 1280 ? (
                            <AnimatedPresetCardPreview preset={p} />
                          ) : p.mode === 'text' ? (
                            <TextPresetCardPreview preset={p} />
                          ) : p.thumbnail ? (
                            <img src={p.thumbnail} className="preset-card-image" draggable={false} />
                          ) : (
                            <div className="preset-card-content" style={{ background: p.bgColor || '#000000' }}>
                              <p style={{ color: p.textColor || '#fff', fontSize: 16, fontWeight: 900, transform: `rotate(${p.rotation || 0}deg)`, textAlign: 'center', lineHeight: 1 }}>
                                {p.text || p.name || 'Untitled'}
                              </p>
                            </div>
                          )}
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
function CalendarView({ status, events, loading, fetchEvents, now, onPush, pushMessage, pushing }) {
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
      <p className="text-slate-400 text-sm w-full mb-8">
        {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
      </p>

      {calError && (
        <div className={`flex items-center gap-3 text-sm mb-6 w-full px-5 py-3 rounded-2xl bg-amber-400/10 text-amber-300`}>
          <AlertCircle size={14} />{calError}
        </div>
      )}

      {!status.calendar_connected ? (
        <div className="glass-panel w-full py-20 px-16 flex flex-col items-center justify-center text-center">
          <p className="text-slate-400 mb-10">Sign in with Google to see today's meetings.</p>
          <button 
            onClick={handleSignIn}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
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
    return `${fmt.format(sDate)} – ${fmt.format(eDate)}`;
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
              href={ev.id ? `https://calendar.google.com/calendar/r/eventedit/${ev.id}` : ev.html_link} 
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
              href={ev.id ? `https://calendar.google.com/calendar/r/eventedit/${ev.id}` : ev.html_link} 
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
function MediaView({ status, isModalOpen, setIsModalOpen, presets, setPresets, onPush, onPushSuccess, now, pushMessage, pushing }) {
  const [isLocalCollapsed, setIsLocalCollapsed] = useState(!!status.connected);
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

  useEffect(() => {
    setIsLocalCollapsed(!!status.connected);
  }, [status.connected]);

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
  const [form, setForm] = useState({
    name: '', 
    text: '', 
    textColor: '#ffffff', 
    bgColor: '#000000', 
    animation: 'static', 
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
    clockStyle: 'custom',
    isDefault: false
  });

  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(600);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const handleMediaFile = (file) => {
    if (!file) return;

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
    } else {
      const reader = new FileReader();
      reader.onload = (re) => {
        const img = new Image();
        img.onload = () => {
          imageObjRef.current = img;
          initializeMediaCrop(img, re.target.result, fileType);
        };
        img.src = re.target.result;
      };
      reader.readAsDataURL(file);
    }
  };

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

  const runCropRender = (img, x, y, w, h, bgColor = '#000000') => {
    if (!img) return Array(64 * 20).fill(0);
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 20;
    const ctx = canvas.getContext('2d');
    if (!ctx) return Array(64 * 20).fill(0);
    
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

  // Throttled animation preview loop for video/gif
  useEffect(() => {
    if (!isModalOpen || form.mode !== 'image' || !form.imgSrc || !imageObjRef.current) return;
    if (form.fileType !== 'video') return;

    let active = true;
    let lastTime = 0;
    const fps = 10;
    const interval = 1000 / fps;

    const loop = (timestamp) => {
      if (!active) return;
      
      if (!lastTime) lastTime = timestamp;
      const elapsed = timestamp - lastTime;

      if (elapsed > interval) {
        lastTime = timestamp - (elapsed % interval);
        
        if (imageObjRef.current) {
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
      }
      
      requestAnimationFrame(loop);
    };

    const animId = requestAnimationFrame(loop);
    return () => {
      active = false;
      cancelAnimationFrame(animId);
    };
  }, [isModalOpen, form.mode, form.imgSrc, form.fileType, form.canvasX, form.canvasY, form.zoom, form.dwBase, form.dhBase, form.bgColor]);

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
    if (!isModalOpen || form.mode !== 'text' || form.animation !== 'move-left') {
      setScrollOffset(0);
      return;
    }
    const interval = setInterval(() => {
      setScrollOffset(prev => prev + 1);
    }, Math.max(10, 80 - (form.speed !== undefined ? form.speed : 13) * 5)); // Higher speed = lower interval
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
      textToDraw = form.text || '';
      ctx.font = '18px Arial, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      
      const tw = ctx.measureText(textToDraw).width;
      let x = 32 - (tw / 2); // Center statically by default
      if (form.animation === 'move-left') {
         x = 64 - (scrollOffset % (64 + tw));
      }
      ctx.fillText(textToDraw, x, 10);
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
  }, [form.text, form.mode, form.timeFormat, form.showSeconds, isModalOpen, previewTime, scrollOffset, form.animation, form.clockStyle]);

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
      return form.pixels;
    }

    const numFrames = 8;
    const frames = [];

    if (form.fileType === 'video') {
      const video = imageObjRef.current;
      if (!video) return form.pixels;
      
      const duration = video.duration || 2;
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
      }

      video.currentTime = originalTime;
      if (wasPlaying) {
        video.play().catch(err => console.log('Video resume error:', err));
      }
    } else if (form.fileType === 'gif') {
      try {
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
        return { pixels: response.data.pixels, speed: response.data.speed, frameDurationMs: response.data.frameDurationMs };
      } catch (err) {
        console.error('GIF backend processing failed:', err);
        return { pixels: form.pixels };
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
    setIsSaving(true);
    try {
      let finalPixels = form.pixels;
      if (form.mode === 'image') {
        const res = await getAnimationStitchedPixels();
        if (res && res.pixels) {
          finalPixels = res.pixels;
          if (res.speed !== undefined) {
            form.speed = res.speed;
          }
          if (res.frameDurationMs !== undefined) {
            form.frameDurationMs = res.frameDurationMs;
          }
        }
      }

      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = 64;
      thumbCanvas.height = 20;
      const thumbCtx = thumbCanvas.getContext('2d');
      let thumbnail;
      
      if (form.mode === 'clock') {
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
              const color = p.startsWith('#') ? p : (form.textColor || '#ffffff');
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

      const presetData = { 
        ...form, 
        pixels: finalPixels,
        thumbnail,
        name: form.mode === 'clock' ? 'Digital Clock' :
              form.mode === 'drawing' ? `Drawing ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 
              form.mode === 'image' ? (form.fileType === 'video' ? 'Custom Video' : form.fileType === 'gif' ? 'Custom GIF' : 'Custom Image') : (form.text || 'Untitled Text') 
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
      setPresets(nextPresets);

      setIsModalOpen(false);
      setEditingId(null);
      setForm({
        name: '', text: '', textColor: '#ffffff', bgColor: '#000000',
        animation: 'move-left', speed: 8, rotation: 0,
        mode: 'text', pixels: Array(64 * 20).fill(0),
        imgSrc: null, fileType: null, canvasX: 0, canvasY: 0, zoom: 1, dwBase: 64, dhBase: 20,
        timeFormat: '12h',
        showSeconds: true,
        clockStyle: 'custom',
        isDefault: false
      });

      // Do not push saved preset automatically to the sign
    } catch (err) {
      console.error('Error saving preset:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const startEdit = (p, e) => {
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
    setForm({ ...p, fileType, pixels: normalizedPixels });
    setIsModalOpen(true);
  };

  const deletePreset = (id, e) => {
    if (e) e.stopPropagation();
    setPresets(presets.filter(p => p.id !== (id || editingId)));
    if (!id) {
      setIsModalOpen(false);
      setEditingId(null);
    }
  };

  const pushPreset = async (p) => {
    try {
      await onPush(p, true);
      if (onPushSuccess) onPushSuccess();
    } catch (e) {
      // Errors are handled in handlePush globally
    }
  };

  return (
    <div className="flex flex-col items-center py-12 w-full">
      <div 
        onClick={() => setIsLocalCollapsed(!isLocalCollapsed)}
        style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%', maxWidth: 1100, marginBottom: 8, cursor: 'pointer' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <ImageIcon className="text-emerald-400 shrink-0" size={24} />
          <h3 className="text-2xl font-black" style={{ margin: 0 }}>Local Presets</h3>
          {pushMessage && (
            <span
              className="text-xs font-bold ml-4 flex items-center gap-1.5"
              style={{ color: pushMessage.startsWith('Error') ? '#f87171' : (pushing ? '#38bdf8' : '#34d399') }}
              onClick={(e) => e.stopPropagation()}
            >
              {pushing && <RefreshCw size={12} className="animate-spin text-sky-400" />}
              {!pushing && !pushMessage.startsWith('Error') && <Check size={12} className="text-emerald-400" />}
              {pushMessage}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <ChevronRight 
            size={18} 
            className="text-slate-400 transition-transform duration-200 hover:text-white" 
            style={{ transform: isLocalCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' }} 
          />
        </div>
      </div>
      <p className="text-slate-400 text-sm w-full mb-8" style={{ maxWidth: 1100 }}>
        Presets and custom animations for your LED sign
      </p>
 
      {!isLocalCollapsed && (
        <div className="glass-panel p-10 w-full" style={{ maxWidth: 1100 }}>
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: 'repeat(2, 1fr)', 
            gap: '24px', 
            width: '100%',
            pointerEvents: pushing ? 'none' : 'auto',
            opacity: pushing ? 0.6 : 1,
            transition: 'opacity 0.25s ease'
          }}>
            <div
              className="preset-card relative group overflow-hidden border-white/5 hover:border-emerald-500/30 transition-all flex flex-col items-center justify-center gap-2 bg-black"
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
              style={{
                cursor: 'pointer'
              }}
              onClick={() => {
                editingModeRef.current = 'text'; setEditingId(null); setForm({name: '', text: '', textColor: '#ffffff', bgColor: '#000000', animation: 'move-left', speed: 8, rotation: 0, mode: 'text', pixels: Array(64 * 20).fill(0), spacing: 1, views: 1, imgSrc: null, canvasX: 0, canvasY: 0, zoom: 1, dwBase: 64, dhBase: 20, timeFormat: '12h', showSeconds: true, clockStyle: 'custom', isDefault: false}); setIsModalOpen(true);
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
              return (
              <div 
                key={p.id} 
                className="preset-card"
                draggable={!p.isDefault}
                onDragStart={(e) => handleDragStart(e, p.id)}
                onDragOver={(e) => handleDragOver(e, p.id)}
                onDrop={(e) => handleDrop(e, p.id)}
                onDragEnd={handleDragEnd}
                style={{
                  cursor: p.isDefault ? 'default' : 'grab',
                  opacity: p.id === draggedId ? 0.4 : 1,
                  transform: p.id === draggedId ? 'scale(0.98)' : 'none',
                  border: p.id === dragOverId ? '2px dashed var(--accent-primary)' : '1px solid var(--glass-border)',
                  boxShadow: p.id === dragOverId ? 'var(--neon-shadow)' : 'none',
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
              >
                {p.isDefault && (
                  <div className="preset-card-badge">
                    Default
                  </div>
                )}
                {isClock ? (
                  <ClockPresetCardPreview preset={p} now={now} />
                ) : p.pixels && p.pixels.length > 1280 ? (
                  <AnimatedPresetCardPreview preset={p} />
                ) : p.mode === 'text' ? (
                  <TextPresetCardPreview preset={p} />
                ) : p.thumbnail ? (
                  <img src={p.thumbnail} className="preset-card-image" draggable={false} />
                ) : (
                  <div className="preset-card-content" style={{ background: p.bgColor || '#000000' }}>
                    <p style={{ color: p.textColor || '#fff', fontSize: 16, fontWeight: 900, transform: `rotate(${p.rotation || 0}deg)`, textAlign: 'center', lineHeight: 1 }}>
                      {p.text || p.name || 'Untitled'}
                    </p>
                  </div>
                )}
                <div className="preset-card-overlay">
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
              onClick={() => setIsModalOpen(false)}
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative glass-panel"
              style={{ position: 'relative', padding: '32px', width: '100%', maxWidth: '768px', overflowY: 'auto', maxHeight: '90vh' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
                <h3 style={{ fontSize: '24px', fontWeight: 900, margin: 0 }}>{editingId ? 'Edit Preset' : 'Create Preset'}</h3>
                <button onClick={() => setIsModalOpen(false)} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer' }} onMouseOver={e => e.currentTarget.style.color='#fff'} onMouseOut={e => e.currentTarget.style.color='#64748b'}><X size={24} /></button>
              </div>

              <div style={{ marginBottom: '32px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div className="bg-black/60 p-3 rounded-2xl border border-white/10 shadow-2xl relative group">
                  <div className="overflow-x-auto overflow-y-hidden custom-scrollbar">
                    {form.mode === 'image' ? (
                      !form.imgSrc ? (
                        <div 
                          ref={containerRef}
                          onClick={() => document.getElementById('img-upload').click()}
                          onDragEnter={handleMediaDragOver}
                          onDragOver={handleMediaDragOver}
                          onDragLeave={handleMediaDragLeave}
                          onDrop={handleMediaDrop}
                          className="cursor-pointer relative group"
                          style={{ 
                            display: 'grid', 
                            gridTemplateColumns: 'repeat(64, 1fr)', 
                            gridTemplateRows: 'repeat(20, 1fr)', 
                            gap: '1px', 
                            background: form.bgColor || '#000000', 
                            padding: '8px', 
                            borderRadius: '8px',
                            width: '100%', 
                            aspectRatio: '64/20', 
                            minWidth: '600px',
                            border: '1px solid rgba(255,255,255,0.1)',
                            position: 'relative',
                            boxSizing: 'border-box'
                          }}
                        >
                          {Array(64 * 20).fill(0).map((_, i) => (
                            <div 
                              key={i}
                              style={{ 
                                background: 'rgba(255,255,255,0.05)',
                                borderRadius: '1px',
                                opacity: 0.2
                              }}
                            />
                          ))}
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
                          style={{
                            position: 'relative',
                            width: '100%',
                            minWidth: '600px',
                            aspectRatio: '64/20',
                            margin: '0 auto',
                            overflow: 'hidden',
                            borderRadius: '8px',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            backgroundColor: form.bgColor || '#000000',
                            userSelect: 'none',
                            cursor: 'grab',
                            boxSizing: 'border-box'
                          }}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            if (!form.imgSrc || !imageObjRef.current) return;
                            
                            const scale = containerWidth / 64;
                            const startX = e.clientX;
                            const startY = e.clientY;
                            const initialCanvasX = form.canvasX;
                            const initialCanvasY = form.canvasY;
                            
                            const container = e.currentTarget;
                            container.style.cursor = 'grabbing';
                            
                            const handleDragMove = (moveEvent) => {
                              const dx = moveEvent.clientX - startX;
                              const dy = moveEvent.clientY - startY;
                              
                              let newCanvasX = initialCanvasX + dx / scale;
                              let newCanvasY = initialCanvasY + dy / scale;
                              
                              // Auto snap to viewport edges (Photoshop-like snapping)
                              const snapThreshold = 2.0; // 2 pixels in canvas grid coordinates
                              const imageWidth = form.dwBase * form.zoom;
                              const imageHeight = form.dhBase * form.zoom;

                              // Snap Left Edge (canvasX = 0)
                              if (Math.abs(newCanvasX) < snapThreshold) {
                                newCanvasX = 0;
                              }
                              // Snap Right Edge (canvasX + imageWidth = 64)
                              if (Math.abs(newCanvasX + imageWidth - 64) < snapThreshold) {
                                newCanvasX = 64 - imageWidth;
                              }
                              // Snap Top Edge (canvasY = 0)
                              if (Math.abs(newCanvasY) < snapThreshold) {
                                newCanvasY = 0;
                              }
                              // Snap Bottom Edge (canvasY + imageHeight = 20)
                              if (Math.abs(newCanvasY + imageHeight - 20) < snapThreshold) {
                                newCanvasY = 20 - imageHeight;
                              }
                              
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
                          {/* Image underlay */}
                          {form.fileType === 'video' ? (
                            <video 
                              src={form.imgSrc} 
                              autoPlay
                              loop
                              muted
                              playsInline
                              style={{ 
                                position: 'absolute', 
                                left: `${form.canvasX * (containerWidth / 64)}px`, 
                                top: `${form.canvasY * (containerWidth / 64)}px`, 
                                width: `${form.dwBase * form.zoom * (containerWidth / 64)}px`, 
                                height: `${form.dhBase * form.zoom * (containerWidth / 64)}px`, 
                                pointerEvents: 'none',
                                userSelect: 'none',
                                maxWidth: 'none',
                                objectFit: 'fill'
                              }} 
                            />
                          ) : (
                            <img 
                              src={form.imgSrc} 
                              alt="Crop Preview"
                              style={{ 
                                position: 'absolute', 
                                left: `${form.canvasX * (containerWidth / 64)}px`, 
                                top: `${form.canvasY * (containerWidth / 64)}px`, 
                                width: `${form.dwBase * form.zoom * (containerWidth / 64)}px`, 
                                height: `${form.dhBase * form.zoom * (containerWidth / 64)}px`, 
                                pointerEvents: 'none',
                                userSelect: 'none',
                                maxWidth: 'none'
                              }} 
                            />
                          )}
                          
                          {/* Viewport Frame */}
                          <div 
                            style={{
                              position: 'absolute',
                              left: 0,
                              top: 0,
                              width: '100%',
                              height: '100%',
                              border: '1px solid rgba(255, 255, 255, 0.25)',
                              pointerEvents: 'none',
                              boxSizing: 'border-box'
                            }}
                          >
                            <div style={{ position: 'absolute', left: '33.33%', top: 0, bottom: 0, width: 0, borderLeft: '1px dashed rgba(255, 255, 255, 0.2)' }} />
                            <div style={{ position: 'absolute', left: '66.67%', top: 0, bottom: 0, width: 0, borderLeft: '1px dashed rgba(255, 255, 255, 0.2)' }} />
                            <div style={{ position: 'absolute', top: '33.33%', left: 0, right: 0, height: 0, borderTop: '1px dashed rgba(255, 255, 255, 0.2)' }} />
                            <div style={{ position: 'absolute', top: '66.67%', left: 0, right: 0, height: 0, borderTop: '1px dashed rgba(255, 255, 255, 0.2)' }} />
                            
                            <div style={{ position: 'absolute', top: 0, left: 0, width: '16px', height: '16px', borderTop: '4px solid var(--accent-primary)', borderLeft: '4px solid var(--accent-primary)' }} />
                            <div style={{ position: 'absolute', top: 0, right: 0, width: '16px', height: '16px', borderTop: '4px solid var(--accent-secondary)', borderRight: '4px solid var(--accent-secondary)' }} />
                            <div style={{ position: 'absolute', bottom: 0, left: 0, width: '16px', height: '16px', borderBottom: '4px solid var(--accent-primary)', borderLeft: '4px solid var(--accent-primary)' }} />
                            <div style={{ position: 'absolute', bottom: 0, right: 0, width: '16px', height: '16px', borderBottom: '4px solid var(--accent-secondary)', borderRight: '4px solid var(--accent-secondary)' }} />
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
                      )
                    ) : (
                      <div 
                        onMouseDown={(e) => {
                          if (form.mode !== 'drawing') return;
                          setUndoStack(prev => [...prev, [...form.pixels]]);
                          setRedoStack([]);
                        }}
                        style={{ 
                          display: 'grid', 
                          gridTemplateColumns: 'repeat(64, 1fr)', 
                          gridTemplateRows: 'repeat(20, 1fr)', 
                          gap: '1px', 
                          background: form.bgColor || '#000000', 
                          padding: '8px', 
                          borderRadius: '8px',
                          width: '100%', 
                          aspectRatio: '64/20', 
                          minWidth: '600px',
                          border: '1px solid rgba(255,255,255,0.1)',
                          boxSizing: 'border-box'
                        }}
                      >
                        {form.pixels.map((p, i) => {
                          const activeColor = form.mode === 'clock' ? (form.clockStyle === 'default' ? '#ffffff' : (form.textColor || '#10B981')) : (form.textColor || '#ffffff');
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
                                background: 
                                  form.mode === 'drawing' 
                                    ? (p && p !== 0 ? p : 'rgba(255,255,255,0.05)')
                                    : (p > 0.05 ? activeColor : 'rgba(255,255,255,0.05)'),
                                borderRadius: '1px',
                                cursor: form.mode === 'drawing' ? 'crosshair' : 'default',
                                opacity: 
                                  form.mode === 'drawing'
                                    ? (p && p !== 0 ? 1 : 0.2)
                                    : (p > 0.05 ? p : 0.2),
                                boxShadow: 
                                  (form.mode !== 'drawing' && p > 0.05)
                                    ? `0 0 12px ${activeColor}` 
                                    : (form.mode === 'drawing' && p && p !== 0) 
                                      ? `0 0 12px ${p}` 
                                      : 'none',
                                transition: 'all 75ms'
                              }}
                            />
                          );
                        })}
                      </div>
                    )}
                  </div>
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
                        IMAGE/VIDEO
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
                  ) : form.mode === 'clock' ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', marginTop: '8px', padding: '16px', background: 'rgba(255,255,255,0.02)', borderRadius: '20px', border: '1px solid rgba(255,255,255,0.05)' }}>
                      {/* Style Toggle */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <span style={{ fontSize: '12px', fontWeight: 500, color: '#94a3b8', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Clock Style</span>
                        <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
                          <button 
                            type="button"
                            onClick={() => setForm(prev => ({ ...prev, clockStyle: 'default' }))}
                            className={`btn-styled text-[10px] px-4 py-2 rounded-full transition-all ${form.clockStyle === 'default' ? '' : 'inactive'}`}
                            style={{ fontSize: 10, fontWeight: 900, flex: 1 }}
                          >
                            Default
                          </button>
                          <button 
                            type="button"
                            onClick={() => setForm(prev => ({ ...prev, clockStyle: 'custom' }))}
                            className={`btn-styled text-[10px] px-4 py-2 rounded-full transition-all ${form.clockStyle !== 'default' ? '' : 'inactive'}`}
                            style={{ fontSize: 10, fontWeight: 900, flex: 1 }}
                          >
                            Custom
                          </button>
                        </div>
                      </div>

                      {form.clockStyle !== 'default' && (
                        <>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px' }}>
                            <HslColorSlider 
                              label="Clock Colour" 
                              value={form.textColor || '#10B981'} 
                              onChange={val => setForm(prev => ({ ...prev, textColor: val }))} 
                            />
                            <HslColorSlider 
                              label="Background Colour" 
                              value={form.bgColor || '#000000'} 
                              onChange={val => setForm(prev => ({ ...prev, bgColor: val }))} 
                            />
                          </div>

                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', width: '100%' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                              <span style={{ fontSize: '12px', fontWeight: 500, color: '#94a3b8', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Time Format</span>
                              <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
                                <button 
                                  type="button"
                                  onClick={() => setForm(prev => ({ ...prev, timeFormat: '12h' }))}
                                  className={`btn-styled text-[10px] px-4 py-2 rounded-full transition-all ${form.timeFormat !== '12h' ? 'inactive' : ''}`}
                                  style={{ fontSize: 10, fontWeight: 900, flex: 1 }}
                                >
                                  12-HOUR
                                </button>
                                <button 
                                  type="button"
                                  onClick={() => setForm(prev => ({ ...prev, timeFormat: '24h' }))}
                                  className={`btn-styled text-[10px] px-4 py-2 rounded-full transition-all ${form.timeFormat !== '24h' ? 'inactive' : ''}`}
                                  style={{ fontSize: 10, fontWeight: 900, flex: 1 }}
                                >
                                  24-HOUR
                                </button>
                              </div>
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                              <span style={{ fontSize: '12px', fontWeight: 500, color: '#94a3b8', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Show Seconds</span>
                              <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
                                <button 
                                  type="button"
                                  onClick={() => setForm(prev => ({ ...prev, showSeconds: true }))}
                                  className={`btn-styled text-[10px] px-4 py-2 rounded-full transition-all ${form.showSeconds === false ? 'inactive' : ''}`}
                                  style={{ fontSize: 10, fontWeight: 900, flex: 1 }}
                                >
                                  ON
                                </button>
                                <button 
                                  type="button"
                                  onClick={() => setForm(prev => ({ ...prev, showSeconds: false }))}
                                  className={`btn-styled text-[10px] px-4 py-2 rounded-full transition-all ${form.showSeconds !== false ? 'inactive' : ''}`}
                                  style={{ fontSize: 10, fontWeight: 900, flex: 1 }}
                                >
                                  OFF
                                </button>
                              </div>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  ) : form.mode === 'image' ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', width: '100%' }}>
                      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '16px', width: '100%' }}>
                        <input 
                          type="file" 
                          id="img-upload" 
                          hidden 
                          accept="image/*,video/*"
                          onChange={e => handleMediaFile(e.target.files?.[0])}
                        />
                        {form.imgSrc && (
                          <>
                            <div className="brightness-rail glass-panel" style={{ padding: '12px 16px', flex: 1, width: 'auto', display: 'flex', alignItems: 'center', gap: '14px' }}>
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
                              />
                              <span className="font-bold text-slate-500 w-12 text-[10px] text-right">{(form.zoom || 1).toFixed(1)}x</span>
                            </div>
                            <button
                              onClick={() => {
                                if (imageObjRef.current && typeof imageObjRef.current.pause === 'function') {
                                  imageObjRef.current.pause();
                                }
                                imageObjRef.current = null;
                                setForm(prev => ({
                                  ...prev,
                                  imgSrc: '',
                                  fileType: null,
                                  pixels: Array(64 * 20).fill(0),
                                  zoom: 1.0,
                                  canvasX: 0,
                                  canvasY: 0,
                                  bgColor: '#000000'
                                }));
                              }}
                              className="btn-styled text-[10px] px-4 py-2 bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/25"
                              style={{ padding: '12px 16px', borderRadius: '18px', display: 'inline-flex', alignItems: 'center', gap: '8px', whiteSpace: 'nowrap', flexShrink: 0 }}
                            >
                              <Trash2 size={14} /> Remove Image
                            </button>
                          </>
                        )}
                      </div>
                      {form.imgSrc && (
                        <div style={{ marginTop: '8px' }}>
                          <HslColorSlider 
                            label="Background Colour" 
                            value={form.bgColor || '#000000'} 
                            onChange={val => setForm(prev => ({ ...prev, bgColor: val }))} 
                          />
                        </div>
                      )}
                    </div>
                  ) : (
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
                  )}
                </div>

                {/* Conditional Form Options */}
                {form.mode === 'text' && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px', marginTop: '20px' }}>
                    <HslColorSlider 
                      label="Text Colour" 
                      value={form.textColor || '#ffffff'} 
                      onChange={val => setForm({...form, textColor: val})} 
                    />
                    <HslColorSlider 
                      label="Background Colour" 
                      value={form.bgColor || '#000000'} 
                      onChange={val => setForm({...form, bgColor: val})} 
                    />
                  </div>
                )}

                {form.mode === 'text' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '24px' }}>
                    <div className="flex flex-col gap-2">
                      <label className="text-[10px] font-bold text-slate-500 uppercase ml-1">Animation</label>
                      <select 
                        className="input-field" 
                        style={{ background: '#1a1a1f', color: '#fff' }}
                        value={form.animation} 
                        onChange={e => setForm({...form, animation: e.target.value})}
                      >
                        {['static','move-left','move-right','move-up','move-down','snow','bubble','flicker'].map(a => (
                          <option key={a} value={a} style={{ background: '#1a1a1f', color: '#fff' }}>{a}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}



                <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
                  <button 
                    className="btn-styled py-4" 
                    style={{ flex: 3 }}
                    onClick={handleSave}
                    disabled={isSaving}
                  >
                    {isSaving ? 'Processing...' : (editingId ? 'Update Preset' : 'Save Preset')}
                  </button>
                  {editingId && (
                    <button 
                      className="btn-styled py-4 bg-red-500/10 border-red-500/20 text-red-400 hover:bg-red-500/20" 
                      style={{ flex: 1, minWidth: 'auto' }}
                      onClick={() => deletePreset()}
                    >
                      <Trash2 size={18} />
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
