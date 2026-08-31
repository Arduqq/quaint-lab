(function() {
  const MARGIN = 40;

  const tooltip = document.createElement('div');
  tooltip.id = 'custom-tooltip';
  tooltip.classList.add('floating-tooltip');
  tooltip.style.cssText = 'display:none;position:fixed;pointer-events:none;z-index:10000;';
  document.body.appendChild(tooltip);

  let currentTarget = null;
  let mouseX = 0, mouseY = 0;

  function place() {
    if (tooltip.style.display !== 'block') return;
    const w = tooltip.offsetWidth;
    const h = tooltip.offsetHeight;
    let x = mouseX + 15;
    let y = mouseY + 15;
    if (x + w > window.innerWidth)  x = mouseX - w - 15;
    if (y + h > window.innerHeight) y = mouseY - h - 15;
    tooltip.style.left = x + 'px';
    tooltip.style.top  = y + 'px';
  }

  document.addEventListener('mouseover', function(e) {
    const target = e.target.closest('[data-tooltip]');
    if (!target || target === currentTarget) return;

    currentTarget = target;
    tooltip.innerHTML = '';
    tooltip.style.display = 'none';

    const text = target.getAttribute('data-tooltip');
    if (text) {
      tooltip.textContent = text;
      tooltip.style.display = 'block';
      place();
    }
  });

  document.addEventListener('mousemove', function(e) {
    mouseX = e.clientX;
    mouseY = e.clientY;
    place();
  });

  document.addEventListener('mouseout', function(e) {
    const target = e.target.closest('[data-tooltip]');
    if (target && !target.contains(e.relatedTarget)) {
      currentTarget = null;
      tooltip.style.display = 'none';
    }
  });
})();
