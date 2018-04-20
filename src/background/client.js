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
    this.setBrowserActionBadgeText('');
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
          await chrome.tabs.update(tab.id, { url: message.href });
        }
      } else {
        // this is a new room, let's give it a URL to work with
        this.socket.next({
          type: 'URL',
          href: tab.url,
        });
      }
      if (this.port) {
        await this.observeMedia();
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
    this.port.postMessage({
      type: 'OBSERVE_MEDIA',
      state: this.room.value.state,
      currentTime: this.room.value.currentTime,
    });
    await this.setBrowserActionIcon('active');
  }
}
