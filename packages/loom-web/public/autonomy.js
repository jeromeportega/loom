/* loom autonomy view — self-registers with the client router on load */
(function () {
  if (typeof Loom === 'undefined' || typeof Loom.registerView !== 'function') return;

  Loom.registerView({
    id: 'autonomy',
    label: 'Autonomy',
    render: function (container) {
      container.innerHTML =
        '<div class="autonomy-view">' +
        '<h2>Autonomy</h2>' +
        '<p>Set per-epic autonomy levels via <code>POST /api/epics/:id/autonomy</code> ' +
        'or the <code>loom_set_autonomy</code> MCP tool.</p>' +
        '</div>';
    },
  });
})();
