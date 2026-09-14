function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

async function loadFamilies() {
  const listEl = document.getElementById('familiesList');
  const errorEl = document.getElementById('loadError');
  errorEl.textContent = '';

  let data;
  try {
    data = await api.get('/api/admin/families');
  } catch (err) {
    if (err.status === 401) {
      window.location.href = '/admin/login.html';
      return;
    }
    errorEl.textContent = err.message;
    return;
  }

  listEl.innerHTML = '';
  if (data.families.length === 0) {
    listEl.innerHTML = '<p class="form-note">No families yet.</p>';
    return;
  }

  data.families.forEach((family) => {
    const card = document.createElement('div');
    card.className = 'family-card';
    card.dataset.familyId = family.id;
    card.innerHTML = `
      <div class="family-card-head">
        <span class="code">${escapeHtml(family.family_code)}</span>
        <span class="meta">${family.parent_count} parent${family.parent_count === 1 ? '' : 's'} · ${family.child_count} child${family.child_count === 1 ? '' : 'ren'} · created ${formatDate(family.created_at)}</span>
        <button type="button" class="small-btn" data-action="toggle">View details</button>
      </div>
      <div class="family-detail hidden" data-role="detail"></div>
    `;
    listEl.appendChild(card);
  });
}

async function loadFamilyDetail(familyId, card) {
  const detailEl = card.querySelector('[data-role="detail"]');
  detailEl.innerHTML = '<p class="form-note">Loading…</p>';
  detailEl.classList.remove('hidden');

  const data = await api.get(`/api/admin/families/${familyId}`);

  const parentRows = data.parents.map((p) => `
    <div class="entity-row" data-parent-id="${p.id}">
      <span class="label">${escapeHtml(p.email)}</span>
      <input type="password" class="small-input" data-role="newPassword" placeholder="New password">
      <button type="button" class="small-btn" data-action="resetParentPassword">Reset password</button>
      <button type="button" class="danger-btn" data-action="deleteParent">Delete</button>
    </div>
  `).join('') || '<p class="form-note">No parents.</p>';

  const childRows = data.children.map((c) => `
    <div class="entity-row" data-child-id="${c.id}">
      <span class="label">${escapeHtml(c.avatar_emoji)} ${escapeHtml(c.display_name)} — 🪙 ${c.unredeemed_minutes} min</span>
      <input type="text" inputmode="numeric" maxlength="4" class="small-input" data-role="newPin" placeholder="New PIN">
      <button type="button" class="small-btn" data-action="resetChildPin">Reset PIN</button>
      <button type="button" class="danger-btn" data-action="deleteChild">Delete</button>
    </div>
  `).join('') || '<p class="form-note">No children.</p>';

  detailEl.innerHTML = `
    <p class="section-label">Parents</p>
    ${parentRows}
    <p class="section-label">Children</p>
    ${childRows}
    <button type="button" class="danger-btn" style="margin-top:14px;" data-action="deleteFamily">Delete Entire Family</button>
  `;
}

document.addEventListener('DOMContentLoaded', () => {
  loadFamilies();

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await api.post('/api/auth/admin/logout');
    window.location.href = '/admin/login.html';
  });

  document.getElementById('familiesList').addEventListener('click', async (e) => {
    const action = e.target.dataset.action;
    if (!action) return;
    const card = e.target.closest('.family-card');
    const familyId = card.dataset.familyId;

    if (action === 'toggle') {
      const detailEl = card.querySelector('[data-role="detail"]');
      if (detailEl.classList.contains('hidden') || detailEl.innerHTML === '') {
        await loadFamilyDetail(familyId, card);
      } else {
        detailEl.classList.toggle('hidden');
      }
      return;
    }

    if (action === 'deleteFamily') {
      if (!confirm('Delete this entire family, including all parents, children, and reward history? This cannot be undone.')) return;
      await api.del(`/api/admin/families/${familyId}`).catch((err) => alert(err.message));
      await loadFamilies();
      return;
    }

    const row = e.target.closest('.entity-row');

    if (action === 'deleteParent') {
      if (!confirm('Delete this parent account?')) return;
      await api.del(`/api/admin/parents/${row.dataset.parentId}`).catch((err) => alert(err.message));
      await loadFamilyDetail(familyId, card);
    }

    if (action === 'resetParentPassword') {
      const value = row.querySelector('[data-role="newPassword"]').value;
      if (value.length < 8) { alert('Password must be at least 8 characters'); return; }
      await api.patch(`/api/admin/parents/${row.dataset.parentId}`, { password: value }).catch((err) => alert(err.message));
      await loadFamilyDetail(familyId, card);
    }

    if (action === 'deleteChild') {
      if (!confirm('Delete this child, including their game history and reward ledger?')) return;
      await api.del(`/api/admin/children/${row.dataset.childId}`).catch((err) => alert(err.message));
      await loadFamilyDetail(familyId, card);
      await loadFamilies();
    }

    if (action === 'resetChildPin') {
      const value = row.querySelector('[data-role="newPin"]').value;
      if (!/^\d{4}$/.test(value)) { alert('PIN must be exactly 4 digits'); return; }
      await api.patch(`/api/admin/children/${row.dataset.childId}`, { pin: value }).catch((err) => alert(err.message));
      await loadFamilyDetail(familyId, card);
    }
  });
});
