let familyState = null;
let selectedAvatar = null;

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const MODE_LABELS = { round: 'Round Up Cove', addsub: 'Treasure Math' };

async function loadDashboard() {
  try {
    familyState = await api.get('/api/family/me');
  } catch (err) {
    if (err.status === 401) {
      window.location.href = '/parent/login.html';
      return;
    }
    throw err;
  }

  document.getElementById('familyCodeDisplay').textContent = familyState.family.family_code;
  document.getElementById('playLinkNote').textContent =
    `Direct kid login link: ${window.location.origin}/play/${familyState.family.family_code}`;

  renderAvatarPicker();
  renderChildren();
}

function renderAvatarPicker() {
  const picker = document.getElementById('avatarPicker');
  picker.innerHTML = '';
  familyState.avatarChoices.forEach((emoji) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'avatar-tile';
    btn.dataset.emoji = emoji;
    btn.innerHTML = `<span class="avatar-emoji">${emoji}</span>`;
    btn.addEventListener('click', () => {
      selectedAvatar = emoji;
      Array.from(picker.children).forEach((c) => c.style.outline = '');
      btn.style.outline = `3px solid var(--gold)`;
    });
    picker.appendChild(btn);
  });
}

function renderChildren() {
  const list = document.getElementById('childrenList');
  list.innerHTML = '';

  if (familyState.children.length === 0) {
    list.innerHTML = '<p class="form-note">No children added yet.</p>';
    return;
  }

  familyState.children.forEach((child) => {
    const card = document.createElement('div');
    card.className = 'child-card';
    card.dataset.childId = child.id;
    card.innerHTML = `
      <div class="child-card-head">
        <span class="avatar-emoji">${child.avatar_emoji}</span>
        <span class="child-name">${escapeHtml(child.display_name)}</span>
      </div>
      <div class="reward-balance" data-role="balance">Loading rewards…</div>
      <button type="button" class="submit-btn" data-action="redeem" style="margin-top:8px; display:none;">Mark as Redeemed</button>
      <table class="history-table" data-role="history"></table>
      <details style="margin-top:12px;">
        <summary style="cursor:pointer; color: var(--sea-foam);">Edit / reset PIN</summary>
        <div class="field" style="margin-top:10px;">
          <label>Name</label>
          <input type="text" data-role="editName" value="${escapeHtml(child.display_name)}" maxlength="40">
        </div>
        <div class="field">
          <label>New 4-digit PIN (leave blank to keep current)</label>
          <input type="text" data-role="editPin" inputmode="numeric" maxlength="4" pattern="\\d{4}">
        </div>
        <p class="form-error" data-role="editError"></p>
        <button type="button" class="submit-btn" data-action="saveEdit">Save Changes</button>
      </details>
    `;
    list.appendChild(card);
    loadChildRewards(child.id, card);
  });
}

async function loadChildRewards(childId, card) {
  const balanceEl = card.querySelector('[data-role="balance"]');
  const historyEl = card.querySelector('[data-role="history"]');
  const redeemBtn = card.querySelector('[data-action="redeem"]');

  try {
    const data = await api.get(`/api/rewards/child/${childId}`);
    balanceEl.textContent = `🪙 ${data.unredeemedMinutes} unredeemed minute${data.unredeemedMinutes === 1 ? '' : 's'}`;
    redeemBtn.style.display = data.unredeemedMinutes > 0 ? 'inline-block' : 'none';

    if (data.history.length === 0) {
      historyEl.innerHTML = '<tr><td class="form-note">No rewards earned yet.</td></tr>';
    } else {
      const rows = data.history.map((h) => `
        <tr>
          <td>${formatDate(h.created_at)}</td>
          <td>${h.game_mode ? MODE_LABELS[h.game_mode] : '—'}${h.stage ? ` (Stage ${h.stage})` : ''}</td>
          <td>${h.minutes} min</td>
          <td class="${h.redeemed ? 'redeemed-badge' : 'unredeemed-badge'}">${h.redeemed ? 'Redeemed' : 'Unredeemed'}</td>
        </tr>
      `).join('');
      historyEl.innerHTML = `
        <tr><th>Date</th><th>Game</th><th>Minutes</th><th>Status</th></tr>
        ${rows}
      `;
    }
  } catch (err) {
    balanceEl.textContent = 'Could not load rewards';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadDashboard();

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await api.post('/api/auth/parent/logout');
    window.location.href = '/parent/login.html';
  });

  document.getElementById('addChildForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('addChildError');
    errorEl.textContent = '';

    const displayName = document.getElementById('childName').value;
    const pin = document.getElementById('childPin').value;

    if (!selectedAvatar) {
      errorEl.textContent = 'Please choose an avatar';
      return;
    }

    try {
      await api.post('/api/family/children', { displayName, avatarEmoji: selectedAvatar, pin });
      document.getElementById('addChildForm').reset();
      selectedAvatar = null;
      await loadDashboard();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  document.getElementById('childrenList').addEventListener('click', async (e) => {
    const action = e.target.dataset.action;
    if (!action) return;
    const card = e.target.closest('.child-card');
    const childId = card.dataset.childId;

    if (action === 'redeem') {
      await api.post(`/api/rewards/child/${childId}/redeem`);
      await loadChildRewards(childId, card);
    }

    if (action === 'saveEdit') {
      const errorEl = card.querySelector('[data-role="editError"]');
      errorEl.textContent = '';
      const displayName = card.querySelector('[data-role="editName"]').value;
      const pin = card.querySelector('[data-role="editPin"]').value;
      const body = { displayName };
      if (pin) body.pin = pin;
      try {
        await api.patch(`/api/family/children/${childId}`, body);
        await loadDashboard();
      } catch (err) {
        errorEl.textContent = err.message;
      }
    }
  });
});
