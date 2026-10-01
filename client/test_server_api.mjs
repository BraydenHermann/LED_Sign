import assert from 'node:assert/strict';
import axios from 'axios';
import { savePresetToSign, processVideoMedia, requireCompletedWrite } from './src/serverApi.js';

let status = { connected: true }; // Old server can still have a real BLE connection.
let posts = 0;
let offline = false;
axios.defaults.adapter = async config => {
  if (offline) throw new axios.AxiosError('Network Error', 'ERR_NETWORK', config);
  if (config.method === 'post') posts++;
  return { status: 200, statusText: 'OK', headers: {}, config,
    data: config.url === '/status' ? status : { written_to_sign: true, pixels: [0] } };
};

await assert.rejects(savePresetToSign({}), /older version/);
await assert.rejects(processVideoMedia({}), /older version/);
assert.equal(posts, 0, 'Do not send new-format requests to the old backend');
status = { api_version: 2, connected: true };
assert.equal((await savePresetToSign({})).data.written_to_sign, true);
assert.throws(() => requireCompletedWrite({ status: 'success' }), /did not confirm/);
assert.throws(() => requireCompletedWrite({ written_to_sign: false }), /could not finish writing/);
offline = true;
await assert.rejects(processVideoMedia({}), /local LED Sign server/);
console.log('PASS: old backend, network failure, missing confirmation and successful write are distinguished.');
