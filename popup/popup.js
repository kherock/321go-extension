'use strict';

mdc.autoInit();

const port = chrome.runtime.connect();

const roomIdControl = joinRoomForm.roomId.parentElement.MDCTextField;
const submitBtn = joinRoomForm.submitBtn;

function initView(tab, roomId) {
  if (roomId) {
    roomIdControl.value = roomId;
    roomIdControl.layout();
    updateRoomView(roomId);
  }
  toggleRoomView(!!roomId);
  
  joinRoomForm.roomId.addEventListener('input', (ev) => {
    submitBtn.disabled = !roomIdControl.value || !roomIdControl.valid;
  });
  createRoomBtn.addEventListener('click', (ev) => {
    if (createRoomBtn.disabled) return;
    createRoomBtn.disabled = true;
    port.postMessage({ tab, type: 'CREATE_ROOM' });
  });
  joinRoomForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    createRoomBtn.disabled = true;
    roomIdControl.disabled = true;
    submitBtn.disabled = true;
    port.postMessage({ tab, type: 'JOIN_ROOM', roomId: roomIdControl.value });
  });
  leaveRoomBtn.addEventListener('click', (ev) => {
    port.postMessage({ tab, type: 'LEAVE_ROOM' });
  });

  port.onMessage.addListener((message) => {
    switch (message.type) {
    case 'JOIN_ROOM':
      roomIdControl.value = message.roomId;
      roomIdControl.layout();
      updateRoomView(message.roomId);
      // fall through
    case 'LEAVE_ROOM':
      toggleRoomView();
      break;
    }
  });
}

function updateRoomView(roomId) {
  roomView.querySelector('.room-id-text').textContent = roomId;
}

function toggleRoomView(force = !popupView.classList.contains('in-room')) {
  popupView.classList.toggle('in-room', force);
  if (force) {
    
  } else {
    createRoomBtn.disabled = false;
    roomIdControl.disabled = false;
    submitBtn.disabled = !roomIdControl.value || !roomIdControl.valid;    
  }
}

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab) return;
  console.log(tab);
  port.onMessage.addListener(function initListener(rooms) {
    port.onMessage.removeListener(initListener);
    initView(tab.id, rooms[tab.id]);
  });
});
