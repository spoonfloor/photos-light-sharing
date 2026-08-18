/**
 * Non-virtual month-grouped grid renderer (share viewer).
 */
const SimplePhotoGrid = (() => {
  function monthKey(date) {
    if (!date) {
      return 'undated';
    }
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  function monthHeaderLabel(date) {
    if (!date) {
      return 'Undated';
    }
    if (typeof GridLayout !== 'undefined' && GridLayout.monthLabel) {
      return GridLayout.monthLabel(monthKey(date));
    }
    return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  function render(container, photos, ctx) {
    if (!container) {
      return;
    }

    container.innerHTML = '';
    const caps = ctx.getCapabilities?.() ?? ViewCapabilities.get();

    if (!photos.length) {
      ctx.onAfterRender?.(photos);
      return;
    }

    let currentKey = null;
    let gridEl = null;

    photos.forEach((photo, index) => {
      const date = ctx.parseDate?.(photo.date_taken) ?? null;
      const key = monthKey(date);
      if (key !== currentKey) {
        currentKey = key;
        const header = document.createElement('div');
        header.className = 'month-header';
        header.innerHTML = `<span class="month-label">${monthHeaderLabel(date)}</span>`;
        container.appendChild(header);

        gridEl = document.createElement('div');
        gridEl.className = 'photo-grid';
        container.appendChild(gridEl);
      }

      const card = GridTile.createCard({
        caps,
        photoId: photo.id,
        favorited: ctx.isStarred?.(photo) ?? false,
        isVideo: photo.file_type === 'video',
        selected: ctx.isSelected?.(photo.id) ?? false,
        thumbSrc: ctx.thumbUrl?.(photo) ?? null,
        thumbAlt: photo.original_filename || 'Photo',
        index,
      });

      const img = card.querySelector('.photo-thumb');
      GridTile.attachThumbLoadHandler(img);
      gridEl.appendChild(card);
    });

    ctx.onAfterRender?.(photos);
  }

  return {
    monthKey,
    monthHeaderLabel,
    render,
  };
})();
