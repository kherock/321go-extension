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
