import axios from 'axios';

export const SERVER_API_VERSION = 7;

export function requireCurrentServer(status) {
  if (!(status?.api_version >= SERVER_API_VERSION)) {
    throw new Error('The LED Sign server is running an older version. Use Restart Servers in the LED Sign tray menu, then try again.');
  }
}

export function requireCompletedWrite(result) {
  if (result?.written_to_sign === true) return;
  if (result?.written_to_sign === false) {
    throw new Error('The server could not finish writing to the sign. Reconnect the sign and try again.');
  }
  throw new Error('The server did not confirm the slot write. Restart LED Sign’s servers and try again.');
}

let _serverVersionChecked = false;

async function postToCurrentServer(path, payload, options = {}) {
  try {
    if (!_serverVersionChecked) {
      const { data: status } = await axios.get('/status', { timeout: 30000 });
      requireCurrentServer(status);
      _serverVersionChecked = true;
    }
    return await axios.post(path, payload, options);
  } catch (error) {
    if (axios.isAxiosError(error) && !error.response) {
      throw new Error(`Cannot reach the server (${error.code || error.message})`);
    }
    throw error;
  }
}

export async function savePresetToSign(payload, options = {}) {
  const overallTimeoutMs = options.timeout || 300000;
  const progressId = payload?.progress_id || `save-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const requestPayload = { ...payload, progress_id: progressId, async_mode: true };
  const requestOptions = { ...options, timeout: Math.min(overallTimeoutMs, 60000) };

  const response = await postToCurrentServer('/save-preset', requestPayload, requestOptions);
  if (!response?.data?.async) {
    requireCompletedWrite(response.data);
    return response;
  }

  const startMs = Date.now();
  let consecutiveErrors = 0;

  while (Date.now() - startMs < overallTimeoutMs) {
    if (options.signal?.aborted) {
      await cancelSavePreset(progressId);
      const cancelErr = new Error('Save cancelled');
      cancelErr.name = 'CanceledError';
      throw cancelErr;
    }

    await new Promise((resolve) => setTimeout(resolve, 750));

    if (options.signal?.aborted) {
      await cancelSavePreset(progressId);
      const cancelErr = new Error('Save cancelled');
      cancelErr.name = 'CanceledError';
      throw cancelErr;
    }

    let prog;
    try {
      const res = await axios.get(`/save-progress/${encodeURIComponent(progressId)}`, {
        timeout: 15000,
        signal: options.signal,
      });
      prog = res.data;
      consecutiveErrors = 0;
    } catch (pollErr) {
      if (axios.isCancel(pollErr) || pollErr.name === 'CanceledError' || pollErr.name === 'AbortError') {
        await cancelSavePreset(progressId);
        throw pollErr;
      }
      consecutiveErrors += 1;
      if (consecutiveErrors >= 10) {
        throw pollErr;
      }
      continue;
    }

    if (prog?.done) {
      if (prog.cancelled) {
        const err = new Error(prog.error || 'Save cancelled');
        err.response = { status: 499, data: { detail: prog.error || 'Save cancelled' } };
        throw err;
      }
      if (prog.error) {
        const err = new Error(prog.error);
        err.response = { status: prog.status_code || 500, data: { detail: prog.error } };
        throw err;
      }
      requireCompletedWrite(prog.result);
      return { data: prog.result };
    }
  }

  throw new Error('Timed out waiting for the sign to finish saving the preset.');
}

export async function cancelSavePreset(progressId) {
  try {
    const url = progressId ? `/cancel-save-preset/${encodeURIComponent(progressId)}` : '/cancel-save-preset';
    return await axios.post(url);
  } catch (err) {
    console.warn('[cancelSavePreset] Failed to notify server:', err);
  }
}

export const processVideoMedia = (payload) => postToCurrentServer('/process-video', payload, { timeout: 0 });

export const getGeminiStatus = async () => {
  try {
    return await axios.get('/gemini-status');
  } catch (err) {
    if (err?.response?.status === 404) {
      return await axios.get('/api/gemini/status');
    }
    throw err;
  }
};

export const generateGeminiMedia = async (payload) => {
  try {
    return await axios.post('/gemini-generate', payload, { timeout: 180000 });
  } catch (err) {
    if (err?.response?.status === 404) {
      return await axios.post('/api/gemini/generate', payload, { timeout: 180000 });
    }
    throw err;
  }
};

export const getAiProviders = async () => {
  try {
    return await axios.get('/ai-providers');
  } catch (err) {
    if (err?.response?.status === 404) {
      return await axios.get('/api/ai/providers');
    }
    throw err;
  }
};

export const getOpenAiStatus = async () => {
  try {
    return await axios.get('/openai-status');
  } catch (err) {
    if (err?.response?.status === 404) {
      return await axios.get('/api/openai/status');
    }
    throw err;
  }
};

export const generateOpenAiMedia = async (payload) => {
  try {
    return await axios.post('/openai-generate', payload, { timeout: 180000 });
  } catch (err) {
    if (err?.response?.status === 404) {
      return await axios.post('/api/openai/generate', payload, { timeout: 180000 });
    }
    throw err;
  }
};

export const generateAiMedia = async (payload) => {
  try {
    return await axios.post('/ai-generate', payload, { timeout: 180000 });
  } catch (err) {
    if (err?.response?.status === 404) {
      if (payload.provider === 'openai') {
        return await generateOpenAiMedia(payload);
      }
      return await generateGeminiMedia(payload);
    }
    throw err;
  }
};

export const getLoyCategories = async ({ refresh = false } = {}) => {
  const params = refresh ? { refresh: true } : {};
  try {
    const { data } = await axios.get('/loy-categories', { params });
    if (typeof data === 'string') {
      try { return JSON.parse(data); } catch { return { items: [] }; }
    }
    return data;
  } catch (err) {
    if (err?.response?.status === 404) {
      const { data } = await axios.get('/api/loy/categories', { params });
      if (typeof data === 'string') {
      try { return JSON.parse(data); } catch { return { items: [] }; }
    }
    return data;
    }
    throw err;
  }
};

export const getLoyMaterials = async ({ tagId = 48, tagType = 0, pageIndex = 0, pageCount = 24, search = '' } = {}) => {
  const params = {
    tag_id: tagId,
    tag_type: tagType,
    page_index: pageIndex,
    page_count: pageCount
  };
  if (search && search.trim()) {
    params.search = search.trim();
  }
  try {
    const { data } = await axios.get('/loy-materials', { params });
    if (typeof data === 'string') {
      try { return JSON.parse(data); } catch { return { items: [] }; }
    }
    return data;
  } catch (err) {
    if (err?.response?.status === 404) {
      const { data } = await axios.get('/api/loy/materials', { params });
      if (typeof data === 'string') {
      try { return JSON.parse(data); } catch { return { items: [] }; }
    }
    return data;
    }
    throw err;
  }
};

export const getLoyProxyMediaUrl = (url) => {
  return `/api/loy/proxy-media?url=${encodeURIComponent(url)}`;
};

export const getLoyAuthStatus = async () => {
  try {
    const { data } = await axios.get('/loy-auth-status');
    if (typeof data === 'string') {
      try { return JSON.parse(data); } catch { return { items: [] }; }
    }
    return data;
  } catch (err) {
    if (err?.response?.status === 404) {
      const { data } = await axios.get('/api/loy/auth-status');
      if (typeof data === 'string') {
      try { return JSON.parse(data); } catch { return { items: [] }; }
    }
    return data;
    }
    throw err;
  }
};

export const loyLogin = async ({ user, pwd }) => {
  try {
    const { data } = await axios.post('/loy-login', { user, pwd });
    if (typeof data === 'string') {
      try { return JSON.parse(data); } catch { return { items: [] }; }
    }
    return data;
  } catch (err) {
    if (err?.response?.status === 404) {
      const { data } = await axios.post('/api/loy/login', { user, pwd });
      if (typeof data === 'string') {
      try { return JSON.parse(data); } catch { return { items: [] }; }
    }
    return data;
    }
    throw err;
  }
};

export const loyLogout = async () => {
  try {
    const { data } = await axios.post('/loy-logout');
    if (typeof data === 'string') {
      try { return JSON.parse(data); } catch { return { items: [] }; }
    }
    return data;
  } catch (err) {
    if (err?.response?.status === 404) {
      const { data } = await axios.post('/api/loy/logout');
      if (typeof data === 'string') {
      try { return JSON.parse(data); } catch { return { items: [] }; }
    }
    return data;
    }
    throw err;
  }
};

export const uploadLoyMaterial = async ({ fileBlob, name = 'LEDSign Custom', mark = 'custom,64x20', tags = 1 }) => {
  const formData = new FormData();
  formData.append('file', fileBlob, 'canvas.png');
  formData.append('name', name);
  formData.append('mark', mark);
  formData.append('tags', String(tags || 1));

  try {
    const { data } = await axios.post('/loy-upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    if (typeof data === 'string') {
      try { return JSON.parse(data); } catch { return { items: [] }; }
    }
    return data;
  } catch (err) {
    if (err?.response?.status === 404) {
      const { data } = await axios.post('/api/loy/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      if (typeof data === 'string') {
      try { return JSON.parse(data); } catch { return { items: [] }; }
    }
    return data;
    }
    throw err;
  }
};

export const getLoyMyMaterials = async ({ pageIndex = 0, pageCount = 24 } = {}) => {
  const params = { page_index: pageIndex, page_count: pageCount };
  try {
    const { data } = await axios.get('/loy-my-materials', { params });
    if (typeof data === 'string') {
      try { return JSON.parse(data); } catch { return { items: [] }; }
    }
    return data;
  } catch (err) {
    if (err?.response?.status === 404) {
      const { data } = await axios.get('/api/loy/my-materials', { params });
      if (typeof data === 'string') {
      try { return JSON.parse(data); } catch { return { items: [] }; }
    }
    return data;
    }
    throw err;
  }
};

export const searchGoogleImages = async (params) => {
  try {
    const { data } = await axios.get('/api/google/images', { params });
    if (typeof data === 'string') {
      try { return JSON.parse(data); } catch { return { items: [] }; }
    }
    return data;
  } catch (err) {
    if (err?.response?.status === 404) {
      const { data } = await axios.get('/google-images', { params });
      if (typeof data === 'string') {
      try { return JSON.parse(data); } catch { return { items: [] }; }
    }
    return data;
    }
    throw err;
  }
};

export const getGoogleProxyMediaUrl = (url) => {
  if (!url) return '';
  return `/api/google/proxy-media?url=${encodeURIComponent(url)}`;
};
