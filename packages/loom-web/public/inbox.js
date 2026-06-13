/**
 * Inbox view — story-003-004
 *
 * Self-registers with the client router via Loom.registerView so that
 * story-003-006's index.html can include this script and the 'Inbox' nav
 * slot appears automatically.
 *
 * Fetches GET /api/inbox and renders pending decisions grouped by type.
 * Inline action buttons call the EXISTING mutation endpoints with
 * ?project=<project_root> — no new mutation handlers are introduced here.
 *
 *   plan_approval    → Approve  (POST /api/epics/:id/approve)
 *                    → Reject   (POST /api/epics/:id/reject)
 *   checkpoint_resume→ Resume   (POST /api/epics/:id/resume)
 *                    → Stop     (POST /api/stop)
 *   escalation       → Retry    (POST /api/stories/:id/retry)
 *                    → Kill     (POST /api/agents/:id/kill — requires agent id)
 *
 * The inbox refreshes after every action so the acted-on item leaves the list.
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

  function fmtAge(ms) {
    if (ms < 60000) return `${Math.round(ms / 1000)}s ago`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
    return `${Math.round(ms / 3600000)}h ago`;
  }

  const TYPE_LABEL = {
    plan_approval:     '📋 Awaiting approval',
    checkpoint_resume: '⏸  Checkpoint pause',
    escalation:        '🚨 Escalation',
  };

  const TYPE_COLOR = {
    plan_approval:     { bg: '#2c1f3a', fg: '#bc8cff', border: '#4a2f6a' },
    checkpoint_resume: { bg: '#2f2a14', fg: '#d29922', border: '#5a4e18' },
    escalation:        { bg: '#3a1f1f', fg: '#f85149', border: '#6a2f2f' },
  };

  // ─── Entry rendering ────────────────────────────────────────────────────────

  function renderEntry(entry) {
    const color = TYPE_COLOR[entry.type] || { bg: '#21262d', fg: '#8b949e', border: '#30363d' };
    const typeLabel = TYPE_LABEL[entry.type] || entry.type;
    const projectQ = `?project=${encodeURIComponent(entry.project_root)}`;

    let actionsHtml = '';
    if (entry.type === 'plan_approval') {
      actionsHtml = `
        <button class="inbox-btn approve-btn"
          onclick="inboxAct('POST', '/api/epics/${esc(entry.epic_id)}/approve${esc(projectQ)}', null, this)">
          Approve
        </button>
        <button class="inbox-btn reject-btn"
          onclick="inboxPromptReject('${esc(entry.epic_id)}', '${esc(entry.project_root)}', this)">
          Reject
        </button>`;
    } else if (entry.type === 'checkpoint_resume') {
      actionsHtml = `
        <button class="inbox-btn approve-btn"
          onclick="inboxAct('POST', '/api/epics/${esc(entry.epic_id)}/resume${esc(projectQ)}', null, this)">
          Resume
        </button>
        <button class="inbox-btn stop-btn"
          onclick="inboxAct('POST', '/api/stop${esc(projectQ)}', null, this)">
          Stop
        </button>`;
    } else if (entry.type === 'escalation') {
      // For escalation the story_id is available; kill requires an agent id
      // (not available from inbox entries). Retry works with story_id only.
      actionsHtml = `
        <button class="inbox-btn retry-btn"
          onclick="inboxAct('POST', '/api/stories/${esc(entry.story_id)}/retry${esc(projectQ)}', null, this)">
          Retry
        </button>`;
    }

    return `<div class="inbox-entry panel" style="border-color:${color.border};background:${color.bg}20">
  <div class="epic-head">
    <span>
      <span style="font-size:11px;padding:2px 8px;border-radius:4px;background:${color.bg};color:${color.fg};font-weight:600">${esc(typeLabel)}</span>
      <span class="epic-id" style="margin-left:8px">${esc(entry.epic_id)}</span>
    </span>
    <span style="font-size:11px;color:#8b949e">${esc(fmtAge(entry.age_ms))}</span>
  </div>
  <div style="margin:6px 0 4px;color:#e6edf3">${esc(entry.title)}</div>
  <div style="font-size:11px;color:#8b949e;margin-bottom:8px">
    ${esc(entry.project)} · ${esc(entry.project_root)}
    ${entry.story_id ? `<span style="margin-left:6px">story: ${esc(entry.story_id)}</span>` : ''}
  </div>
  <div class="inbox-actions" style="display:flex;gap:8px">${actionsHtml}</div>
</div>`;
  }

  // ─── View render ─────────────────────────────────────────────────────────────

  let currentContainer = null;
  let currentApiRef = null;
  let pollTimer = null;

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function refresh() {
    if (!currentContainer || !currentApiRef) return;
    currentApiRef('/api/inbox')
      .then(r => r.json())
      .then(entries => {
        if (!currentContainer) return;
        if (!Array.isArray(entries) || entries.length === 0) {
          currentContainer.innerHTML = '<div class="empty" style="padding:32px 0;text-align:center;color:#8b949e">No pending decisions — inbox is clear.</div>';
          return;
        }
        // Group by type
        const byType = {
          plan_approval: entries.filter(e => e.type === 'plan_approval'),
          checkpoint_resume: entries.filter(e => e.type === 'checkpoint_resume'),
          escalation: entries.filter(e => e.type === 'escalation'),
        };
        let html = '';
        for (const [type, group] of Object.entries(byType)) {
          if (group.length === 0) continue;
          const color = TYPE_COLOR[type] || {};
          html += `<div style="margin:20px 0 8px;font-size:13px;color:${color.fg || '#8b949e'};font-weight:600">${esc(TYPE_LABEL[type] || type)} (${group.length})</div>`;
          html += group.map(renderEntry).join('');
        }
        currentContainer.innerHTML = html;
      })
      .catch(err => {
        if (currentContainer) {
          currentContainer.innerHTML = `<div class="empty" style="color:#f85149">Failed to load inbox: ${esc(err.message)}</div>`;
        }
      });
  }

  function render(container, api) {
    currentContainer = container;
    currentApiRef = api;
    stopPolling();

    // Expose action helpers on window for inline onclick handlers.
    window.inboxAct = async function (method, path, body, btn) {
      if (btn) btn.disabled = true;
      try {
        const res = await api(path, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          alert(`Failed: ${err.error || res.status}`);
          if (btn) btn.disabled = false;
          return;
        }
        // Refresh inbox after successful action so acted-on entry leaves list.
        refresh();
      } catch (err) {
        alert(`Failed: ${err.message}`);
        if (btn) btn.disabled = false;
      }
    };

    window.inboxPromptReject = function (epicId, projectRoot, btn) {
      const reason = prompt('Rejection reason (optional):');
      if (reason === null) return; // user cancelled
      const projectQ = `?project=${encodeURIComponent(projectRoot)}`;
      window.inboxAct('POST', `/api/epics/${epicId}/reject${projectQ}`, { reason: reason || undefined }, btn);
    };

    container.innerHTML = '<div class="empty" style="padding:32px 0;text-align:center;color:#8b949e">Loading inbox…</div>';
    refresh();
    // Poll every 5s so new decisions appear without a manual refresh.
    pollTimer = setInterval(refresh, 5000);

    // Return cleanup so the router can stop polling on navigation away.
    return function cleanup() {
      stopPolling();
      currentContainer = null;
      currentApiRef = null;
    };
  }

  // ─── Inline styles injected once ─────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('inbox-styles')) return;
    const style = document.createElement('style');
    style.id = 'inbox-styles';
    style.textContent = `
      .inbox-entry { margin-bottom: 12px; }
      .inbox-btn {
        padding: 4px 12px;
        border: 1px solid #30363d;
        border-radius: 4px;
        background: #21262d;
        color: #e6edf3;
        cursor: pointer;
        font-size: 12px;
      }
      .inbox-btn:hover { border-color: #58a6ff; }
      .inbox-btn.approve-btn { border-color: #238636; color: #56d364; }
      .inbox-btn.approve-btn:hover { background: #1f3a26; }
      .inbox-btn.reject-btn { border-color: #da3633; color: #f85149; }
      .inbox-btn.reject-btn:hover { background: #3a1f1f; }
      .inbox-btn.stop-btn { border-color: #9e6a03; color: #d29922; }
      .inbox-btn.stop-btn:hover { background: #2f2a14; }
      .inbox-btn.retry-btn { border-color: #1f6feb; color: #58a6ff; }
      .inbox-btn.retry-btn:hover { background: #1f2c3a; }
      .inbox-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    `;
    document.head.appendChild(style);
  }

  // ─── Self-register ────────────────────────────────────────────────────────────

  if (typeof window !== 'undefined') {
    const doRegister = () => {
      injectStyles();
      if (window.Loom && typeof window.Loom.registerView === 'function') {
        window.Loom.registerView({ id: 'inbox', label: 'Inbox', render });
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', doRegister);
    } else {
      doRegister();
    }
  }
})();
