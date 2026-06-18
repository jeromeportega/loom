/**
 * Fleet board view — story-003-005
 *
 * Self-registers with the client router via Loom.registerView so that
 * story-003-006's index.html can include this script and the nav slot
 * for 'Fleet' appears automatically.
 *
 * Updates live off the existing `epic` and `agent` SSE events from
 * /api/events — no new event types required. The view subscribes when
 * rendered and unsubscribes (closes the EventSource) when another view
 * takes over.
 *
 * The board renders one card per FleetCard returned by GET /api/fleet,
 * grouped by project. Unknown fields in the SSE payload are ignored
 * (forward-compatible with future epic-003 additions).
 */

(function () {
  'use strict';

  // ─── Status helpers ────────────────────────────────────────────────────────

  const STATUS_COLORS = {
    done:            { bg: '#1f3a26', fg: '#56d364' },
    in_progress:     { bg: '#1f2c3a', fg: '#58a6ff' },
    rejected:        { bg: '#3a1f1f', fg: '#f85149' },
    failed:          { bg: '#3a1f1f', fg: '#f85149' },
    planning:        { bg: '#2f2a14', fg: '#d29922' },
    approved:        { bg: '#2c1f3a', fg: '#bc8cff' },
    planned:         { bg: '#21262d', fg: '#8b949e' },
    finalizing:      { bg: '#1f2c3a', fg: '#58a6ff' },
    publish_pending: { bg: '#1f3a2a', fg: '#3fb950' },
  };

  const STATUS_LABELS = {
    publish_pending: 'work complete · publish pending',
  };

  const BLOCKER_STATUSES = new Set(['blocked', 'failed']);

  function statusBadge(status, autonomyLevel, paused) {
    const color = STATUS_COLORS[status] || { bg: '#21262d', fg: '#8b949e' };
    const pulse = (status === 'planning' || status === 'in_progress') ? ' pulse' : '';
    let label = STATUS_LABELS[status] || status.replace(/_/g, ' ');
    if (paused) label += ' · paused';
    if (autonomyLevel && autonomyLevel !== 'manual') label += ' · ' + autonomyLevel;
    return `<span class="epic-status ${status}${pulse}" style="background:${color.bg};color:${color.fg}">${esc(label)}</span>`;
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtCost(card) {
    const usd = card.cost?.worker_cost_usd;
    if (usd == null || usd === 0) return card.cost?.worker_tokens ? `${card.cost.worker_tokens.toLocaleString()} tok` : '—';
    return `$${usd.toFixed(4)}`;
  }

  // ─── Card rendering ────────────────────────────────────────────────────────

  function renderCard(card) {
    const total = card.stories.length;
    const done  = card.stories.filter(s => s.status === 'done' || s.status === 'pr_open').length;
    const blocked = card.stories.filter(s => BLOCKER_STATUSES.has(s.status)).length;
    const running = card.stories.filter(s => s.status === 'running').length;

    const storyPills = card.stories.map(s => {
      const cls = BLOCKER_STATUSES.has(s.status) ? 'count-failed'
        : (s.status === 'done' || s.status === 'pr_open') ? 'count-done' : '';
      return `<span class="story-pill ${cls}" title="${esc(s.story_id)}">${esc(s.status[0])}</span>`;
    }).join('');

    const blockerBadge = blocked > 0
      ? `<span style="color:#f85149;font-size:11px;margin-left:8px">⚠ ${blocked} blocker${blocked > 1 ? 's' : ''}</span>`
      : '';

    return `<div class="fleet-card panel" data-epic-id="${esc(card.epic_id)}" data-project-root="${esc(card.project_root)}">
  <div class="epic-head">
    <span>
      <span class="epic-id">${esc(card.epic_id)}</span>
      <span style="color:#8b949e;font-size:12px;margin-left:8px">${esc(card.title)}</span>
    </span>
    <span>
      ${statusBadge(card.status, card.autonomy_level, card.paused)}
      ${blockerBadge}
    </span>
  </div>
  <div class="counts" style="font-size:12px;margin-top:6px">
    <span>${total} stories</span>
    <span class="count-done" style="margin-left:8px">${done} done</span>
    ${running > 0 ? `<span style="margin-left:8px;color:#58a6ff">${running} running</span>` : ''}
    <span style="margin-left:8px;color:#6e7681">${fmtCost(card)}</span>
  </div>
  <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:3px">${storyPills}</div>
  <div class="updated" style="margin-top:6px;font-size:10px;color:#6e7681">
    project: ${esc(card.project_root)}
  </div>
</div>`;
  }

  // ─── View render ──────────────────────────────────────────────────────────

  let fleetEventSource = null;
  let fleetCards = [];

  function closeFleetSSE() {
    if (fleetEventSource) {
      try { fleetEventSource.close(); } catch {}
      fleetEventSource = null;
    }
  }

  function renderBoard(container) {
    if (fleetCards.length === 0) {
      container.innerHTML = '<div class="empty">No epics found across registered projects.</div>';
      return;
    }

    // Group by project_root
    const byProject = new Map();
    for (const card of fleetCards) {
      if (!byProject.has(card.project_root)) byProject.set(card.project_root, []);
      byProject.get(card.project_root).push(card);
    }

    let html = '';
    for (const [root, cards] of byProject) {
      const name = root.split('/').pop() || root;
      html += `<div class="project-heading" style="margin:20px 0 8px;font-size:13px;color:#8b949e;font-weight:600">${esc(name)}</div>`;
      html += cards.map(renderCard).join('');
    }
    container.innerHTML = html;
  }

  function applyEpicUpdate(data) {
    const idx = fleetCards.findIndex(c => c.epic_id === data.id);
    if (idx === -1) return false;
    const card = fleetCards[idx];
    // Update fields from the SSE payload; ignore unknown keys (forward-compat).
    if (data.status !== undefined) card.status = data.status;
    if (data.autonomy_level !== undefined) card.autonomy_level = data.autonomy_level;
    if (data.paused !== undefined) card.paused = data.paused;
    return true;
  }

  function applyAgentUpdate(data) {
    const idx = fleetCards.findIndex(c => c.epic_id === data.epic_id);
    if (idx === -1) return false;
    const card = fleetCards[idx];
    const si = card.stories.findIndex(s => s.story_id === data.story_id);
    if (si === -1) {
      // New story appeared (planning → dispatched) — append.
      card.stories.push({ story_id: data.story_id, status: data.status });
    } else {
      card.stories[si].status = data.status;
    }
    return true;
  }

  function render(container, api) {
    container.innerHTML = '<div class="empty" style="padding:32px 0;text-align:center;color:#8b949e">Loading fleet…</div>';

    // Fetch initial fleet state.
    api('/api/fleet')
      .then(res => res.json())
      .then(cards => {
        fleetCards = cards;
        renderBoard(container);
      })
      .catch(err => {
        container.innerHTML = `<div class="empty" style="color:#f85149">Failed to load fleet: ${esc(err.message)}</div>`;
      });

    // Subscribe to SSE for live updates.
    closeFleetSSE();
    // EventSource doesn't support custom headers; the token must be in the
    // query string (same pattern as the detail view in index.html).
    const token = window.__loomToken || '';
    fleetEventSource = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);

    fleetEventSource.addEventListener('epic', ev => {
      try {
        const data = JSON.parse(ev.data);
        if (applyEpicUpdate(data)) renderBoard(container);
      } catch {}
    });

    fleetEventSource.addEventListener('agent', ev => {
      try {
        const data = JSON.parse(ev.data);
        if (applyAgentUpdate(data)) renderBoard(container);
      } catch {}
    });

    // Return cleanup so the router can close the EventSource on navigation away.
    return closeFleetSSE;
  }

  // ─── Self-register ────────────────────────────────────────────────────────

  // Loom.registerView is provided by story-003-006's index.html. Guard in
  // case this script loads before the client router is defined.
  if (typeof window !== 'undefined') {
    const doRegister = () => {
      if (window.Loom && typeof window.Loom.registerView === 'function') {
        window.Loom.registerView({ id: 'fleet', label: 'Fleet', render });
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', doRegister);
    } else {
      doRegister();
    }
  }
})();
