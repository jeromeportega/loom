/**
 * Opportunity board view — story-004-006
 *
 * Self-registers with the client router via Loom.registerView so that
 * index.html's nav slot for 'Opportunities' appears automatically.
 *
 * Fetches GET /api/opportunities on render and displays ranked cards with
 * rationale, evidence links, signal counts, and Scope/Dismiss action buttons.
 * Shows a descriptive empty state when no opportunities exist.
 */

(function () {
  'use strict';

  // ─── Status color helpers ─────────────────────────────────────────────────

  const STATUS_COLORS = {
    open:      { bg: '#1f2c3a', fg: '#58a6ff' },
    scoped:    { bg: '#1f3a26', fg: '#56d364' },
    dismissed: { bg: '#21262d', fg: '#6e7681' },
  };

  function statusBadge(status) {
    const color = STATUS_COLORS[status] || { bg: '#21262d', fg: '#8b949e' };
    return `<span class="epic-status ${status}" style="background:${color.bg};color:${color.fg}">${esc(status)}</span>`;
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtScore(score) {
    return typeof score === 'number' ? score.toFixed(2) : '—';
  }

  // ─── Evidence links ───────────────────────────────────────────────────────

  function renderEvidence(evidence) {
    if (!evidence || evidence.length === 0) return '<span style="color:#6e7681;font-size:12px">no evidence</span>';
    return evidence.map(e =>
      `<a href="${esc(e.url)}" target="_blank" rel="noopener" style="font-size:12px;margin-right:8px">${esc(e.title)}</a>`
    ).join('');
  }

  // ─── Card rendering ───────────────────────────────────────────────────────

  function renderCard(card, api, onAction) {
    const isOpen = card.status === 'open';
    const scopeBtn = isOpen
      ? `<button class="primary" data-scope="${esc(card.id)}" style="font-size:12px;padding:3px 10px">Scope</button>`
      : '';
    const dismissBtn = isOpen
      ? `<button class="danger" data-dismiss="${esc(card.id)}" style="font-size:12px;padding:3px 10px">Dismiss</button>`
      : '';
    const scopedNote = card.status === 'scoped' && card.scoped_epic_id
      ? `<span style="font-size:12px;color:#56d364;margin-left:8px">→ ${esc(card.scoped_epic_id)}</span>`
      : '';

    return `<div class="panel opp-card" data-opp-id="${esc(card.id)}" style="margin-bottom:12px">
  <div class="epic-head">
    <span>
      <span style="color:#58a6ff;font-weight:600;font-size:13px">#${esc(card.rank)}</span>
      <span style="font-weight:600;margin-left:8px">${esc(card.title)}</span>
    </span>
    <span style="display:flex;align-items:center;gap:6px">
      ${statusBadge(card.status)}
      ${scopedNote}
    </span>
  </div>
  <div style="font-size:13px;color:#8b949e;margin-top:6px">${esc(card.rationale)}</div>
  <div style="margin-top:8px;font-size:12px;color:#6e7681">
    Score: <span style="color:#e6edf3">${fmtScore(card.score)}</span>
    &nbsp;·&nbsp;
    Signals: <span style="color:#e6edf3">${esc(card.signal_count)}</span>
    &nbsp;·&nbsp;
    Evidence: ${renderEvidence(card.evidence)}
  </div>
  <div style="margin-top:8px;display:flex;gap:6px;align-items:center">
    ${scopeBtn}
    ${dismissBtn}
  </div>
</div>`;
  }

  // ─── Board rendering ──────────────────────────────────────────────────────

  function renderBoard(container, cards, api, onAction) {
    if (!cards || cards.length === 0) {
      container.innerHTML =
        '<div class="empty" style="padding:32px 0;text-align:center;color:#8b949e">' +
        'No opportunities found. Run <code>loom scan</code> to discover improvement opportunities.' +
        '</div>';
      return;
    }

    const html = cards
      .slice()
      .sort((a, b) => a.rank - b.rank)
      .map(card => renderCard(card, api, onAction))
      .join('');

    container.innerHTML = html;

    // Bind Scope buttons
    container.querySelectorAll('button[data-scope]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-scope');
        onAction('scope', id, btn);
      });
    });

    // Bind Dismiss buttons
    container.querySelectorAll('button[data-dismiss]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-dismiss');
        if (!confirm('Dismiss this opportunity? It will not resurface on the next scan.')) return;
        onAction('dismiss', id, btn);
      });
    });
  }

  // ─── View render ──────────────────────────────────────────────────────────

  function render(container, api) {
    container.innerHTML =
      '<div class="empty" style="padding:32px 0;text-align:center;color:#8b949e">Loading opportunities…</div>';

    let currentCards = [];

    function refresh() {
      api('/api/opportunities')
        .then(res => res.json())
        .then(cards => {
          currentCards = Array.isArray(cards) ? cards : [];
          renderBoard(container, currentCards, api, handleAction);
        })
        .catch(err => {
          container.innerHTML =
            `<div class="empty" style="color:#f85149">Failed to load opportunities: ${esc(err.message)}</div>`;
        });
    }

    function handleAction(action, id, btn) {
      btn.disabled = true;
      api(`/api/opportunities/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
        .then(async res => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            alert(`Failed: ${body.error || res.status}`);
            btn.disabled = false;
            return;
          }
          // Re-fetch the board after a mutation
          refresh();
        })
        .catch(err => {
          alert(`Failed: ${err.message}`);
          btn.disabled = false;
        });
    }

    refresh();
    // No cleanup needed (no SSE for opportunities)
  }

  // ─── Self-register ────────────────────────────────────────────────────────

  if (typeof window !== 'undefined') {
    const doRegister = () => {
      if (window.Loom && typeof window.Loom.registerView === 'function') {
        window.Loom.registerView({ id: 'opportunities', label: 'Opportunities', render });
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', doRegister);
    } else {
      doRegister();
    }
  }
})();
