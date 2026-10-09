import React, { useState, useRef, useEffect } from 'react';
import { 
  Paperclip, Film, Image as ImageIcon, X, 
  RefreshCw, AlertCircle, Layers, ChevronDown, KeyRound
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { generateAiMedia, getAiProviders } from './serverApi';

// Brand colors
const GEMINI_GRADIENT = 'linear-gradient(to right, #4796E3 0%, #9177C7 50%, #CA6673 100%)';
const OPENAI_COLOR = '#74AA9C';

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

// Official OpenAI / ChatGPT spiral flower logo
export const OpenAILogo = ({ size = 16, className = "" }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="currentColor" 
    className={className} 
    style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}
  >
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1683a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4947zm-9.66-4.1354a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1401-1.6564zm-1.1214-10.428a4.4566 4.4566 0 0 1 2.3657-1.9804V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1683a.0757.0757 0 0 1-.071 0l-4.8303-2.7865a4.504 4.504 0 0 1-1.6466-6.1243zm16.5902 4.5363L13.226 8.9816 15.246 7.8133a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.6435zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.3797V7.0474a.0804.0804 0 0 1 .0332-.0615l4.9814-2.8764a4.4992 4.4992 0 0 1 6.1402 1.6564 4.4708 4.4708 0 0 1 .5536 3.0137zm-8.8878-3.0658a4.4992 4.4992 0 0 1 2.8764 1.0408l-.1419.0804-4.7783 2.7582a.7948.7948 0 0 0-.3927.6813v6.7369L7.904 14.887a.071.071 0 0 1-.038-.052V9.2524a4.504 4.504 0 0 1 4.4945-4.4947zm-.0095 5.5636l2.919 1.6843v3.3685L12 17.6534l-2.919-1.6843v-3.3685L12 10.9208z" />
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
  const [provider, setProvider] = useState(() => localStorage.getItem('led_ai_provider') || 'gemini');
  const [providersStatus, setProvidersStatus] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [mediaType, setMediaType] = useState('gif'); // 'gif' | 'image'
  const [attachments, setAttachments] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState('');
  const [showKeys, setShowKeys] = useState(false);
  const [geminiKey, setGeminiKey] = useState(() => localStorage.getItem('led_gemini_api_key') || '');
  const [openaiKey, setOpenaiKey] = useState(() => localStorage.getItem('led_openai_api_key') || '');

  // Automatically close API key section whenever the parent section is collapsed
  useEffect(() => {
    if (!isExpanded) {
      setShowKeys(false);
    }
  }, [isExpanded]);

  const updateKey = (which, value) => {
    const v = value.trim();
    if (which === 'gemini') {
      setGeminiKey(v);
      v ? localStorage.setItem('led_gemini_api_key', v) : localStorage.removeItem('led_gemini_api_key');
    } else {
      setOpenaiKey(v);
      v ? localStorage.setItem('led_openai_api_key', v) : localStorage.removeItem('led_openai_api_key');
    }
  };

  const fileInputRef = useRef(null);

  // Fetch configured AI providers from backend on mount with retry
  useEffect(() => {
    let isMounted = true;
    const fetchProviders = () => {
      getAiProviders()
        .then(res => {
          if (isMounted && res?.data) {
            setProvidersStatus(res.data);
            if (!localStorage.getItem('led_ai_provider')) {
              setProvider(res.data.default_provider || 'gemini');
            }
          }
        })
        .catch(err => {
          console.debug('[AI Studio] Could not fetch AI providers, will retry:', err);
        });
    };
    fetchProviders();
    const interval = setInterval(() => {
      if (isMounted && !providersStatus) {
        fetchProviders();
      }
    }, 3000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [providersStatus]);

  const handleSelectProvider = (newProvider) => {
    setProvider(newProvider);
    localStorage.setItem('led_ai_provider', newProvider);
    setError('');
  };

  // Check if current canvas has artwork or media loaded
  const hasCanvasContent = Boolean(
    form?.mode === 'image'
      ? form?.imgSrc
      : form?.mode === 'drawing'
        ? (Array.isArray(form?.pixels) && form.pixels.some(p => p && p !== 0 && p !== '0' && p !== '#000000' && p !== '#000'))
        : form?.imgSrc
  );

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
    if (!hasCanvasContent) {
      setError('Current canvas is empty.');
      return;
    }

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

    if (form.mode === 'drawing' && Array.isArray(form.pixels) && form.pixels.some(p => p && p !== 0 && p !== '0' && p !== '#000000' && p !== '#000')) {
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
            name: 'Canvas Snapshot (64x20)',
            mimeType: 'image/png',
            data: dataUrl
          }
        ]);
        return;
      }
    }

    setError('Current canvas does not contain any media to copy.');
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
        provider: provider,
        apiKey: (provider === 'openai' ? openaiKey : geminiKey) || undefined,
        prompt: prompt.trim(),
        mediaType: mediaType,
        attachments: attachments.map(a => ({
          data: a.data,
          mimeType: a.mimeType
        }))
      };

      const res = await generateAiMedia(payload);
      const data = res.data;
      if (!data?.pixels || !data?.imgSrc) {
        throw new Error('AI generation completed but returned invalid media data.');
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
        name: prev.name ? prev.name : (data.suggestedName || `${provider === 'openai' ? 'OpenAI' : 'Gemini'} ${mediaType.toUpperCase()}`),
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
        onNotify(`Generated ${mediaType === 'gif' ? 'GIF' : 'Image'} with ${provider === 'openai' ? 'OpenAI' : 'Gemini'} successfully!`);
      }
    } catch (err) {
      console.error('[AI Studio] Generation error:', err);
      const detail = err?.response?.data?.detail || err?.message || 'Error communicating with AI service';
      setError(detail);
    } finally {
      setIsGenerating(false);
    }
  };

  const isGemini = provider === 'gemini';
  const providerLabel = isGemini ? 'Gemini' : 'OpenAI';
  const activeBrandBg = isGemini ? GEMINI_GRADIENT : OPENAI_COLOR;
  const activeBrandShadow = isGemini 
    ? '0 0 0 1px rgba(255, 255, 255, 0.2), 0 2px 8px rgba(71, 150, 227, 0.25)' 
    : '0 0 0 1px rgba(255, 255, 255, 0.2), 0 2px 8px rgba(116, 170, 156, 0.25)';

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
      {/* Collapsible Header Bar - No agent label in title */}
      <div 
        onClick={() => {
          setIsExpanded(prev => {
            const next = !prev;
            if (!next) setShowKeys(false);
            return next;
          });
        }}
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
            background: activeBrandBg,
            backgroundRepeat: 'no-repeat',
            backgroundClip: 'padding-box',
            boxShadow: activeBrandShadow,
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center',
            color: '#ffffff',
            transition: 'all 0.25s ease',
            overflow: 'hidden'
          }}>
            {isGemini ? <GeminiLogo size={16} /> : <OpenAILogo size={16} />}
          </div>
          <div>
            <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 800, color: '#f8fafc' }}>
              {isGemini ? 'Google Gemini' : 'OpenAI'}
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
            {/* AI Provider Selector: Google Gemini vs ChatGPT */}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                onClick={() => handleSelectProvider('gemini')}
                className="btn-styled text-[11px] py-1.5 px-3 rounded-xl transition-all"
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  background: isGemini ? GEMINI_GRADIENT : 'rgba(255, 255, 255, 0.05)',
                  backgroundRepeat: 'no-repeat',
                  backgroundClip: 'padding-box',
                  border: 'none',
                  boxShadow: isGemini ? '0 0 0 1px rgba(255, 255, 255, 0.2), 0 2px 8px rgba(71, 150, 227, 0.25)' : '0 0 0 1px rgba(255, 255, 255, 0.08)',
                  color: isGemini ? '#ffffff' : 'var(--text-muted)',
                  overflow: 'hidden'
                }}
              >
                <GeminiLogo size={13} />
                <span>Google Gemini</span>
              </button>
              <button
                type="button"
                onClick={() => handleSelectProvider('openai')}
                className="btn-styled text-[11px] py-1.5 px-3 rounded-xl transition-all"
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  background: !isGemini ? OPENAI_COLOR : 'rgba(255, 255, 255, 0.05)',
                  backgroundRepeat: 'no-repeat',
                  backgroundClip: 'padding-box',
                  border: 'none',
                  boxShadow: !isGemini ? '0 0 0 1px rgba(255, 255, 255, 0.2), 0 2px 8px rgba(116, 170, 156, 0.25)' : '0 0 0 1px rgba(255, 255, 255, 0.08)',
                  color: !isGemini ? '#ffffff' : 'var(--text-muted)',
                  overflow: 'hidden'
                }}
              >
                <OpenAILogo size={13} />
                <span>OpenAI</span>
              </button>
            </div>

            {/* API Key: users can supply their own keys to override server .env keys */}
            {(() => {
              const activeKey = isGemini ? geminiKey : openaiKey;
              const providerInfo = isGemini ? providersStatus?.gemini : providersStatus?.openai;
              const serverHasKey = Boolean(providerInfo?.configured);

              let statusText = 'No key set';
              let statusColor = '#fca5a5';

              if (activeKey) {
                statusText = 'Custom key active';
                statusColor = '#86efac';
              } else if (serverHasKey) {
                statusText = 'Server key configured (.env)';
                statusColor = '#86efac';
              } else if (providersStatus === null) {
                statusText = 'Checking...';
                statusColor = '#94a3b8';
              } else {
                statusText = 'No key set';
                statusColor = '#fca5a5';
              }

              const linkStyle = { color: isGemini ? '#8fb8ee' : '#a7d5cb', textDecoration: 'underline' };
              const inputStyle = {
                width: '100%', boxSizing: 'border-box', borderRadius: '8px', padding: '7px 10px',
                fontSize: '11px', background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.12)', color: '#fff'
              };
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <button
                    type="button"
                    onClick={() => setShowKeys(v => !v)}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#94a3b8', textAlign: 'left' }}
                  >
                    <KeyRound size={12} />
                    <span>API Key</span>
                    <span style={{ color: statusColor, fontWeight: 600 }}>· {statusText}</span>
                    <ChevronDown size={12} className="text-slate-400 transition-transform duration-200" style={{ transform: showKeys ? 'rotate(180deg)' : 'rotate(0deg)' }} />
                  </button>
                  <AnimatePresence initial={false}>
                    {showKeys && (
                      <motion.div
                        key="key-drawer"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2 }}
                        style={{ overflow: 'hidden' }}
                      >
                        <div style={{ padding: '10px 12px', borderRadius: '10px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '11px', color: '#cbd5e1' }}>
                          {/* Server Key Indicator */}
                          {serverHasKey && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px', borderRadius: '6px', background: 'rgba(34, 197, 94, 0.1)', border: '1px solid rgba(34, 197, 94, 0.25)', color: '#86efac', fontSize: '11px' }}>
                              <span>✓</span>
                              <span>
                                Server key configured in <code>.env</code>{providerInfo?.masked_key ? ` (${providerInfo.masked_key})` : ''}
                              </span>
                            </div>
                          )}

                          {isGemini ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <label style={{ fontWeight: 700 }}>Custom Gemini API Key (Optional)</label>
                                {geminiKey && (
                                  <button
                                    type="button"
                                    onClick={() => updateKey('gemini', '')}
                                    style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: '10px', textDecoration: 'underline', cursor: 'pointer', padding: 0 }}
                                  >
                                    Clear (use server key)
                                  </button>
                                )}
                              </div>
                              <input
                                type="password"
                                autoComplete="off"
                                value={geminiKey}
                                onChange={(e) => updateKey('gemini', e.target.value)}
                                placeholder={serverHasKey ? "Using server key (paste here to override)" : "AIza..."}
                                style={inputStyle}
                              />
                              <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" style={linkStyle}>
                                Get a free Gemini key at Google AI Studio ↗
                              </a>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <label style={{ fontWeight: 700 }}>Custom OpenAI Key (Optional)</label>
                                {openaiKey && (
                                  <button
                                    type="button"
                                    onClick={() => updateKey('openai', '')}
                                    style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: '10px', textDecoration: 'underline', cursor: 'pointer', padding: 0 }}
                                  >
                                    Clear (use server key)
                                  </button>
                                )}
                              </div>
                              <input
                                type="password"
                                autoComplete="off"
                                value={openaiKey}
                                onChange={(e) => updateKey('openai', e.target.value)}
                                placeholder={serverHasKey ? "Using server key (paste here to override)" : "sk-..."}
                                style={inputStyle}
                              />
                              <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" style={linkStyle}>
                                Create an OpenAI key at platform.openai.com ↗
                              </a>
                            </div>
                          )}

                          <span style={{ color: '#94a3b8', lineHeight: '1.4' }}>
                            {serverHasKey 
                              ? "Leave blank to use the server's configured key, or enter your own personal key if you prefer to use your own rate limits or billing funds."
                              : "Enter your personal key here. It will be stored only in your local browser."}
                          </span>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })()}

            {/* Format Selector: Follows agent branding */}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                onClick={() => setMediaType('gif')}
                className="btn-styled text-[11px] py-2 px-3 rounded-xl transition-all"
                style={{ 
                  flex: 1, 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center', 
                  gap: '6px',
                  background: mediaType === 'gif' ? activeBrandBg : 'rgba(255, 255, 255, 0.05)',
                  backgroundRepeat: 'no-repeat',
                  backgroundClip: 'padding-box',
                  border: 'none',
                  boxShadow: mediaType === 'gif' ? activeBrandShadow : '0 0 0 1px rgba(255, 255, 255, 0.08)',
                  color: mediaType === 'gif' ? '#ffffff' : 'var(--text-muted)',
                  overflow: 'hidden'
                }}
              >
                <Film size={13} />
                <span>GIF Animation</span>
              </button>
              <button
                type="button"
                onClick={() => setMediaType('image')}
                className="btn-styled text-[11px] py-2 px-3 rounded-xl transition-all"
                style={{ 
                  flex: 1, 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center', 
                  gap: '6px',
                  background: mediaType === 'image' ? activeBrandBg : 'rgba(255, 255, 255, 0.05)',
                  backgroundRepeat: 'no-repeat',
                  backgroundClip: 'padding-box',
                  border: 'none',
                  boxShadow: mediaType === 'image' ? activeBrandShadow : '0 0 0 1px rgba(255, 255, 255, 0.08)',
                  color: mediaType === 'image' ? '#ffffff' : 'var(--text-muted)',
                  overflow: 'hidden'
                }}
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
                placeholder={`Describe the ${mediaType === 'gif' ? 'looping GIF animation' : 'pixel art image'} you want ${providerLabel} to create...`}
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

            {/* Try Suggestions: Styled matching active AI provider without pixel seams */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: '-4px' }}>
              <span style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 700 }}>Try:</span>
              {PROMPT_SUGGESTIONS.map((sug, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setPrompt(sug.prompt)}
                  style={{
                    padding: '3px 9px',
                    fontSize: '10px',
                    lineHeight: '1.3',
                    borderRadius: '8px',
                    background: activeBrandBg,
                    backgroundRepeat: 'no-repeat',
                    backgroundClip: 'padding-box',
                    border: 'none',
                    color: '#ffffff',
                    fontWeight: 600,
                    cursor: 'pointer',
                    boxShadow: isGemini 
                      ? '0 0 0 1px rgba(255, 255, 255, 0.2), 0 2px 6px rgba(71, 150, 227, 0.25)' 
                      : '0 0 0 1px rgba(255, 255, 255, 0.2), 0 2px 6px rgba(116, 170, 156, 0.25)',
                    transition: 'all 0.15s ease',
                    whiteSpace: 'nowrap',
                    display: 'inline-flex',
                    alignItems: 'center',
                    overflow: 'hidden'
                  }}
                  onMouseOver={(e) => { 
                    e.currentTarget.style.opacity = '0.92';
                    e.currentTarget.style.boxShadow = isGemini 
                      ? '0 0 0 1px rgba(255, 255, 255, 0.3), 0 3px 10px rgba(145, 119, 199, 0.45)' 
                      : '0 0 0 1px rgba(255, 255, 255, 0.3), 0 3px 10px rgba(116, 170, 156, 0.45)';
                  }}
                  onMouseOut={(e) => { 
                    e.currentTarget.style.opacity = '1';
                    e.currentTarget.style.boxShadow = isGemini 
                      ? '0 0 0 1px rgba(255, 255, 255, 0.2), 0 2px 6px rgba(71, 150, 227, 0.25)' 
                      : '0 0 0 1px rgba(255, 255, 255, 0.2), 0 2px 6px rgba(116, 170, 156, 0.25)';
                  }}
                >
                  {sug.label}
                </button>
              ))}
            </div>

            {/* Action Buttons Right-Aligned: Attach File & Copy Canvas follow agent branding */}
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
                style={{ 
                  borderRadius: '10px',
                  background: activeBrandBg,
                  backgroundRepeat: 'no-repeat',
                  backgroundClip: 'padding-box',
                  border: 'none',
                  boxShadow: activeBrandShadow,
                  color: '#ffffff',
                  overflow: 'hidden'
                }}
                title="Attach an image or video as style/character reference"
              >
                <Paperclip size={12} />
                <span>Attach File</span>
              </button>
              <button
                type="button"
                disabled={!hasCanvasContent}
                onClick={handleAttachCurrentCanvas}
                className="btn-styled text-[10px] px-3 py-1.5 flex items-center gap-1.5"
                style={{ 
                  borderRadius: '10px',
                  background: hasCanvasContent ? activeBrandBg : 'rgba(255, 255, 255, 0.05)',
                  backgroundRepeat: 'no-repeat',
                  backgroundClip: 'padding-box',
                  border: hasCanvasContent ? 'none' : '1px solid rgba(255, 255, 255, 0.08)',
                  boxShadow: hasCanvasContent ? activeBrandShadow : 'none',
                  color: hasCanvasContent ? '#ffffff' : 'rgba(255, 255, 255, 0.35)',
                  opacity: !hasCanvasContent ? 0.45 : 1,
                  cursor: !hasCanvasContent ? 'not-allowed' : 'pointer',
                  overflow: 'hidden'
                }}
                title={hasCanvasContent ? "Copy current preset canvas as reference context" : "Current canvas is empty"}
              >
                <Layers size={12} />
                <span>Copy Canvas</span>
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

            {/* Generate Action Button - matches active AI branding */}
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
                  : (!prompt.trim() 
                      ? 'rgba(255, 255, 255, 0.06)' 
                      : activeBrandBg),
                backgroundRepeat: 'no-repeat',
                backgroundClip: 'padding-box',
                color: !prompt.trim() ? 'rgba(255, 255, 255, 0.35)' : '#ffffff',
                boxShadow: (isGenerating || !prompt.trim()) 
                  ? 'none' 
                  : (isGemini 
                      ? '0 0 0 1px rgba(255, 255, 255, 0.2), 0 4px 15px rgba(71, 150, 227, 0.35)' 
                      : '0 0 0 1px rgba(255, 255, 255, 0.2), 0 4px 15px rgba(116, 170, 156, 0.35)'),
                cursor: isGenerating ? 'wait' : (!prompt.trim() ? 'not-allowed' : 'pointer'),
                opacity: (!prompt.trim() && !isGenerating) ? 0.5 : 1,
                transform: 'none',
                overflow: 'hidden'
              }}
              onMouseEnter={(e) => {
                if (!isGenerating && prompt.trim()) {
                  e.currentTarget.style.filter = 'brightness(1.06)';
                  e.currentTarget.style.boxShadow = isGemini 
                    ? '0 0 0 1px rgba(255, 255, 255, 0.3), 0 6px 20px rgba(145, 119, 199, 0.5)' 
                    : '0 0 0 1px rgba(255, 255, 255, 0.3), 0 6px 20px rgba(116, 170, 156, 0.5)';
                  e.currentTarget.style.borderRadius = '12px';
                }
              }}
              onMouseLeave={(e) => {
                if (!isGenerating && prompt.trim()) {
                  e.currentTarget.style.filter = 'none';
                  e.currentTarget.style.boxShadow = isGemini 
                    ? '0 0 0 1px rgba(255, 255, 255, 0.2), 0 4px 15px rgba(71, 150, 227, 0.35)' 
                    : '0 0 0 1px rgba(255, 255, 255, 0.2), 0 4px 15px rgba(116, 170, 156, 0.35)';
                  e.currentTarget.style.borderRadius = '12px';
                }
              }}
            >
              {isGenerating ? (
                <>
                  <RefreshCw size={15} className="animate-spin text-white" style={{ marginRight: '6px' }} />
                  <span>Generating {mediaType === 'gif' ? 'GIF' : 'Image'} with {providerLabel}...</span>
                </>
              ) : (
                <>
                  {isGemini ? <GeminiLogo size={16} /> : <OpenAILogo size={16} />}
                  <span>Generate {mediaType === 'gif' ? 'GIF' : 'Image'} with {providerLabel}</span>
                </>
              )}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
