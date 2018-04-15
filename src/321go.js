import { Subscription, fromEvent, fromEventPattern, interval } from 'rxjs';
import {
  filter,
  finalize,
  map,
  mergeMap,
  take,
  takeUntil,
  takeWhile,
  tap,
} from 'rxjs/operators';

import { Broker } from './broker';

export let href = self.location.href;

// communication channel between window frames and the chrome background script
const port = self === top ? chrome.runtime.connect() : undefined;
const portBroker = self === top
  ? new Broker( // top frame
    message => port.postMessage(message),
    fromEventPattern(
      handler => port.onMessage.addListener(handler),
      handler => port.onMessage.removeListener(handler),
      message => message,
    ).pipe(takeUntil(fromEventPattern(handler => port.onDisconnect.addListener(handler)))),
  )
  : new Broker( // sub-frame
    message => top.postMessage({ ...message, runtimeId: chrome.runtime.id }, '*'),
    fromEvent(self, 'message').pipe(
      filter(ev => ev.source === top && ev.data.runtimeId === chrome.runtime.id),
      map(ev => ev.data),
    ).pipe(takeWhile(message => message.type !== 'FRAME_DESTROY')),
  );

let frameBroker;

let mediaSubscription;

let mediaElement;
let suppressEvents = false;

const observer = new MutationObserver(() => {
  portBroker.publish({
    type: 'URL',
    href: location.href,
  });
  console.log(location.href);
});

function playingHandler(ev) {
  if (suppressEvents) return;
  portBroker.publish({
    type: 'PLAYING',
    currentTime: mediaElement.currentTime,
  });
  console.log('playing');
}

function pauseHandler(ev) {
  if (suppressEvents) return;
  portBroker.publish({
    type: 'PAUSE',
    currentTime: mediaElement.currentTime,
  });
  console.log('pause');
}

function observeElement(element) {
  mediaSubscription = new Subscription();
  mediaSubscription.add(fromEvent(element, 'playing').subscribe(playingHandler));
  mediaSubscription.add(fromEvent(element, 'pause').subscribe(pauseHandler));
}

async function observeFrame(element, selector = 'video') {
  // poll the frame to observe until it says it's ready
  const runtimeId = chrome.runtime.id;
  return interval(100).pipe(
    map(() => element.contentWindow),
    tap(frame => frame.postMessage({ type: 'OBSERVE_MEDIA', selector, runtimeId }, '*')),
    mergeMap(frame => fromEvent(self, 'message').pipe(
      filter(ev => ev.source === frame && ev.data.runtimeId === runtimeId),
      map(ev => ev.data),
      filter(message => message.type === 'FRAME_READY'),
      map(() => new Broker(
        message => frame.postMessage({ ...message, runtimeId }, '*'),
        fromEvent(self, 'message').pipe(
          filter(ev => ev.source === frame && ev.data.runtimeId === runtimeId),
          map(ev => ev.data),
          takeUntil(portBroker.sub.toPromise()),
          finalize(() => frame.postMessage({ type: 'FRAME_DESTROY', runtimeId }, '*')),
        ),
      )),
    )),
    take(1),
  ).toPromise();
}

async function observeMedia(selector) {
  let element;
  if (selector) {
    element = document.querySelector(selector);
  } else {
    if (window['movie_player']) { // YouTube
      element = document.querySelector('.html5-main-video');
    } else if (window['divContentVideo']) { // KissAnime
      element = document.querySelector('#divContentVideo > iframe');
    }
  }

  if (element) {
    observer.observe(element, {
      attributes: true,
      attributeFilter: ['src'],
    });
    if (element instanceof HTMLIFrameElement) {
      frameBroker = await observeFrame(element);
      // listen for messages from sub-frames
      frameBroker.subscribe((message) => {
        switch (message.type) {
        case 'FRAME_READY':
          return;
        default:
          delete message.runtimeId;
          return portBroker.publish(message);
        }
      });
    } else {
      observeElement(element);
    }
  }
  return element;
}

function unobserveMedia() {
  observer.disconnect();
  if (frameBroker) {
    frameBroker.publish({ type: 'UNOBSERVE_MEDIA' });
    frameBroker = undefined;
  } else if (mediaElement) {
    mediaSubscription.unsubscribe();
    mediaSubscription = null;
  }
}

async function handleMessage(message) {
  try {
    switch (message.type) {
    case 'PLAYING':
      if (!mediaElement) return;
      suppressEvents = true;
      mediaElement.currentTime = message.currentTime;
      await mediaElement.play();
      break;
    case 'PAUSE':
      if (!mediaElement) return;
      suppressEvents = true;
      mediaElement.currentTime = message.currentTime;
      await mediaElement.pause();
      break;
    default:
      console.error('Receieved unexpected message:', message);
    }
  } catch (err) {
    console.error(err);
  } finally {
    setTimeout(() => (suppressEvents = false));
  }
}

portBroker.pipe(finalize(unobserveMedia)).subscribe(async (message) => {
  try {
    switch (message.type) {
    case 'OBSERVE_MEDIA':
      mediaElement = await observeMedia(message.selector);
      if (self !== top) {
        // this is a sub-frame, so send the ready message
        portBroker.publish({ type: 'FRAME_READY' });
      }
      break;
    case 'UNOBSERVE_MEDIA':
      unobserveMedia();
      mediaElement = undefined;
      break;
    default:
      if (frameBroker) {
        // forward the message to the sub-frame
        frameBroker.publish(message);
      } else if (mediaElement) {
        await handleMessage(message);
      }
      break;
    }
  } catch (err) {
    console.error(err.stack);
  }
});
