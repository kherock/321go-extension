import {
  Observable,
  Subject,
  Subscriber,
  Subscription,
  concat,
  fromEvent,
  interval,
  merge,
} from 'rxjs';
import {
  concatMap,
  exhaustMap,
  filter,
  map,
  mapTo,
  mergeMap,
  share,
  switchMap,
  take,
  takeWhile,
  tap,
} from 'rxjs/operators';
import url from 'url';
import { QueueingSubject, getPortSubject } from './utils';

export let href = location.href;

const urlChange$ = new Subject();

function getMediaSelector() {
  const urlObj = url.parse(location.href);
  switch (urlObj.hostname.toLowerCase()) {
  case 'kissanime.ru':
    return () => {
      const videoContainer = window['divContentVideo'];
      if (!videoContainer) return;
      return videoContainer.firstElementChild instanceof HTMLIFrameElement
        ? videoContainer.firstElementChild
        : videoContainer.querySelector('video');
    };
  case 'youtube.com':
    return () => window['movie_player'].querySelector('.html5-main-video');
  default:
    return () => document.querySelector('video');
  }
}

function observeMedia(element) {
  let suppressEvents = false;
  const destination = new Subject().pipe(concatMap(async (message) => {
    switch (message.type) {
    case 'OBSERVE_MEDIA':
      break;
    case 'PLAYING':
      suppressEvents = true;
      element.currentTime = message.currentTime + (Date.now() - message.updateTime) / 1000;
      await element.play();
      await new Promise(resolve => setTimeout(resolve));
      suppressEvents = false;
      break;
    case 'PAUSE':
      suppressEvents = true;
      await element.pause();
      element.currentTime = message.currentTime;
      await new Promise(resolve => setTimeout(resolve));
      suppressEvents = false;
      break;
    default:
      console.error('Receieved unexpected message:', message);
    }
  }));
  destination.subscribe();
  return Subject.create(destination, merge(
    fromEvent(element, 'playing').pipe(
      map(ev => ({
        type: 'PLAYING',
        currentTime: ev.target.currentTime,
      })),
    ),
    fromEvent(element, 'pause').pipe(
      map(ev => ({
        type: 'PAUSE',
        currentTime: ev.target.currentTime,
      })),
    ),
  ).pipe(
    filter(() => !suppressEvents),
    tap(ev => console.log(ev.type.toLowerCase())),
  ));
}

function observeFrame(element) {
  // poll the frame to observe until it says it's ready
  const runtimeId = chrome.runtime.id;

  const selfMessages = frame => fromEvent(self, 'message').pipe(
    filter(ev => ev.source === frame && ev.data.runtimeId === runtimeId),
    map((ev) => {
      const message = { ...ev.data };
      delete message.runtimeId;
      return message;
    }),
  );

  const destination = new QueueingSubject();
  return Subject.create(destination, interval(100).pipe(
    map(() => element.contentWindow),
    tap(frame => frame.postMessage({ type: 'FRAME_PING', runtimeId }, '*')),
    mergeMap(frame => selfMessages(frame).pipe(
      filter(msg => msg.type === 'FRAME_PONG'),
      mapTo(frame),
    )),
    take(1),
    share(),
    exhaustMap(frame => Observable.create((observer) => {
      const subscription = selfMessages(frame).subscribe(observer);
      subscription.add(concat(
        destination,
        [{ type: 'FRAME_DESTROY' }],
      ).subscribe(message => frame.postMessage({ ...message, runtimeId }, '*')));
      return () => subscription.unsubscribe();
    })),
  ));
}

function observeElement() {
  const mutationObserver = new MutationObserver(() => urlChange$.next(location.href));
  const destination = new QueueingSubject();
  return Subject.create(destination, interval(100).pipe(
    map(getMediaSelector()),
    filter(element => element !== null),
    take(1),
    share(),
    exhaustMap(element => Observable.create((observer) => {
      const subject = element instanceof HTMLIFrameElement
        ? observeFrame(element)
        : observeMedia(element);
      const subscription = subject.subscribe(observer);
      subscription.add(destination.subscribe(subject));
      mutationObserver.observe(element, {
        attributes: true,
        attributeFilter: ['src'],
      });
      return () => {
        mutationObserver.disconnect();
        subscription.unsubscribe();
      };
    })),
  ));
}

function observePort() {
  return self === top
    ? getPortSubject(chrome.runtime.connect())
    : Subject.create( // sub-frame
      new Subscriber(message => top.postMessage({ ...message, runtimeId: chrome.runtime.id }, '*')),
      fromEvent(self, 'message').pipe(
        filter(ev => (ev.source === top || ev.source === self) && ev.data.runtimeId === chrome.runtime.id),
        map(ev => ev.data),
        takeWhile(message => message.type !== 'FRAME_DESTROY'),
      ),
    );
}

function main() {
  const portSubject = observePort();
  const elementSubject = observeElement();

  portSubject.pipe(
    filter(message => message.type === 'FRAME_PING'),
    mapTo({ type: 'FRAME_PONG' }),
  ).subscribe(portSubject);

  portSubject.pipe(
    filter(message => message.type.match(/^(UN)?OBSERVE_MEDIA$/)),
    tap(elementSubject),
    switchMap(message => Observable.create((observer) => {
      const subscription = new Subscription();
      switch (message.type) {
      case 'OBSERVE_MEDIA':
        subscription.add(portSubject.subscribe(observer));
        subscription.add(elementSubject.subscribe(portSubject));
        break;
      case 'UNOBSERVE_MEDIA':
        break;
      }
      return () => subscription.unsubscribe();
    })),
  ).subscribe(elementSubject);
  urlChange$.subscribe(portSubject);
}

if (self === top) {
  main();
} else {
  // destroy any existing script instances on this frame before starting
  observePort().toPromise().then(main);
  self.postMessage({ type: 'FRAME_DESTROY', runtimeId: chrome.runtime.id }, '*');
}
