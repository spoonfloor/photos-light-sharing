/**
 * Photo grid entry point — non-virtual (eager) mode for share; library uses VirtualGrid.init.
 */
const PhotoGrid = (() => {
  function render(container, photos, ctx) {
    if (typeof SimplePhotoGrid === 'undefined') {
      throw new Error('SimplePhotoGrid is not loaded');
    }
    SimplePhotoGrid.render(container, photos, ctx);
  }

  return {
    render,
  };
})();
