// Arm a Vidar tab as Astra through its own tab menu, over the DevTools port.
// Usage (PowerShell, from repo root):
//   node tools\drive\vidar-drive.mjs eval "$((Get-Content -Raw tools\arm-tab.js) -replace 'TARGET_ID','s3-yfmy')"
// Returns "<id>:<armed>" for every tab so the caller can verify the switch took.
// Single quotes only: the text is passed through a PowerShell double-quoted string.
(async () => {
  const id = 'TARGET_ID';
  const b = document.querySelector('[data-id=' + JSON.stringify(id) + ']');
  if (!b) return 'no tab ' + id;
  const r = b.getBoundingClientRect();
  b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5 }));
  await new Promise((res) => setTimeout(res, 300));
  const arm = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Arm as Astra');
  if (arm) arm.click();
  await new Promise((res) => setTimeout(res, 200));
  document.body.click();
  return [...document.querySelectorAll('[data-agent]')].map((x) => x.dataset.id + ':' + x.classList.contains('armed')).join(' ');
})()
