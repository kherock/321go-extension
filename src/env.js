import url from 'url';

export const ENDPOINT = url.parse(process.env.ENDPOINT);
export const WS_ENDPOINT = {
  ...ENDPOINT,
  protocol: ENDPOINT.protocol === 'https:' ? 'wss:' : 'ws:',
};
