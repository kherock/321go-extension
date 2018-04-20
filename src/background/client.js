import { BehaviorSubject, Observable, Subject, interval, merge, timer } from 'rxjs';
import {
  catchError,
  delay,
  distinctUntilKeyChanged,
  filter,
  mapTo,
  mergeMapTo,
  retryWhen,
  share,
  switchMap,
  tap,
} from 'rxjs/operators';
import { websocket } from 'rxjs/websocket';
import url from 'url';

import { ENDPOINT, WS_ENDPOINT } from '../env';
import { QueueingSubject, getTab } from '../utils';

async function fetchNewRoom() {
  const res = await fetch(url.format(ENDPOINT), { method: 'POST' });
  if (!res.ok) throw new Error(res.statusText);
  return res.text();
}

/**
 * A client represents a tab's connection to the server. This also includes several helpers
 * that manage the browser action icon and communicate with a popup port.
 */
export class Client {
  constructor(tabId) {
    this.tabId = tabId;
    this.port = null;
    this.popup = Subject.create(new Subject(), new Subject());
    this.room = new BehaviorSubject({ id: null });

    this.status = new BehaviorSubject('closed');

    const openObserver = new Subject();
    const closeObserver = new Subject();
    const timeout = new Subject().pipe(switchMap(() => timer(30e3)));
    merge(
      openObserver.pipe(mapTo('open')),
      closeObserver.pipe(mapTo('closed')),
      timeout.pipe(mapTo('timeout')),
    ).subscribe(this.status);

    this.socket = Subject.create(new QueueingSubject(), this.room.pipe(
      distinctUntilKeyChanged('id'),
      switchMap(room => new Observable((subscriber) => {
        if (!room.id) return;

        const socketSubject = websocket({
          url: url.format({ ...WS_ENDPOINT, pathname: room.id }),
          binaryType: 'arraybuffer',
          deserializer: ev => ev.data instanceof ArrayBuffer ? ev.data : JSON.parse(ev.data),
          serializer: value => value instanceof ArrayBuffer ? value : JSON.stringify(value),
          openObserver,
          closeObserver,
        });

        const heartbeat = new Subject().pipe(
          switchMap(() => interval(10e3)),
          mapTo(new ArrayBuffer(0)),
        );

        const subscription = socketSubject.asObservable().pipe(
          tap(() => heartbeat.next()),
          tap(() => timeout.next()),
          filter(message => !(message instanceof ArrayBuffer)),
        ).subscribe(subscriber);

        // flush queued messages after open
        subscription.add(openObserver.pipe(
          mergeMapTo(this.socket.destination),
        ).subscribe(socketSubject));

        // start sending heartbeats
        subscription.add(heartbeat.subscribe(socketSubject));

        return () => subscription.unsubscribe();
      })),
      share(),
      retryWhen(errors => errors.pipe(
        filter(err => err.target instanceof WebSocket),
        delay(1e3),
      )),
      catchError((err) => {
        console.error(err.stack);
        return [];
      }),
    ));

    this.room.pipe(
      distinctUntilKeyChanged('id'),
      tap(() => this.socket.destination.empty()),
    ).subscribe();

    this.socket.subscribe(this.handleRoomMessage.bind(this));
    this.popup.subscribe(this.handlePopupMessage.bind(this));
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
    this.popup.next({ type: 'JOIN_ROOM', roomId });
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
      this.port.next({ type: 'UNOBSERVE_MEDIA' });
    }
    this.popup.next({ type: 'LEAVE_ROOM' });
    this.setBrowserActionBadgeText('');
    this.setBrowserActionIcon('rest');
  }

  async handleRoomMessage(message) {
    let tab;
    switch (message.type) {
    case 'SYNCHRONIZE':
      tab = await getTab(this.tabId);
      if (!tab) break;
      this.room.next({
        ...this.room.value,
        href: message.href || tab.url,
        state: message.state,
        currentTime: message.currentTime,
      });
      if (message.href && message.href !== tab.url) {
        await chrome.tabs.update(tab.id, { url: message.href });
      } else {
        if (!message.href) {
          // this is a new room, let's give it a URL to work with
          this.socket.next({
            type: 'URL',
            href: tab.url,
          });
        }
        const hasPermission = await this.updateBrowserActionPermissionStatus();
        if (this.port) {
          await this.observeMedia();
        } else if (hasPermission) {
          await this.execContentScript();
        } else {
          this.popup.next({
            type: 'PERMISSION_REQUIRED',
            origin: tab.url,
          });
        }
      }
      break;
    case 'URL':
      tab = await getTab(this.tabId);
      if (tab && tab.url !== message.href) {
        this.room.next({
          ...this.room.value,
          href: message.href,
        });
        await chrome.tabs.update(tab.id, { url: message.href });
      }
      break;
    default:
      if (this.port) {
        this.port.next(message);
      }
      if (message.type === 'PLAYING') {
        this.room.next({
          ...this.room.value,
          state: 'playing',
          currentTime: message.currentTime,
          serverTime: message.serverTime,
        });
      } else if (message.type === 'PAUSE') {
        this.room.next({
          ...this.room.value,
          state: 'paused',
          currentTime: message.currentTime,
          serverTime: undefined,
        });
      }
      break;
    }
  }

  /**
   * onMessage handler for events from the popup page.
   * @param {object} message
   * @param {Port} port
   */
  async handlePopupMessage(message) {
    try {
      switch (message.type) {
      case 'CREATE_ROOM':
        this.joinRoom(await fetchNewRoom());
        break;
      case 'JOIN_ROOM':
        this.joinRoom(message.roomId);
        break;
      case 'RESYNC_MEDIA':
        if (this.port) {
          await this.observeMedia();
        } else {
          await this.execContentScript();
        }
        await this.updateBrowserActionPermissionStatus();
        break;
      case 'LEAVE_ROOM':
        this.leaveRoom();
        break;
      default:
        console.error('Encountered unkown popup message:', message);
      }
    } catch (err) {
      console.error(err.stack);
    }
  }

  async updateBrowserActionPermissionStatus() {
    const tab = await chrome.tabs.get(this.tabId);
    const hasPermission = await chrome.permissions.contains({
      origins: [tab.url],
    });
    await this.setBrowserActionBadgeText(!hasPermission ? '!' : '');
    return hasPermission;
  }

  async setBrowserActionBadgeText(text) {
    return chrome.browserAction.setBadgeText({ text, tabId: this.tabId });
  }

  async setBrowserActionIcon(state) {
    return chrome.browserAction.setIcon({
      path: `./images/ic_extension_${state}_38dp.png`,
      tabId: this.tabId,
    });
  }

  async execContentScript() {
    return chrome.tabs.executeScript(this.tabId, { file: '321go.js', allFrames: true });
  }

  async observeMedia() {
    const room = this.room.value;
    this.port.next({ type: 'OBSERVE_MEDIA' });
    if (room.currentTime) {
      switch (room.state) {
      case 'playing':
        this.port.next({
          type: 'PLAYING',
          serverTime: room.serverTime,
          currentTime: room.currentTime,
        });
        break;
      case 'paused':
        this.port.next({
          type: 'PAUSE',
          currentTime: room.currentTime,
        });
        break;
      }
    }
    await this.setBrowserActionIcon('active');
  }
}
