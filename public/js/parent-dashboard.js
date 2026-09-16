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

// Legacy fixed-mode rows predate the AI-decided skill system - current
// rows carry their own human title via a child_skills join (skill_title),
// this is only a fallback for old history and for a since-deactivated
// skill with no matching child_skills row any more.
const LEGACY_MODE_LABELS = { round: 'Round Up Cove', addsub: 'Treasure Math', reading: 'Story Cove' };
function modeLabel(gameMode, skillTitle) {
  if (skillTitle) return skillTitle;
  if (!gameMode) return null;
  return LEGACY_MODE_LABELS[gameMode] || gameMode.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

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
  updateSearchStatus();
}

function updateSearchStatus() {
  const noteEl = document.getElementById('searchStatusNote');
  noteEl.textContent = familyState.family.video_search_enabled
    ? '🔍 Video search is ON for your family.'
    : '🔒 Video search is OFF - your kid can only watch videos from the approved list above.';
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

      <details style="margin-top:12px;">
        <summary style="cursor:pointer; color: var(--sea-foam);">AI Learning Plan</summary>
        <div data-role="planCurrent" style="margin:10px 0;"></div>
        <details style="margin:8px 0;">
          <summary style="cursor:pointer; font-size:13px; color: var(--sea-foam);">📜 Earlier plans</summary>
          <div data-role="planHistory" style="margin-top:8px;"></div>
        </details>
        <label style="display:flex; align-items:center; gap:8px; font-size:13px; margin:10px 0;">
          <input type="checkbox" data-role="autoAdaptToggle" data-action="toggleAutoAdapt" ${child.auto_adapt_enabled ? 'checked' : ''}>
          Automatically adjust this plan based on how they're doing (checks in every few completed stages)
        </label>
        <div class="field" style="margin-top:10px;">
          <label>Grade</label>
          <select data-role="planGrade">
            ${GRADE_OPTIONS.map((g) => `<option value="${g}">${g}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>What does your child struggle with?</label>
          <textarea data-role="planNotes" rows="3" maxlength="2000"></textarea>
        </div>
        <div class="field">
          <label>Upload a document (optional - report card, teacher note, worksheet photo)</label>
          <input type="file" data-role="planDocument" accept=".txt,.pdf,image/jpeg,image/png,image/webp">
        </div>
        <p class="form-note">This runs a locally-hosted AI model to suggest which stages/skills to emphasize - it never writes or grades any math itself. Can take up to a minute. <strong>Generating a new plan replaces the active one</strong> - if you want to cover multiple things, describe them together in one submission, or check "Earlier plans" above afterward to bring back an older one.</p>
        <p class="form-note hidden" data-role="planEditingNote" style="color: var(--gold);">Editing an earlier prompt - updating it will make it the active plan again.</p>
        <p class="form-error" data-role="planError"></p>
        <button type="button" class="submit-btn" data-action="generatePlan" data-role="generatePlanBtn">Generate Plan</button>
        <button type="button" class="small-btn hidden" data-action="cancelEditPlan" data-role="cancelEditBtn" style="margin-left:8px;">Cancel edit</button>
      </details>
    `;
    list.appendChild(card);
    loadChildRewards(child.id, card);
    loadLearningPlan(child.id, card);
  });
}

const GRADE_OPTIONS = ['Pre-K', 'K', '1st', '2nd', '3rd', '4th', '5th', '6th+'];

function renderPlanSummary(el, plan) {
  if (!plan) {
    el.innerHTML = '<p class="form-note">No plan generated yet.</p>';
    return;
  }
  const p = plan.profile;
  const autoBadge = plan.generated_by === 'auto'
    ? '<span class="suggested-badge" style="margin-left:6px;">🤖 Auto-adjusted</span>' : '';
  const trigger = plan.generated_by === 'auto' && plan.trigger_summary
    ? `<details style="margin-top:4px;"><summary style="cursor:pointer; font-size:12px; color: var(--sea-foam);">Why it changed</summary><pre class="form-note" style="white-space:pre-wrap; font-family:inherit;">${escapeHtml(plan.trigger_summary)}</pre></details>`
    : '';
  const skills = (p && p.skills) || [];
  const skillChips = skills.map((s) => `
    <span class="skill-chip">${escapeHtml(s.icon)} <strong>${escapeHtml(s.title)}</strong> - ${escapeHtml(s.description)}</span>
  `).join('');

  el.innerHTML = `
    <p class="form-note" style="color: var(--gold);">Latest plan (${formatDate(plan.created_at)}, grade ${escapeHtml(plan.grade)})${autoBadge}:</p>
    <p class="form-note">${escapeHtml(p.focusSummary)}</p>
    <div class="skill-chip-list">${skillChips || '<span class="form-note">No skills in this plan.</span>'}</div>
    ${trigger}
    <button type="button" class="small-btn" data-action="editPlan" data-plan-id="${plan.id}"
      data-grade="${escapeHtml(plan.grade)}" data-notes="${escapeHtml(plan.parent_notes)}" style="margin-top:6px;">Edit this prompt</button>
  `;
}

function renderPlanHistory(el, childId, plans) {
  if (plans.length <= 1) {
    el.innerHTML = '<p class="form-note">No earlier plans yet.</p>';
    return;
  }
  // Skip the first (current) entry - this is only the earlier ones.
  const rows = plans.slice(1).map((plan) => {
    const badge = plan.generated_by === 'auto' ? ' 🤖' : '';
    return `
      <div class="entity-row">
        <span class="label">${formatDate(plan.created_at)} · grade ${escapeHtml(plan.grade)}${badge}<br>
          <span style="opacity:0.8;">${escapeHtml(plan.parent_notes.slice(0, 100))}${plan.parent_notes.length > 100 ? '…' : ''}</span>
        </span>
        <button type="button" class="small-btn" data-action="reuseNotes" data-child-id="${childId}"
          data-grade="${escapeHtml(plan.grade)}" data-notes="${escapeHtml(plan.parent_notes)}">Use these notes again</button>
        <button type="button" class="small-btn" data-action="editPlan" data-plan-id="${plan.id}"
          data-grade="${escapeHtml(plan.grade)}" data-notes="${escapeHtml(plan.parent_notes)}">Edit this prompt</button>
      </div>
    `;
  }).join('');
  el.innerHTML = rows;
}

async function loadLearningPlan(childId, card) {
  const el = card.querySelector('[data-role="planCurrent"]');
  const historyEl = card.querySelector('[data-role="planHistory"]');
  try {
    const data = await api.get(`/api/family/children/${childId}/learning-plan`);
    renderPlanSummary(el, data.plan);
  } catch (err) {
    el.innerHTML = '<p class="form-note">Could not load plan.</p>';
  }
  try {
    const historyData = await api.get(`/api/family/children/${childId}/learning-plans`);
    renderPlanHistory(historyEl, childId, historyData.plans);
  } catch (err) {
    historyEl.innerHTML = '<p class="form-note">Could not load history.</p>';
  }
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
          <td>${modeLabel(h.game_mode, h.skill_title) ? escapeHtml(modeLabel(h.game_mode, h.skill_title)) : '—'}${h.stage ? ` (Stage ${h.stage})` : ''}</td>
          <td>${h.minutes} min</td>
          <td class="${h.redeemed ? 'redeemed-badge' : 'unredeemed-badge'}">${
            h.redeemed
              ? (h.watched_video_title ? `Watched: ${escapeHtml(h.watched_video_title)}` : 'Redeemed')
              : 'Unredeemed'
          }</td>
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

async function loadVideos() {
  const listEl = document.getElementById('videosList');
  try {
    const data = await api.get('/api/videos');
    if (data.videos.length === 0) {
      listEl.innerHTML = '<p class="form-note">No approved videos yet.</p>';
      return;
    }
    listEl.innerHTML = data.videos.map((v) => `
      <div class="entity-row" data-video-id="${v.id}">
        <span class="label">🎬 ${escapeHtml(v.title)}</span>
        <button type="button" class="danger-btn" data-action="deleteVideo">Delete</button>
      </div>
    `).join('');
  } catch (err) {
    listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadDashboard();
  loadVideos();

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

  document.getElementById('childrenList').addEventListener('change', async (e) => {
    if (e.target.dataset.action !== 'toggleAutoAdapt') return;
    const card = e.target.closest('.child-card');
    const childId = card.dataset.childId;
    try {
      await api.patch(`/api/family/children/${childId}`, { autoAdaptEnabled: e.target.checked });
    } catch (err) {
      e.target.checked = !e.target.checked;
      alert(err.message);
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

    if (action === 'reuseNotes') {
      card.querySelector('[data-role="planGrade"]').value = e.target.dataset.grade;
      card.querySelector('[data-role="planNotes"]').value = e.target.dataset.notes;
      card.querySelector('[data-role="planNotes"]').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    if (action === 'editPlan') {
      card.dataset.editingPlanId = e.target.dataset.planId;
      card.querySelector('[data-role="planGrade"]').value = e.target.dataset.grade;
      card.querySelector('[data-role="planNotes"]').value = e.target.dataset.notes;
      card.querySelector('[data-role="generatePlanBtn"]').textContent = 'Update Plan';
      card.querySelector('[data-role="planEditingNote"]').classList.remove('hidden');
      card.querySelector('[data-role="cancelEditBtn"]').classList.remove('hidden');
      card.querySelector('[data-role="planNotes"]').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    if (action === 'cancelEditPlan') {
      delete card.dataset.editingPlanId;
      card.querySelector('[data-role="planGrade"]').value = GRADE_OPTIONS[0];
      card.querySelector('[data-role="planNotes"]').value = '';
      card.querySelector('[data-role="generatePlanBtn"]').textContent = 'Generate Plan';
      card.querySelector('[data-role="planEditingNote"]').classList.add('hidden');
      card.querySelector('[data-role="cancelEditBtn"]').classList.add('hidden');
      return;
    }

    if (action === 'generatePlan') {
      const errorEl = card.querySelector('[data-role="planError"]');
      const grade = card.querySelector('[data-role="planGrade"]').value;
      const notes = card.querySelector('[data-role="planNotes"]').value;
      const fileInput = card.querySelector('[data-role="planDocument"]');
      errorEl.textContent = '';

      if (!notes.trim()) {
        errorEl.textContent = 'Please describe what your child struggles with';
        return;
      }

      const editingPlanId = card.dataset.editingPlanId;
      const btn = e.target;
      const originalLabel = btn.textContent;
      btn.disabled = true;
      btn.textContent = editingPlanId ? 'Updating… (can take up to a minute)' : 'Generating… (can take up to a minute)';

      const formData = new FormData();
      formData.append('grade', grade);
      formData.append('notes', notes);
      if (fileInput.files[0]) formData.append('document', fileInput.files[0]);

      try {
        if (editingPlanId) {
          await api.patchForm(`/api/family/children/${childId}/learning-plan/${editingPlanId}`, formData);
          delete card.dataset.editingPlanId;
          card.querySelector('[data-role="planEditingNote"]').classList.add('hidden');
          card.querySelector('[data-role="cancelEditBtn"]').classList.add('hidden');
          btn.textContent = 'Generate Plan';
        } else {
          await api.postForm(`/api/family/children/${childId}/learning-plan`, formData);
          btn.textContent = originalLabel;
        }
        await loadLearningPlan(childId, card);
        fileInput.value = '';
      } catch (err) {
        errorEl.textContent = err.message;
        btn.textContent = originalLabel;
      } finally {
        btn.disabled = false;
      }
    }
  });

  document.getElementById('addVideoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('addVideoError');
    errorEl.textContent = '';

    const url = document.getElementById('videoUrl').value;
    const title = document.getElementById('videoTitle').value;

    try {
      await api.post('/api/videos', { url, title });
      document.getElementById('addVideoForm').reset();
      await loadVideos();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  document.getElementById('videosList').addEventListener('click', async (e) => {
    if (e.target.dataset.action !== 'deleteVideo') return;
    const row = e.target.closest('[data-video-id]');
    if (!confirm('Remove this video? Kids will no longer be able to watch it.')) return;
    await api.del(`/api/videos/${row.dataset.videoId}`).catch((err) => alert(err.message));
    await loadVideos();
  });

  document.getElementById('searchSettingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('searchSettingsError');
    errorEl.textContent = '';
    const youtubeApiKey = document.getElementById('youtubeApiKey').value;
    if (!youtubeApiKey) {
      errorEl.textContent = 'Please paste an API key';
      return;
    }
    try {
      await api.patch('/api/family/settings', { youtubeApiKey });
      document.getElementById('searchSettingsForm').reset();
      await loadDashboard();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  document.getElementById('disableSearchBtn').addEventListener('click', async () => {
    if (!confirm('Turn off video search for your family?')) return;
    await api.patch('/api/family/settings', { youtubeApiKey: '' }).catch((err) => alert(err.message));
    document.getElementById('searchSettingsForm').reset();
    await loadDashboard();
  });
});
