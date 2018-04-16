import { ReplaySubject, Subject } from 'rxjs';

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

export class QueueingSubject extends ReplaySubject {
  constructor() {
    super();
    delete this.next;
  }

  next(value) {
    if (this.closed || this.observers.length) {
      Subject.prototype.next.call(this, value);
    } else {
      this._events.push(value);
    }
  }

  empty() {
    this._events.splice(0);
  }

  _subscribe(subscriber) {
    const subscription = Subject.prototype._subscribe.call(this, subscriber);
    const len = this._events.length;
    let i;
    for (i = 0; i < len && !subscriber.closed; i++) {
      subscriber.next(this._events[i]);
    }
    this._events.splice(0, i);
    return subscription;
  }
}
