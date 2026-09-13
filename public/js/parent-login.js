document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('loginForm');
  const errorEl = document.getElementById('formError');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';

    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;

    try {
      await api.post('/api/auth/parent/login', { email, password });
      window.location.href = '/parent/dashboard.html';
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
});
