import promisify from 'util-promisify';

export function promisifySocket(socket) {
  socket.emit = socket.emit.bind(socket);
  socket.channel = function () {
    return promisifyChannel(Object.getPrototypeOf(socket).channel.apply(this, arguments));
  };
  socket.publish = socket.publish.bind(socket);
  socket.subscribe = function () {
    return promisifyChannel(Object.getPrototypeOf(socket).subscribe.apply(this, arguments));
  };
  return socket;
}

export function promisifyChannel(channel) {
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

/**
 * Gets a tab by ID, returning null if the tab doesn't exist (as opposed to throwing an error)
 * @param {string} tabId
 */
export async function getTab(tabId) {
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
export async function navigateTab(tabId, url) {
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
    let onUpdated;
    let onRemoved;
    tab = await Promise.race([
      new Promise(resolve => chrome.tabs.onUpdated.addListener(onUpdated = (id, changeInfo, updatedTab) => {
        if (id !== tab.id || changeInfo.status !== 'complete') return;
        resolve(updatedTab);
      })),
      new Promise(resolve => chrome.tabs.onRemoved.addListener(onRemoved = (id) => {
        if (id !== tab.id) return;
        resolve(null);
      })),
    ]);
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.tabs.onRemoved.removeListener(onRemoved);
  }
  return tab;
}
