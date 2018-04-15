'use strict';

import './popup.scss';

import 'chrome-extension-async';
import mdcAutoInit from '@material/auto-init';
import { MDCRipple } from '@material/ripple';
import { MDCTextField } from '@material/textfield';

mdcAutoInit.register('MDCRipple', MDCRipple);
mdcAutoInit.register('MDCTextField', MDCTextField);

mdcAutoInit();

const port = chrome.runtime.connect();

const roomIdControl = joinRoomForm.roomId.parentElement.MDCTextField;
const submitBtn = joinRoomForm.submitBtn;

async function ensurePermissions(url) {
  const hasPermission = await chrome.permissions.contains({ origins: [url] });
  if (!hasPermission) {
    const granted = await chrome.permissions.request({ origins: [url] });
    if (!granted) throw new Error('Permission denied');
  }
}

function initView(tab, roomId) {
  if (roomId) {
    roomIdControl.value = roomId;
    roomIdControl.layout();
    updateRoomView(roomId, tab);
  }
  toggleRoomView(!!roomId);

  joinRoomForm.roomId.addEventListener('input', (ev) => {
    submitBtn.disabled = !roomIdControl.value || !roomIdControl.valid;
  });
  createRoomBtn.addEventListener('click', async (ev) => {
    if (createRoomBtn.disabled) return;
    createRoomBtn.disabled = true;
    await ensurePermissions(tab.url);
    port.postMessage({
      tab: tab.id,
      type: 'CREATE_ROOM',
    });
  });
  joinRoomForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    createRoomBtn.disabled = true;
    roomIdControl.disabled = true;
    submitBtn.disabled = true;
    port.postMessage({
      tab: tab.id,
      type: 'JOIN_ROOM',
      roomId: roomIdControl.value,
    });
  });
  requestPermissionBtn.addEventListener('click', async (ev) => {
    await ensurePermissions(tab.url);
    roomView.classList.remove('error');
    roomView.classList.remove('permission-error');
    port.postMessage({
      tab: tab.id,
      type: 'RESYNC_MEDIA',
    });
  });
  leaveRoomBtn.addEventListener('click', (ev) => {
    port.postMessage({
      tab: tab.id,
      type: 'LEAVE_ROOM',
    });
  });

  port.onMessage.addListener(async (message) => {
    switch (message.type) {
    case 'JOIN_ROOM':
      roomIdControl.value = message.roomId;
      roomIdControl.layout();
      updateRoomView(message.roomId);
      toggleRoomView(true);
      break;
    case 'LEAVE_ROOM':
      toggleRoomView(false);
      break;
    case 'PERMISSION_REQUIRED':
      roomView.classList.add('error');
      roomView.classList.add('permission-error');
      updateRoomView(roomIdControl.value, await chrome.tabs.get(tab.id));
      break;
    }
  });
}

async function updateRoomView(roomId, tab) {
  roomView.querySelector('.room-id-text').textContent = roomId;
  if (tab) {
    const hasPermission = await chrome.permissions.contains({ origins: [tab.url] });
    if (!hasPermission) {
      roomView.classList.add('error');
      roomView.classList.add('permission-error');
    }
  }
}

function toggleRoomView(force = !popupView.classList.contains('in-room')) {
  popupView.classList.toggle('in-room', force);
  if (!force) {
    createRoomBtn.disabled = false;
    roomIdControl.disabled = false;
    submitBtn.disabled = !roomIdControl.value || !roomIdControl.valid;
  }
}

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (!tab) return;
  port.onMessage.addListener(function initListener(rooms) {
    port.onMessage.removeListener(initListener);
    initView(tab, rooms[tab.id]);
  });
});
