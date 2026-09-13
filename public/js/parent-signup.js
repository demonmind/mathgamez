document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('signupForm');
  const joinToggle = document.getElementById('joinToggle');
  const familyCodeField = document.getElementById('familyCodeField');
  const familyCodeInput = document.getElementById('familyCode');
  const errorEl = document.getElementById('formError');

  joinToggle.addEventListener('change', () => {
    familyCodeField.classList.toggle('hidden', !joinToggle.checked);
  });

  familyCodeInput.addEventListener('input', () => {
    familyCodeInput.value = familyCodeInput.value.toUpperCase();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';

    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const familyCode = joinToggle.checked ? familyCodeInput.value.trim() : undefined;

    try {
      await api.post('/api/auth/parent/signup', { email, password, familyCode });
      window.location.href = '/parent/dashboard.html';
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
});
