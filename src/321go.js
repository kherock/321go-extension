let port;
let element;
let frame;
let suppressEvents = false;

export let url;

const observer = new MutationObserver(() => {
  port.postMessage({
    type: 'URL',
    href: location.href,
  });
  console.log(location.href);
});

function playingHandler(ev) {
  if (suppressEvents) return;
  port.postMessage({
    type: 'PLAYING',
    currentTime: element.currentTime,
  });
  console.log('playing');
}

function pauseHandler(ev) {
  if (suppressEvents) return;
  port.postMessage({
    type: 'PAUSE',
    currentTime: element.currentTime,
  });
  console.log('pause');
}

function observeElement() {
  element.addEventListener('playing', playingHandler);
  element.addEventListener('pause', pauseHandler);
}

function observeFrame(selector = 'video') {
  let listener;
  // poll the frame to observe until it says it's ready
  const interval = setInterval(() => {
    frame = element.contentWindow;
    frame.postMessage({
      runtimeId: chrome.runtime.id,
      type: 'OBSERVE_MEDIA',
      selector,
    }, '*');
  }, 100);
  window.addEventListener('message', listener = (ev) => {
    const message = ev.data;
    if (ev.source !== frame || message.runtimeId !== chrome.runtime.id) return;
    if (message.type === 'FRAME_READY') {
      clearInterval(interval);
      window.removeEventListener('message', listener);
    }
  });
}

function observeMedia(selector) {
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
      observeFrame();
    } else {
      observeElement();
    }
  }
}

function unobserveMedia() {
  observer.disconnect();
  if (frame) {
    frame.postMessage({
      runtimeId: chrome.runtime.id,
      type: 'UNOBSERVE_MEDIA',
    }, '*');
    frame = undefined;
  } else if (element) {
    element.removeEventListener('playing', playingHandler);
    element.removeEventListener('pause', pauseHandler);
  }
  element = undefined;
}

async function handleMessage(message) {
  try {
    switch (message.type) {
    case 'PLAYING':
      if (!element) return;
      suppressEvents = true;
      element.currentTime = message.currentTime;
      await element.play();
      break;
    case 'PAUSE':
      if (!element) return;
      suppressEvents = true;
      element.currentTime = message.currentTime;
      await element.pause();
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

if (self === top) {
  // Only the top context connects to the background script
  port = chrome.runtime.connect();

  port.onMessage.addListener((message) => {
    switch (message.type) {
    case 'OBSERVE_MEDIA':
      observeMedia();
      break;
    case 'UNOBSERVE_MEDIA':
      unobserveMedia();
      break;
    default:
      if (frame) {
        message.runtimeId = chrome.runtime.id;
        frame.postMessage(message, '*');
      } else if (element) {
        handleMessage(message);
      }
      break;
    }
  });
  // listen for messages from child frames
  top.addEventListener('message', (ev) => {
    const message = ev.data;
    if (ev.source !== frame || message.runtimeId !== chrome.runtime.id) return;

    switch (message.type) {
    case 'FRAME_READY':
      return;
    default:
      delete message.runtimeId;
      return port.postMessage(message);
    }
  });
  url = top.location.href;
} else {
  port = {
    postMessage(message) {
      message.runtimeId = chrome.runtime.id;
      return top.postMessage(message, '*');
    },
  };

  self.addEventListener('message', (ev) => {
    const message = ev.data;
    if (ev.source !== top || message.runtimeId !== chrome.runtime.id) return;
    switch (message.type) {
    case 'OBSERVE_MEDIA':
      observeMedia(message.selector);
      break;
    case 'UNOBSERVE_MEDIA':
      unobserveMedia();
      break;
    default:
      if (element) {
        handleMessage(message);
      }
      return;
    }
    port.postMessage({ type: 'FRAME_READY' });
  });
  url = self.location.href;
}
