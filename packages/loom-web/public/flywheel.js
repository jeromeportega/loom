/**
 * Flywheel board view — story-005-007
 *
 * Self-registers with the client router via Loom.registerView so that
 * index.html's nav slot for 'Flywheel' appears automatically.
 *
 * Fetches GET /api/lessons on render and displays:
 *   - Lessons (each showing where it was applied via applied_as/applied_ref)
 *   - Current self-proposals (proposed_by='loom' planned epics)
 *   - A defined empty state when neither exists
 */

(function () {
  'use strict';

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── Application badge ────────────────────────────────────────────────────

  function applicationBadge(applied_as, applied_ref) {
    if (!applied_as) {
      return '<span style="color:#6e7681;font-size:12px;font-style:italic">not yet applied</span>';
    }
    const label = applied_as === 'worker_guidance' ? 'worker guidance' : 'policy suggestion';
    const color = applied_as === 'worker_guidance' ? '#58a6ff' : '#d29922';
    const ref = applied_ref
      ? ` → <code style="font-size:11px;color:#8b949e">${esc(applied_ref)}</code>`
      : '';
    return `<span style="font-size:12px;color:${color}">${esc(label)}${ref}</span>`;
  }

  // ─── Lesson card ──────────────────────────────────────────────────────────

  function renderLesson(lesson) {
    return `<div class="panel" style="margin-bottom:12px">
  <div class="epic-head">
    <span style="font-weight:600;font-size:13px">${esc(lesson.category)}</span>
    <span style="font-size:11px;color:#6e7681">${esc(lesson.epic_id)}</span>
  </div>
  <div style="font-size:13px;margin-top:6px">${esc(lesson.observation)}</div>
  <div style="font-size:12px;color:#8b949e;margin-top:6px;font-style:italic">${esc(lesson.general_rule)}</div>
  <div style="margin-top:8px">
    Applied as: ${applicationBadge(lesson.applied_as, lesson.applied_ref)}
  </div>
  <div class="updated">added ${new Date(lesson.created_at).toLocaleString()}</div>
</div>`;
  }

  // ─── Proposal card ────────────────────────────────────────────────────────

  function renderProposal(proposal) {
    return `<div class="panel" style="margin-bottom:12px">
  <div class="epic-head">
    <span style="font-weight:600">${esc(proposal.title)}</span>
    <span class="epic-status planned">planned</span>
  </div>
  <div style="font-size:12px;color:#6e7681;margin-top:4px">
    Proposed by loom · <code>${esc(proposal.epic_id)}</code>
  </div>
  <div class="updated">created ${new Date(proposal.created_at).toLocaleString()}</div>
</div>`;
  }

  // ─── Empty state ──────────────────────────────────────────────────────────

  function renderEmpty(container) {
    container.innerHTML =
      '<div class="empty" style="padding:32px 0;text-align:center;color:#8b949e">' +
      'No lessons or proposals yet. ' +
      'Lessons are extracted automatically when epics complete. ' +
      'Run <code>loom propose</code> to generate a self-proposed epic.' +
      '</div>';
  }

  // ─── Board rendering ──────────────────────────────────────────────────────

  function renderBoard(container, data) {
    const { lessons, proposals, empty } = data;

    if (empty) {
      renderEmpty(container);
      return;
    }

    let html = '';

    if (lessons.length > 0) {
      html += `<h2 style="font-size:15px;margin:0 0 10px;color:#e6edf3">Lessons (${esc(lessons.length)})</h2>`;
      html += lessons.map(renderLesson).join('');
    }

    if (proposals.length > 0) {
      if (lessons.length > 0) html += '<div style="margin-top:20px"></div>';
      html += `<h2 style="font-size:15px;margin:0 0 10px;color:#e6edf3">Self-proposals (${esc(proposals.length)})</h2>`;
      html += proposals.map(renderProposal).join('');
    }

    container.innerHTML = html;
  }

  // ─── View render ──────────────────────────────────────────────────────────

  function render(container, api) {
    container.innerHTML =
      '<div class="empty" style="padding:32px 0;text-align:center;color:#8b949e">Loading flywheel…</div>';

    api('/api/lessons')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        renderBoard(container, data);
      })
      .catch(function (err) {
        container.innerHTML =
          '<div class="empty" style="color:#f85149">Failed to load flywheel: ' + esc(err.message) + '</div>';
      });
  }

  // ─── Self-register ────────────────────────────────────────────────────────

  if (typeof window !== 'undefined') {
    var doRegister = function () {
      if (window.Loom && typeof window.Loom.registerView === 'function') {
        window.Loom.registerView({ id: 'flywheel', label: 'Flywheel', render: render });
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', doRegister);
    } else {
      doRegister();
    }
  }
})();
