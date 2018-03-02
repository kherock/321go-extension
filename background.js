'use strict';

const endpoint = 'http://localhost:3000';

const sockets = new Map();

function promisifySocket(socket) {
  socket.emit = socket.emit.bind(socket);
  socket.channel = function () {
    return promisifyChannel(Object.getPrototypeOf(socket).channel.apply(this, arguments));
  }
  socket.publish = socket.publish.bind(socket);
  socket.subscribe = function () {
    return promisifyChannel(Object.getPrototypeOf(socket).subscribe.apply(this, arguments));
  }
  return socket;
}

function promisifyChannel(channel) {
  channel.subscribe = channel.subscribe.bind(channel);
  channel.subscribe[promisify.custom] = function () {
    if (this.state === this.SUBSCRIBED) return Promise.resolve(this.name);
    return new Promise((resolve, reject) => {
      const doResolve = (channelName) => {
        if (channelName !== this.name) return;
        this.client.off('subscribe', doResolve);
        this.client.off('subscribeFail', doReject);
        resolve(channelName);
      };
      const doReject = (err, channelName) => {
        if (channelName !== this.name) return;
        this.client.off('subscribe', doResolve);
        this.client.off('subscribeFail', doReject);
        reject(err);
      };
      this.client.on('subscribe', doResolve);
      this.client.on('subscribeFail', doReject);
      this.subscribe();
    });
  }.bind(channel);
  return channel;
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (err) {
    return null;
  }
}

/**
 * Navigates a tab to an optionally specified url and waits for the status to be complete.
 * @param {number} tabId 
 * @param {string} [url]
 * @returns {Promise<Tab>} A promise that resolves with the updated tab.
 */
async function navigateTab(tabId, url) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
    if (url && tab.url !== url) {
      tab = await chrome.tabs.update(tabId, { url });
    }
  } catch (err) {
    return null;
  }
  if (tab.status === 'loading') {
    let onUpdated, onRemoved;
    tab = await Promise.race([
      new Promise(resolve => chrome.tabs.onUpdated.addListener(onUpdated = (tabId, changeInfo, updatedTab) => {
        if (tabId !== tab.id || changeInfo.status !== 'complete') return;
        resolve(updatedTab);
      })),
      new Promise(resolve => chrome.tabs.onRemoved.addListener(onRemoved = (tabId) => {
        if (tabId !== tab.id) return;
        resolve(null);
      }))
    ]);
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.tabs.onRemoved.removeListener(onRemoved);
  }
  return tab;
}

async function execContentScript(tabId) {
  return await chrome.tabs.executeScript(tabId, {
    file: '321go.js',
    allFrames: true
  });
}

async function setBrowserActionIcon(tabId, state = 'active') {
  return await chrome.browserAction.setIcon({
    path: `./images/ic_extension_${state}_38dp.png`,
    tabId
  });
}

async function updateBrowserActionPermissionStatus(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const hasPermission = await chrome.permissions.contains({
    origins: [tab.url]
  });
  await chrome.browserAction.setBadgeText({
    text: !hasPermission ? '!' : '',
    tabId: tab.id
  });
  return hasPermission;
}

function createTabSocket(tabId) {
  const [, proto, hostname, port] = endpoint.match(/^(https?):\/\/([0-9A-Za-z-.]+)(?::(\d+))?$/) || [];
  const socket = promisifySocket(socketCluster.create({
    hostname: hostname,
    port: port,
    secure: proto === 'https',
    multiplex: false
  }));
  socket.tabId = tabId;
  sockets.set(tabId, socket);
  socket.port = null;
  socket.room = { id: null };
  socket.on('unsubscribe', (channelName) => {
    socket.destroyChannel(channelName);
    if (!socket.subscriptions(true).length) {
      socket.destroy();
      sockets.delete(socket.tabId);
    }
  });
  return socket;
}

async function fetchNewRoom() {
  const res = await fetch(endpoint + '/', { method: 'POST' });
  if (!res.ok) throw new Error(res.statusText);
  return await res.text();
}

/**
 * Subscribes a tab to the events in a room.
 * This creates a WebSocket for the passed in tabId if it doesn't exist yet
 * and executes the content script in the tab if no port has been established yet.
 * @param {number} tabId 
 * @param {string} roomId 
 */
async function joinRoom(tabId, roomId) {
  const socket = sockets.get(tabId) || createTabSocket(tabId);
  const channel = socket.channel(roomId);
  channel.watch(handleChannelMessage.bind(null, socket));
  socket.room.id = roomId;
  await promisify(channel.subscribe)();
  return roomId;
}

/**
 * Destroys the channel associated with the passed in tab.
 * The connection to the tab's content script is left intact.
 * @param {number} tabId 
 */
function leaveRoom(tabId) {
  const socket = sockets.get(tabId);
  socket.unsubscribe(socket.room.id);
  socket.room.id = null;
  if (socket.port) {
    socket.port.postMessage({ type: 'UNOBSERVE_MEDIA' });
  }
  setBrowserActionIcon(tabId, 'rest');
}

async function handleChannelMessage(socket, message) {
  let tab;
  switch (message.type) {
  case 'SYNCHRONIZE':
    tab = await getTab(socket.tabId);
    if (!tab) break;
    if (message.href) {
      tab = await navigateTab(tab.id, message.href);
    } else {
      // this is a new room, let's give it a URL to work with
      await promisify(socket.publish)(socket.room.id, {
        type: 'URL',
        href: tab.url
      });
    }
    // execute the content script if it hasn't been injected into the page
    if (!socket.port) {
      const hasPermission = await updateBrowserActionPermissionStatus(tab.id);
      if (hasPermission) {
        await execContentScript(tab.id);
      } else if (socket.popup) {
        socket.popup.postMessage({
          type: 'PERMISSION_REQUIRED',
          origin: message.href
        });
      }
    }
    break;
  case 'URL':
    tab = await getTab(socket.tabId);
    if (tab && tab.url !== message.href) {
      await chrome.tabs.update(tab.id, { url: message.href });
    }
    break;
  default:
    if (socket.port) {
      socket.port.postMessage(message);
    }
    break;
  }
}

/**
 * onMessage handler for events from the content script.
 * @param {object} message 
 * @param {Port} port 
 */
async function handleTabMessage(message, port) {
  const socket = sockets.get(port.sender.tab.id);
  if (message.type === 'URL') {
    socket.room.href = message.href;
  }
  try {
    await promisify(socket.publish)(socket.room.id, message);
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
    let roomId;
    let socket;
    switch (message.type) {
    case 'CREATE_ROOM':
      roomId = await joinRoom(message.tab, await fetchNewRoom());
      socket = sockets.get(message.tab);
      socket.popup = port;
      port.postMessage({ type: 'JOIN_ROOM', roomId });
      break;
    case 'JOIN_ROOM':
      roomId = await joinRoom(message.tab, message.roomId);
      socket = sockets.get(message.tab);
      socket.popup = port;
      port.postMessage({ type: 'JOIN_ROOM', roomId });
      break;
    case 'RESYNC_MEDIA':
      socket = sockets.get(message.tab);
      if (socket.port) {
        socket.port.postMessage({ type: 'UNOBSERVE_MEDIA' });
        socket.port.postMessage({ type: 'OBSERVE_MEDIA' });
      } else {
        await execContentScript(message.tab);
      }
      await updateBrowserActionPermissionStatus(message.tab);
      break;
    case 'LEAVE_ROOM':
      port.postMessage({ type: 'LEAVE_ROOM' });
      leaveRoom(message.tab);
      break;
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
  // create a socket for each tab
  const socket = sockets.get(tab.id);
  socket.port = port;
  if (socket.room.id) {
    port.postMessage({ type: 'OBSERVE_MEDIA' });
    setBrowserActionIcon(tab.id);
  }
  port.onMessage.addListener(handleTabMessage);
  port.onDisconnect.addListener(async () => {
    socket.port = null;
    const tab = await navigateTab(socket.tabId);
    if (tab && socket.room.id) {
      execContentScript(tab.id);
    }
  });
}

/**
 * onConnect handler for new popup windows.
 * @param {Port} port 
 */
function initPopupPort(port) {
  const roomMap = {};
  for (const [tabId, socket] of sockets) {
    roomMap[tabId] = socket.room.id;
  }
  port.postMessage(roomMap);
  port.onMessage.addListener(handlePopupMessage);
  port.onDisconnect.addListener(() => {
    for (const socket of sockets.values()) {
      if (socket.popup === port) delete socket.popup;
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
  const socket = sockets.get(tabId);
  if (socket) socket.destroy();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const socket = sockets.get(tabId);
  if (!socket) return;
  updateBrowserActionPermissionStatus(tabId);
  if (changeInfo.url !== socket.room.href) {
    socket.room.href = changeInfo.url;
    socket.publish(socket.room.id, { type: 'URL', href: changeInfo.url });
  }
});
