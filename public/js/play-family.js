let selectedChildId = null;
let pin = '';

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function getFamilyCodeFromUrl() {
  const pathMatch = window.location.pathname.match(/^\/play\/([A-Za-z0-9]{6})$/);
  if (pathMatch) return pathMatch[1].toUpperCase();
  const params = new URLSearchParams(window.location.search);
  return (params.get('code') || '').toUpperCase();
}

function renderPinDots() {
  const dots = document.querySelectorAll('#pinDisplay .pin-dot');
  dots.forEach((dot, i) => dot.classList.toggle('filled', i < pin.length));
}

function buildKeypad() {
  const keypad = document.getElementById('pinKeypad');
  keypad.innerHTML = '';
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', ''];
  keys.forEach((k) => {
    const btn = document.createElement('button');
    btn.className = 'key';
    btn.textContent = k;
    if (k === '') {
      btn.style.visibility = 'hidden';
      btn.disabled = true;
    } else {
      btn.addEventListener('click', () => pressKey(k));
    }
    keypad.appendChild(btn);
  });
}

async function pressKey(k) {
  const errorEl = document.getElementById('pinError');
  if (k === '⌫') {
    pin = pin.slice(0, -1);
    renderPinDots();
    return;
  }
  if (pin.length >= 4) return;
  pin += k;
  renderPinDots();

  if (pin.length === 4) {
    errorEl.textContent = '';
    try {
      await api.post('/api/auth/child/login', { childId: selectedChildId, pin });
      window.location.href = '/game/index.html';
    } catch (err) {
      errorEl.textContent = err.message;
      pin = '';
      renderPinDots();
    }
  }
}

function showAvatarScreen() {
  document.getElementById('screen-avatars').classList.remove('hidden');
  document.getElementById('screen-pin').classList.add('hidden');
  pin = '';
  selectedChildId = null;
}

function showPinScreen(child) {
  selectedChildId = child.id;
  pin = '';
  document.getElementById('screen-avatars').classList.add('hidden');
  document.getElementById('screen-pin').classList.remove('hidden');
  document.getElementById('screenTitle').innerHTML = `Hi, <span>${escapeHtml(child.display_name)}</span>!`;
  document.getElementById('screenSub').textContent = 'Enter your 4-digit PIN';
  renderPinDots();
}

async function loadFamily() {
  const code = getFamilyCodeFromUrl();
  const errorEl = document.getElementById('loadError');

  if (!/^[A-Z0-9]{6}$/.test(code)) {
    errorEl.textContent = 'Missing or invalid family code.';
    return;
  }

  try {
    const data = await api.get(`/api/kids/family/${code}`);
    const grid = document.getElementById('screen-avatars');
    grid.innerHTML = '';
    if (data.children.length === 0) {
      grid.innerHTML = '<p class="form-note">No kids set up for this family yet — ask a grown-up!</p>';
      return;
    }
    data.children.forEach((child) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'avatar-tile';
      btn.innerHTML = `
        <span class="avatar-emoji">${escapeHtml(child.avatar_emoji)}</span>
        <span class="avatar-name">${escapeHtml(child.display_name)}</span>
      `;
      btn.addEventListener('click', () => showPinScreen(child));
      grid.appendChild(btn);
    });
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  buildKeypad();
  loadFamily();
  document.getElementById('backToAvatars').addEventListener('click', showAvatarScreen);
});
