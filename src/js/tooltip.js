(function() {
  const tooltip = document.createElement('div');
  tooltip.id = 'custom-tooltip';
  tooltip.style.position = 'fixed';
  tooltip.style.display = 'none';
  tooltip.style.pointerEvents = 'none';
  tooltip.style.zIndex = '10000';
  tooltip.style.padding = '5px 10px';
  tooltip.style.background = 'rgba(0, 0, 0, 0.85)';
  tooltip.style.color = '#fff';
  tooltip.style.borderRadius = '4px';
  tooltip.style.fontSize = '12px';
  tooltip.style.border = '1px solid rgba(255, 255, 255, 0.2)';
  tooltip.style.boxShadow = '0 2px 10px rgba(0, 0, 0, 0.5)';
  tooltip.style.fontFamily = 'var(--main-font), sans-serif';
  tooltip.style.maxWidth = '300px';
  document.body.appendChild(tooltip);

  document.addEventListener('mouseover', function(e) {
    const target = e.target.closest('[data-tooltip], [data-tooltip-image]');
    if (target) {
      tooltip.innerHTML = '';
      
      const imgUrl = target.getAttribute('data-tooltip-image');
      if (imgUrl) {
        const img = document.createElement('img');
        img.src = imgUrl;
        img.style.maxWidth = '100%';
        img.style.display = 'block';
        img.style.borderRadius = '2px';
        tooltip.appendChild(img);
        
        // If there is also text, add it below
        const text = target.getAttribute('data-tooltip');
        if (text) {
          const caption = document.createElement('div');
          caption.textContent = text;
          caption.style.marginTop = '5px';
          caption.style.textAlign = 'center';
          caption.style.fontWeight = 'bold';
          tooltip.appendChild(caption);
        }
      } else {
        tooltip.textContent = target.getAttribute('data-tooltip');
      }
      
      tooltip.style.display = 'block';
    }
  });

  document.addEventListener('mousemove', function(e) {
    if (tooltip.style.display === 'block') {
      let x = e.clientX + 15;
      let y = e.clientY + 15;

      const rect = tooltip.getBoundingClientRect();
      if (x + rect.width > window.innerWidth) {
        x = e.clientX - rect.width - 15;
      }
      if (y + rect.height > window.innerHeight) {
        y = e.clientY - rect.height - 15;
      }

      tooltip.style.left = x + 'px';
      tooltip.style.top = y + 'px';
    }
  });

  document.addEventListener('mouseout', function(e) {
    const target = e.target.closest('[data-tooltip], [data-tooltip-image]');
    if (target) {
      tooltip.style.display = 'none';
    }
  });
})();
