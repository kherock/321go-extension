import 'chrome-extension-async';
import url from 'url';

import { ENDPOINT } from '../env';
import { getTab } from '../utils';
import { Client } from './client';

const clients = new Map();

function createTabClient(tabId, popupPort) {
  const client = new Client(tabId, popupPort);
  clients.set(tabId, client);
  return client;
}

async function fetchNewRoom() {
  const res = await fetch(url.format(ENDPOINT), { method: 'POST' });
  if (!res.ok) throw new Error(res.statusText);
  return res.text();
}

/**
 * onMessage handler for events from the content script.
 * @param {object} message
 * @param {Port} port
 */
async function handleTabMessage(message, port) {
  const client = clients.get(port.sender.tab.id);
  if (message.type === 'URL') {
    client.room.href = message.href;
  }
  try {
    client.socket.next(message);
  } catch (err) {
    console.error(err.stack);
  }
}

/**
 * onMessage handler for events from the popup page.
 * @param {object} message
 * @param {Port} port
 */
async function handlePopupMessage(message, port) {
  try {
    let client = clients.get(message.tab);
    if (client) client.popup = port;
    switch (message.type) {
    case 'CREATE_ROOM':
      client = client || createTabClient(message.tab, port);
      client.joinRoom(await fetchNewRoom());
      break;
    case 'JOIN_ROOM':
      client = client || createTabClient(message.tab, port);
      client.joinRoom(message.roomId);
      break;
    case 'RESYNC_MEDIA':
      if (client.port) {
        client.port.postMessage({ type: 'UNOBSERVE_MEDIA' });
        client.port.postMessage({ type: 'OBSERVE_MEDIA' });
      } else {
        await client.execContentScript();
      }
      await client.updateBrowserActionPermissionStatus();
      break;
    case 'LEAVE_ROOM':
      client.leaveRoom();
      break;
    default:
      console.error('Encountered unkown popup message:', message);
    }
  } catch (err) {
    console.error(err.stack);
  }
}

/**
 * onConnect handler for new content scripts.
 * If the tab disconnects the port (from navigating or refreshing the page),
 * a new content script is injected if the tab still exists and is joined to a room.
 * @param {Port} port
 */
function initTabPort(port) {
  const { tab } = port.sender;
  // create a client for each tab
  const client = clients.get(tab.id);
  client.port = port;
  if (client.room.value.id) {
    port.postMessage({ type: 'OBSERVE_MEDIA' });
    client.setBrowserActionIcon('active');
  }
  port.onMessage.addListener(handleTabMessage);
  port.onDisconnect.addListener(async () => {
    client.port = null;
    const newTab = await getTab(client.tabId);
    if (newTab && client.room.value.id) {
      await client.execContentScript();
    }
  });
}

/**
 * onConnect handler for new popup windows.
 * @param {Port} port
 */
function initPopupPort(port) {
  const roomMap = {};
  for (const [tabId, client] of clients) {
    roomMap[tabId] = client.room.value.id;
  }
  port.postMessage(roomMap);
  port.onMessage.addListener(handlePopupMessage);
  port.onDisconnect.addListener(() => {
    for (const client of clients.values()) {
      if (client.popup === port) client.popup = null;
    }
  });
}

// wait for things to connect to the background script
chrome.runtime.onConnect.addListener((port) => {
  if (port.sender.id !== chrome.runtime.id) {
    port.disconnect();
  } else if (port.sender.tab) {
    initTabPort(port);
  } else {
    initPopupPort(port);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const client = clients.get(tabId);
  if (client) {
    client.room.next({ id: null });
    client.room.complete();
    clients.delete(tabId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const client = clients.get(tabId);
  if (!client) return;
  client.updateBrowserActionPermissionStatus();
  if (changeInfo.url !== client.room.value.href) {
    client.room.next({
      ...client.room.value,
      href: changeInfo.url,
    });
    client.socket.next({ type: 'URL', href: changeInfo.url });
  }
});
