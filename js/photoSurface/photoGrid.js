/**
 * Photo grid entry point — eager mode for share; virtual libraries use VirtualGrid.init.
 */
const PhotoGrid = (() => {
  function render(container, photos, ctx) {
    const caps = ctx.getCapabilities?.() ?? ViewCapabilities.get();
    if (caps.virtual) {
      throw new Error('PhotoGrid.render is for non-virtual surfaces; use VirtualGrid.init');
    }
    if (typeof SimplePhotoGrid === 'undefined') {
      throw new Error('SimplePhotoGrid is not loaded');
    }
    SimplePhotoGrid.render(container, photos, ctx);
  }

  return {
    render,
  };
})();
