document.addEventListener('DOMContentLoaded', () => {
  const nav = document.querySelector('nav.main, nav');
  if (!nav) return;

  // Prepare anchors: extract label text nodes and create external label elements
  const anchors = Array.from(nav.querySelectorAll('a.route'));
  anchors.forEach((a, idx) => {
    // create building element if missing
    if (!a.querySelector('.building')) {
      const b = document.createElement('div');
      b.className = 'building';
      a.insertBefore(b, a.firstChild);
    }

    // extract bracket span (if any) and keep it; extract label text from anchor
    const bracket = a.querySelector('span');
    // Get the anchor's full accessible label (textContent minus bracket content)
    let text = a.textContent || '';
    if (bracket) {
      const bracketText = bracket.textContent || '';
      text = text.replace(bracketText, '').trim();
    }

    // store aria-label and make anchor accessible
    if (text) {
      a.setAttribute('aria-label', text);
    }

    // create external label element
    let label = nav.querySelector(`.nav-label[data-for="nav-${idx}"]`);
    if (!label) {
      label = document.createElement('div');
      label.className = 'nav-label';
      label.setAttribute('data-for', `nav-${idx}`);
      label.textContent = text;
      nav.appendChild(label);
    }

    // tie label to anchor via data attr
    a.dataset.navId = `nav-${idx}`;
  });

  // Position labels adjacent to their buildings and scale fonts
  function positionLabels() {
    const navRect = nav.getBoundingClientRect();
    anchors.forEach((a) => {
      const id = a.dataset.navId;
      const label = nav.querySelector(`.nav-label[data-for="${id}"]`);
      if (!label) return;

      // ensure building is present
      const building = a.querySelector('.building');
      if (!building) return;

      // compute building bbox relative to nav
      const bRect = building.getBoundingClientRect();
      const rel = {
        left: bRect.left - navRect.left,
        top: bRect.top - navRect.top,
        right: bRect.right - navRect.left,
        bottom: bRect.bottom - navRect.top,
        width: bRect.width,
        height: bRect.height,
        cx: (bRect.left + bRect.right)/2 - navRect.left,
        cy: (bRect.top + bRect.bottom)/2 - navRect.top
      };

      // choose side with most space: preferences right, left, top, bottom
      const space = {
        right: navRect.width - rel.right,
        left: rel.left,
        top: rel.top,
        bottom: navRect.height - rel.bottom
      };
      let side = 'right';
      let maxSpace = space.right;
      Object.entries(space).forEach(([k,v]) => { if (v > maxSpace) { maxSpace = v; side = k; } });

      // position label with a small offset
      const offset = 12;
      let lx = 0, ly = 0;
      if (side === 'right') {
        lx = rel.right + offset;
        ly = rel.cy - (label.offsetHeight/2);
        label.style.left = `${lx}px`;
        label.style.top = `${Math.max(8, ly)}px`;
        label.style.transform = 'translate(0,0)';
      } else if (side === 'left') {
        lx = rel.left - offset - label.offsetWidth;
        ly = rel.cy - (label.offsetHeight/2);
        label.style.left = `${Math.max(8, lx)}px`;
        label.style.top = `${Math.max(8, ly)}px`;
        label.style.transform = 'translate(0,0)';
      } else if (side === 'top') {
        lx = rel.cx - (label.offsetWidth/2);
        ly = rel.top - offset - label.offsetHeight;
        label.style.left = `${Math.max(8, lx)}px`;
        label.style.top = `${Math.max(8, ly)}px`;
        label.style.transform = 'translate(0,0)';
      } else { // bottom
        lx = rel.cx - (label.offsetWidth/2);
        ly = rel.bottom + offset;
        label.style.left = `${Math.max(8, lx)}px`;
        label.style.top = `${Math.max(8, ly)}px`;
        label.style.transform = 'translate(0,0)';
      }

      // scale font relative to building width
      const bsize = rel.width || parseFloat(getComputedStyle(a).width) || 120;
      const fontSize = Math.max(12, Math.round(bsize * 0.14));
      label.style.fontSize = `${fontSize}px`;

      // hide label if nav container is small (fallback)
      const navWidth = navRect.width;
      if (navWidth < 700) {
        label.style.display = 'none';
      } else {
        label.style.display = 'block';
      }
    });
  }

  // reposition on load and on resize + images loaded
  window.addEventListener('resize', () => requestAnimationFrame(positionLabels));
  // also recalc after a short delay to allow CSS transitions
  setTimeout(positionLabels, 120);
  // Observe mutations that might change sizes
  const ro = new ResizeObserver(() => positionLabels());
  ro.observe(nav);
  anchors.forEach(a => ro.observe(a));

  // If anchor gets focused, briefly highlight the label
  anchors.forEach(a => {
    const id = a.dataset.navId;
    const label = nav.querySelector(`.nav-label[data-for="${id}"]`);
    a.addEventListener('focus', () => {
      if (label) label.style.boxShadow = '0 4px 14px rgba(0,0,0,0.4)';
    });
    a.addEventListener('blur', () => {
      if (label) label.style.boxShadow = '';
    });
  });
});
