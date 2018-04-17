import { BehaviorSubject, Subject, Observable } from 'rxjs';
import {
  catchError,
  distinctUntilKeyChanged,
  filter,
  mergeMapTo,
  retryWhen,
  share,
  switchMap,
} from 'rxjs/operators';
import { websocket } from 'rxjs/websocket';
import url from 'url';

import { WS_ENDPOINT } from '../env';
import { getTab, QueueingSubject } from '../utils';

/**
 * A client represents a tab's connection to the server. This also includes several helpers
 * that manage the browser action icon and communicate with a popup port when it is present.
 */
export class Client {
  constructor(tabId, popupPort = null) {
    this.tabId = tabId;
    this.port = null;
    this.popup = popupPort;
    this.room = new BehaviorSubject({});

    const openObserver = new Subject();
    this.socket = Subject.create(new QueueingSubject(), this.room.pipe(
      distinctUntilKeyChanged('id'),
      switchMap(room => new Observable((subscriber) => {
        if (!room.id) return;

        const socketSubject = websocket({
          url: url.format({ ...WS_ENDPOINT, pathname: room.id }),
          openObserver,
        });
        const subscription = socketSubject.subscribe(subscriber);
        subscription.add(openObserver.pipe(mergeMapTo(this.socket.destination)).subscribe(socketSubject));
        return () => subscription.unsubscribe();
      })),
      share(),
      retryWhen(errors => errors.pipe(
        filter(err => err.target instanceof WebSocket),
      )),
      catchError((err) => {
        console.error(err.stack);
        return [];
      }),
    ));
    this.room.pipe(
      distinctUntilKeyChanged('id'),
      catchError((err) => {
        console.error(err.stack);
        return this.room;
      }),
    ).subscribe(() => this.socket.destination.empty());
    this.socket.subscribe(this.handleRoomMessage.bind(this));
  }

  /**
   * Subscribes a tab to the events in a room.
   * This creates a WebSocket for the passed in tabId if it doesn't exist yet
   * and executes the content script in the tab if no port has been established yet.
   * @param {number} tabId
   * @param {string} roomId
   */
  joinRoom(roomId) {
    this.room.next({ id: roomId });
    if (this.popup) {
      this.popup.postMessage({ type: 'JOIN_ROOM', roomId });
    }
    return roomId;
  }

  /**
   * Destroys the channel associated with the passed in tab.
   * The connection to the tab's content script is left intact.
   * @param {number} tabId
   */
  leaveRoom() {
    this.room.next({ id: null });
    if (this.port) {
      this.port.postMessage({ type: 'UNOBSERVE_MEDIA' });
    }
    if (this.popup) {
      this.popup.postMessage({ type: 'LEAVE_ROOM' });
    }
    this.setBrowserActionIcon('rest');
  }

  async handleRoomMessage(message) {
    let tab;
    switch (message.type) {
    case 'SYNCHRONIZE':
      tab = await getTab(this.tabId);
      if (!tab) break;
      if (message.href) {
        tab = await getTab(this.tabId);
        if (tab && tab.url !== message.href) {
          tab = await chrome.tabs.update(this.tabId, { url });
        }
        if (!tab) break;
      } else {
        // this is a new room, let's give it a URL to work with
        this.socket.next({
          type: 'URL',
          href: tab.url,
        });
      }
      if (this.port) {
        this.port.postMessage({ type: 'OBSERVE_MEDIA' });
        this.setBrowserActionIcon('active');
      } else {
        // execute the content script if it hasn't been injected into the page
        const hasPermission = await this.updateBrowserActionPermissionStatus();
        if (hasPermission) {
          await this.execContentScript();
        } else if (this.popup) {
          this.popup.postMessage({
            type: 'PERMISSION_REQUIRED',
            origin: message.href,
          });
        }
      }
      break;
    case 'URL':
      tab = await getTab(this.tabId);
      if (tab && tab.url !== message.href) {
        await chrome.tabs.update(tab.id, { url: message.href });
      }
      break;
    default:
      if (this.port) {
        this.port.postMessage(message);
      }
      break;
    }
  }

  async updateBrowserActionPermissionStatus() {
    const tab = await chrome.tabs.get(this.tabId);
    const hasPermission = await chrome.permissions.contains({
      origins: [tab.url],
    });
    await chrome.browserAction.setBadgeText({
      text: !hasPermission ? '!' : '',
      tabId: this.tabId,
    });
    return hasPermission;
  }

  async setBrowserActionIcon(state) {
    return chrome.browserAction.setIcon({
      path: `./images/ic_extension_${state}_38dp.png`,
      tabId: this.tabId,
    });
  }

  async execContentScript() {
    return chrome.tabs.executeScript(this.tabId, { file: '321go.js' });
  }
}
