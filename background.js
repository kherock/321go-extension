'use strict';

const HOSTNAME = 'localhost';
const PORT = 3000;

const sockets = new Map();

function promisifySocket(socket) {
  socket.emit = socket.emit.bind(socket);
  socket.publish = socket.publish.bind(socket);
  socket.channel = function () {
    return promisifyChannel(Object.getPrototypeOf(socket).channel.apply(this, arguments));
  }
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

function createTabSocket(port) {
  const socket = promisifySocket(socketCluster.create({
    hostname: HOSTNAME,
    port: PORT,
    autoConnect: false,
    multiplex: false
  }));
  socket.port = port;
  socket.room = { id: null };
  socket.on('unsubscribe', (channelName) => {
    socket.destroyChannel(channelName);
    if (!socket.subscriptions(true).length) socket.disconnect();
  });
  return socket;
}

async function createRoom() {
  this.connect();
  const roomId = await promisify(this.emit)('get_room', null);
  return await joinRoom.call(this, roomId);
}

async function joinRoom(roomId) {
  this.connect();
  const channel = this.channel(roomId);
  channel.watch((message) => {
    this.port.postMessage(message);
  });
  await promisify(channel.subscribe)();
  this.room.id = roomId;
  return roomId;
}

function leaveRoom() {
  this.destroyChannel(this.room.id);
  this.room.id = null;
}

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

async function handlePopupMessage(message, port) {
  const socket = sockets.get(message.tab);
  if (!socket) {
    console.warn('A popup attempted to control a tab with no running content script');
    return;
  }
  try {
    let roomId;
    switch (message.type) {
    case 'CREATE_ROOM':
      roomId = await createRoom.call(socket);
      port.postMessage({ type: 'JOIN_ROOM', roomId });
      break;
    case 'JOIN_ROOM':
      roomId = await joinRoom.call(socket, message.roomId);
      port.postMessage({ type: 'JOIN_ROOM', roomId });
      break;
    case 'LEAVE_ROOM':
      leaveRoom.call(socket);
      port.postMessage({ type: 'LEAVE_ROOM' });
      socket.port.postMessage({ type: 'UNOBSERVE_MEDIA' });
    }
  } catch (err) {
    console.error(err.stack);
  }  
}

function initTabPort(port) {
  const { tab } = port.sender;
  // create a socket for each tab
  const socket = sockets.get(tab.id) || createTabSocket(port);
  if (!sockets.has(tab.id)) {
    sockets.set(tab.id, socket);
  } else {
    // update the port if the socket already exists
    socket.port = port;
    if (socket.room.id) {
      port.postMessage({ type: 'OBSERVE_MEDIA' });
    }
  }
  port.onMessage.addListener(handleTabMessage);  
}

function initPopupPort(port) {
  const roomMap = {};
  for (const [tabId, socket] of sockets) {
    roomMap[tabId] = socket.room.id;
  }
  port.postMessage(roomMap);
  port.onMessage.addListener(handlePopupMessage);
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
