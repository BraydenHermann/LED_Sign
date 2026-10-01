import axios from 'axios';

export const SERVER_API_VERSION = 2;

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

async function postToCurrentServer(path, payload, options) {
  try {
    const { data: status } = await axios.get('/status', { timeout: 5000 });
    requireCurrentServer(status);
    return await axios.post(path, payload, options);
  } catch (error) {
    if (axios.isAxiosError(error) && !error.response) {
      throw new Error('Cannot reach the local LED Sign server. Restart Servers from the tray menu. The Bluetooth sign connection is separate from this server connection.');
    }
    throw error;
  }
}

export async function savePresetToSign(payload, options) {
  const response = await postToCurrentServer('/save-preset', payload, options);
  requireCompletedWrite(response.data);
  return response;
}

export const processVideoMedia = (payload) => postToCurrentServer('/process-video', payload);
