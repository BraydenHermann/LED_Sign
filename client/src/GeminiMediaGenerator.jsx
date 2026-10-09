import React, { useState, useRef } from 'react';
import { 
  Paperclip, Film, Image as ImageIcon, X, 
  RefreshCw, AlertCircle, Layers, ChevronDown
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { generateGeminiMedia } from './serverApi';

// Official Google Gemini 4-pointed sparkle icon
export const GeminiLogo = ({ size = 16, className = "" }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="currentColor" 
    className={className} 
    style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}
  >
    <path d="M12 2C12 7.523 7.523 12 2 12C7.523 12 12 16.477 12 22C12 16.477 16.477 12 22 12C16.477 12 12 7.523 12 2Z" />
  </svg>
);

const PROMPT_SUGGESTIONS = [
  {
    label: 'Retro neon cyber sports car...',
    prompt: 'Retro neon cyber sports car speeding through night city'
  },
  {
    label: 'Animated 8-bit cute cat...',
    prompt: 'Animated 8-bit cute cat walking across the screen'
  },
  {
    label: 'Pulsing audio equalizer...',
    prompt: 'Pulsing audio equalizer frequency visualizer bars'
  },
  {
    label: 'Pixel campfire...',
    prompt: 'Pixel campfire with glowing embers and smoke'
  }
];

export default function GeminiMediaGenerator({ 
  form, 
  setForm, 
  imageObjRef, 
  onGenerated,
  onNotify
}) {
  const [isExpanded, setIsExpanded] = useState(false); // Collapsed by default
  const [prompt, setPrompt] = useState('');
  const [mediaType, setMediaType] = useState('gif'); // 'gif' | 'image'
  const [attachments, setAttachments] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState('');

  const fileInputRef = useRef(null);

  const handleAddFiles = (files) => {
    if (!files || !files.length) return;
    setError('');
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target.result;
        setAttachments(prev => [
          ...prev,
          {
            id: `${Date.now()}-${Math.random()}`,
            name: file.name,
            mimeType: file.type || 'image/png',
            data: dataUrl
          }
        ]);
      };
      reader.readAsDataURL(file);
    });
  };

  const handleAttachCurrentCanvas = () => {
    setError('');
    if (form.imgSrc) {
      setAttachments(prev => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random()}`,
          name: 'Current Preset Media',
          mimeType: form.fileType === 'video' ? 'video/mp4' : 'image/png',
          data: form.imgSrc
        }
      ]);
      return;
    }

    if (Array.isArray(form.pixels) && form.pixels.some(p => p && p !== 0)) {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 20;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = form.bgColor || '#000000';
        ctx.fillRect(0, 0, 64, 20);
        form.pixels.forEach((col, idx) => {
          if (col && typeof col === 'string' && col.startsWith('#')) {
            const x = idx % 64;
            const y = Math.floor(idx / 64);
            ctx.fillStyle = col;
            ctx.fillRect(x, y, 1, 1);
          }
        });
        const dataUrl = canvas.toDataURL('image/png');
        setAttachments(prev => [
          ...prev,
          {
            id: `${Date.now()}-${Math.random()}`,
            name: 'Current Canvas Snapshot (64x20)',
            mimeType: 'image/png',
            data: dataUrl
          }
        ]);
        return;
      }
    }

    setError('Current preset does not contain any artwork to attach.');
  };

  const handleRemoveAttachment = (id) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      setError('Please enter a description for your media.');
      return;
    }

    setError('');
    setIsGenerating(true);

    try {
      const payload = {
        prompt: prompt.trim(),
        mediaType: mediaType,
        attachments: attachments.map(a => ({
          data: a.data,
          mimeType: a.mimeType
        }))
      };

      const res = await generateGeminiMedia(payload);
      const data = res.data;
      if (!data?.pixels || !data?.imgSrc) {
        throw new Error('Gemini generation completed but returned invalid media data.');
      }

      if (imageObjRef) {
        imageObjRef.current = null;
      }

      setForm(prev => ({
        ...prev,
        mode: 'image',
        fileType: data.fileType || mediaType,
        imgSrc: data.imgSrc,
        pixels: data.pixels,
        name: prev.name ? prev.name : (data.suggestedName || `Gemini ${mediaType.toUpperCase()}`),
        dwBase: 64,
        dhBase: 20,
        zoom: 1.0,
        canvasX: 0,
        canvasY: 0,
        frameDurationMs: data.frameDurationMs || (mediaType === 'image' ? undefined : 80),
        frameDurationsMs: data.frameDurationsMs || undefined
      }));

      if (onGenerated) {
        onGenerated(data);
      }

      if (onNotify) {
        onNotify(`Generated ${mediaType === 'gif' ? 'GIF' : 'Image'} preset successfully!`);
      }
    } catch (err) {
      console.error('[GeminiMediaGenerator] Generation error:', err);
      const detail = err?.response?.data?.detail || err?.message || 'Error communicating with Gemini';
      setError(detail);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div 
      className="glass-panel" 
      style={{ 
        padding: '14px 16px', 
        borderRadius: '16px', 
        background: 'rgba(255, 255, 255, 0.03)', 
        border: '1px solid rgba(255, 255, 255, 0.08)', 
        display: 'flex', 
        flexDirection: 'column'
      }}
    >
      {/* Collapsible Header Bar */}
      <div 
        onClick={() => setIsExpanded(prev => !prev)}
        style={{ 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'space-between', 
          cursor: 'pointer',
          userSelect: 'none'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ 
            width: '28px', 
            height: '28px', 
            borderRadius: '8px', 
            background: 'linear-gradient(135deg, #10b981 0%, #3b82f6 100%)', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center',
            color: '#ffffff'
          }}>
            <GeminiLogo size={16} />
          </div>
          <div>
            <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 800, color: '#f8fafc' }}>
              Gemini AI Studio
            </h4>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <ChevronDown 
            size={18} 
            className="text-slate-400 transition-transform duration-200" 
            style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }} 
          />
        </div>
      </div>

      {/* Expandable Body */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '14px' }}
          >
            {/* Format Selector: Equal width GIF Animation & Image */}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                onClick={() => setMediaType('gif')}
                className={`btn-styled text-[11px] py-2 px-3 rounded-xl transition-all ${mediaType === 'gif' ? 'active' : 'inactive'}`}
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
              >
                <Film size={13} />
                <span>GIF Animation</span>
              </button>
              <button
                type="button"
                onClick={() => setMediaType('image')}
                className={`btn-styled text-[11px] py-2 px-3 rounded-xl transition-all ${mediaType === 'image' ? 'active' : 'inactive'}`}
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
              >
                <ImageIcon size={13} />
                <span>Image</span>
              </button>
            </div>

            {/* Prompt Textarea */}
            <div style={{ position: 'relative' }}>
              <textarea
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={`Describe the ${mediaType === 'gif' ? 'looping GIF animation' : 'pixel art image'} you want Gemini to create...`}
                className="input-field"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  borderRadius: '12px',
                  padding: '12px 14px',
                  fontSize: '12px',
                  resize: 'vertical',
                  minHeight: '75px',
                  background: 'rgba(0, 0, 0, 0.4)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: '#ffffff',
                  lineHeight: '1.4'
                }}
                disabled={isGenerating}
              />
            </div>

            {/* Try Suggestions: Shorter & thinner, placed above Attach File / Current Canvas */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: '-4px' }}>
              <span style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 700 }}>Try:</span>
              {PROMPT_SUGGESTIONS.map((sug, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setPrompt(sug.prompt)}
                  style={{
                    padding: '2px 8px',
                    fontSize: '10px',
                    lineHeight: '1.3',
                    borderRadius: '8px',
                    background: 'linear-gradient(135deg, #10b981 0%, #3b82f6 100%)',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    color: '#ffffff',
                    fontWeight: 600,
                    cursor: 'pointer',
                    boxShadow: '0 2px 6px rgba(16, 185, 129, 0.25)',
                    transition: 'all 0.15s ease',
                    whiteSpace: 'nowrap',
                    display: 'inline-flex',
                    alignItems: 'center'
                  }}
                  onMouseOver={(e) => { 
                    e.currentTarget.style.opacity = '0.9';
                    e.currentTarget.style.boxShadow = '0 3px 10px rgba(16, 185, 129, 0.4)';
                  }}
                  onMouseOut={(e) => { 
                    e.currentTarget.style.opacity = '1';
                    e.currentTarget.style.boxShadow = '0 2px 6px rgba(16, 185, 129, 0.25)';
                  }}
                >
                  {sug.label}
                </button>
              ))}
            </div>

            {/* Action Buttons Right-Aligned Below Text Prompt Area */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
              <input
                type="file"
                ref={fileInputRef}
                hidden
                multiple
                accept="image/*,video/*"
                onChange={(e) => {
                  handleAddFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="btn-styled text-[10px] px-3 py-1.5 flex items-center gap-1.5"
                style={{ borderRadius: '10px' }}
                title="Attach an image or video as style/character reference"
              >
                <Paperclip size={12} />
                <span>Attach File</span>
              </button>
              <button
                type="button"
                onClick={handleAttachCurrentCanvas}
                className="btn-styled text-[10px] px-3 py-1.5 flex items-center gap-1.5"
                style={{ borderRadius: '10px' }}
                title="Attach current preset canvas as reference context"
              >
                <Layers size={12} />
                <span>Current Canvas</span>
              </button>
            </div>

            {/* Attached Media Chips (Shown if attachments exist) */}
            {attachments.length > 0 && (
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '-2px' }}>
                {attachments.map((att) => (
                  <div
                    key={att.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      background: 'rgba(255, 255, 255, 0.08)',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                      borderRadius: '8px',
                      padding: '4px 8px',
                      fontSize: '11px',
                      color: '#e2e8f0'
                    }}
                  >
                    {att.mimeType.startsWith('image/') ? (
                      <img src={att.data} alt="Context" style={{ width: '22px', height: '22px', objectFit: 'cover', borderRadius: '4px' }} />
                    ) : (
                      <Film size={16} className="text-slate-400" />
                    )}
                    <span style={{ maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {att.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleRemoveAttachment(att.id)}
                      style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: '2px', display: 'flex' }}
                      onMouseOver={(e) => { e.currentTarget.style.color = '#ef4444'; }}
                      onMouseOut={(e) => { e.currentTarget.style.color = '#94a3b8'; }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Error Banner */}
            {error && (
              <div style={{ padding: '8px 12px', borderRadius: '10px', background: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#fca5a5', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <AlertCircle size={14} className="flex-shrink-0" />
                <span style={{ flex: 1 }}>{error}</span>
              </div>
            )}

            {/* Generate Action Button - disabled until prompt has text */}
            <button
              type="button"
              onClick={(e) => {
                if (!prompt.trim() || isGenerating) {
                  e.preventDefault();
                  e.stopPropagation();
                  return;
                }
                handleGenerate();
              }}
              disabled={isGenerating || !prompt.trim()}
              className="transition-all duration-200"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '13px 22px',
                borderRadius: '12px',
                border: 'none',
                fontWeight: 700,
                fontSize: '14px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
                background: isGenerating 
                  ? 'rgba(255, 255, 255, 0.1)' 
                  : (!prompt.trim() ? 'rgba(255, 255, 255, 0.06)' : 'linear-gradient(135deg, #10b981 0%, #3b82f6 100%)'),
                color: !prompt.trim() ? 'rgba(255, 255, 255, 0.35)' : '#ffffff',
                boxShadow: (isGenerating || !prompt.trim()) ? 'none' : '0 4px 15px rgba(16, 185, 129, 0.3)',
                cursor: isGenerating ? 'wait' : (!prompt.trim() ? 'not-allowed' : 'pointer'),
                opacity: (!prompt.trim() && !isGenerating) ? 0.5 : 1,
                transform: 'none'
              }}
              onMouseEnter={(e) => {
                if (!isGenerating && prompt.trim()) {
                  e.currentTarget.style.filter = 'brightness(1.06)';
                  e.currentTarget.style.boxShadow = '0 6px 20px rgba(16, 185, 129, 0.45)';
                  e.currentTarget.style.borderRadius = '12px';
                }
              }}
              onMouseLeave={(e) => {
                if (!isGenerating && prompt.trim()) {
                  e.currentTarget.style.filter = 'none';
                  e.currentTarget.style.boxShadow = '0 4px 15px rgba(16, 185, 129, 0.3)';
                  e.currentTarget.style.borderRadius = '12px';
                }
              }}
            >
              {isGenerating ? (
                <>
                  <RefreshCw size={15} className="animate-spin text-white" style={{ marginRight: '6px' }} />
                  <span>Generating {mediaType === 'gif' ? 'GIF' : 'Image'}...</span>
                </>
              ) : (
                <>
                  <GeminiLogo size={16} />
                  <span>Generate {mediaType === 'gif' ? 'GIF' : 'Image'}</span>
                </>
              )}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
