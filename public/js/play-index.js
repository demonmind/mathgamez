document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('codeForm');
  const codeInput = document.getElementById('code');
  const errorEl = document.getElementById('formError');

  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = codeInput.value.trim();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      errorEl.textContent = 'That code should be 6 letters/numbers';
      return;
    }
    window.location.href = `/play/${code}`;
  });
});
