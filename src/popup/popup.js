'use strict';

import './popup.scss';

import 'chrome-extension-async';
import mdcAutoInit from '@material/auto-init';
import { MDCRipple } from '@material/ripple';
import { MDCTextField } from '@material/textfield';
import { BehaviorSubject } from 'rxjs';

for (const component of [MDCRipple, MDCTextField]) {
  mdcAutoInit.register(component.name, component);
}
mdcAutoInit();

const {
  createRoomBtn,
  joinRoomForm,
  leaveRoomBtn,
  requestPermissionBtn,
  roomView,
  popupView,
} = window;

const roomIdControl = joinRoomForm.roomId.parentElement.MDCTextField;
const submitBtn = joinRoomForm.submitBtn;

const port = chrome.runtime.connect();

class Popup {
  constructor(tab, roomId) {
    this.tab = tab;
    this.roomId = new BehaviorSubject(roomId);
  }

  initView() {
    this.roomId.subscribe((value) => {
      if (value) {
        roomIdControl.value = value;
        roomIdControl.layout();
      }
      createRoomBtn.disabled = !!value;
      roomIdControl.disabled = !!value;
      submitBtn.disabled = !!value || !roomIdControl.valid || !roomIdControl.value;
      this.updateRoomView();
      this.setRoomView();
    });

    joinRoomForm.roomId.addEventListener('input', (ev) => {
      submitBtn.disabled = !roomIdControl.value || !roomIdControl.valid;
    });
    createRoomBtn.addEventListener('click', async (ev) => {
      if (createRoomBtn.disabled) return;
      createRoomBtn.disabled = true;
      submitBtn.disabled = true;
      const hasPermission = await chrome.permissions.request({ origins: [this.tab.url] });
      if (!hasPermission) return;
      port.postMessage({
        tab: this.tab.id,
        type: 'CREATE_ROOM',
      });
    });
    joinRoomForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      createRoomBtn.disabled = true;
      roomIdControl.disabled = true;
      submitBtn.disabled = true;
      port.postMessage({
        tab: this.tab.id,
        type: 'JOIN_ROOM',
        roomId: roomIdControl.value,
      });
    });
    requestPermissionBtn.addEventListener('click', async (ev) => {
      const hasPermission = await chrome.permissions.request({ origins: [this.tab.url] });
      if (!hasPermission) return;
      roomView.classList.remove('error');
      roomView.classList.remove('permission-error');
      port.postMessage({
        tab: this.tab.id,
        type: 'RESYNC_MEDIA',
      });
    });
    leaveRoomBtn.addEventListener('click', (ev) => {
      port.postMessage({
        tab: this.tab.id,
        type: 'LEAVE_ROOM',
      });
    });

    port.onMessage.addListener(async (message) => {
      switch (message.type) {
      case 'JOIN_ROOM':
        this.roomId.next(message.roomId);
        break;
      case 'LEAVE_ROOM':
        this.roomId.next(null);
        break;
      case 'PERMISSION_REQUIRED':
        roomView.classList.add('error');
        roomView.classList.add('permission-error');
        this.tab = await chrome.tabs.get(this.tab.id);
        this.updateRoomView();
        break;
      }
    });
  }

  async updateRoomView() {
    roomView.querySelector('.room-id-text').textContent = this.roomId.value;
    const hasPermission = await chrome.permissions.contains({ origins: [this.tab.url] });
    if (!hasPermission) {
      roomView.classList.add('error');
      roomView.classList.add('permission-error');
    }
  }

  setRoomView() {
    popupView.classList.toggle('in-room', !!this.roomId.value);
  }
}

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (!tab) return;
  port.onMessage.addListener(function initListener(rooms) {
    port.onMessage.removeListener(initListener);
    new Popup(tab, rooms[tab.id]).initView();
  });
});
