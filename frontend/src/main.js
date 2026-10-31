const apiBase = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:3000';
const label = document.getElementById('status-label');
const detail = document.getElementById('status-detail');

async function checkBackend() {
  try {
    const res = await fetch(`${apiBase}/api/status`, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const body = await res.json();
    label.textContent = 'Connected';
    label.className = 'status ok';
    detail.textContent = JSON.stringify(body, null, 2);
  } catch (error) {
    label.textContent = 'Unavailable';
    label.className = 'status bad';
    detail.textContent = `Could not reach ${apiBase}\n${error.message}`;
  }
}

checkBackend();
setInterval(checkBackend, 15000);
