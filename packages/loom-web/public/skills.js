/**
 * Skills view — story-027-001
 *
 * Self-registers with the client router via Loom.registerView so that
 * index.html's nav slot for 'Skills' appears automatically on load.
 *
 * List view:  GET /api/skills → { skills: SkillManifestSummary[] }
 *   name, description, source, lifecycle, track record (injected/succeeded/failed)
 *
 * Drill-down: GET /api/skills/:name/history → { rows: SkillHistoryEntry[] }
 *   Chronological timeline of generated/injected/lifecycle events.
 *
 * Navigation within this view (list → detail → back) is internal; navTo()
 * is never called, so the SSE stream and list polling are not disturbed.
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

  // ─── Lifecycle badge ──────────────────────────────────────────────────────

  const LIFECYCLE_COLORS = {
    active:    { bg: '#1f3a26', fg: '#56d364' },
    candidate: { bg: '#2f2a14', fg: '#d29922' },
    disabled:  { bg: '#21262d', fg: '#6e7681' },
  };

  function lifecycleBadge(lc) {
    const c = LIFECYCLE_COLORS[lc] || LIFECYCLE_COLORS.disabled;
    return `<span style="font-size:11px;padding:2px 7px;border-radius:3px;background:${c.bg};color:${c.fg};text-transform:uppercase;letter-spacing:0.3px">${esc(lc)}</span>`;
  }

  // ─── Track record badge ────────────────────────────────────────────────────

  function trackRecord(skill) {
    const parts = [];
    if (skill.injected)   parts.push(`${skill.injected} injected`);
    if (skill.succeeded)  parts.push(`<span style="color:#56d364">${skill.succeeded} ok</span>`);
    if (skill.failed)     parts.push(`<span style="color:#f85149">${skill.failed} failed</span>`);
    return parts.length ? parts.join(' · ') : '<span style="color:#6e7681">no usage yet</span>';
  }

  // ─── Skills list view ─────────────────────────────────────────────────────

  function renderSkillsList(skills) {
    if (skills.length === 0) {
      return '<div class="empty">No skills discovered. Run <code>loom epic</code> to generate skills.</div>';
    }

    const rows = skills.map((s) => `
      <div class="epic" data-skill-name="${esc(s.name)}" style="cursor:pointer">
        <div class="epic-head">
          <div>
            <strong>${esc(s.name)}</strong>
            <span style="font-size:11px;color:#6e7681;margin-left:8px">${esc(s.source)}</span>
          </div>
          ${lifecycleBadge(s.lifecycle)}
        </div>
        <div style="color:#8b949e;font-size:13px;margin-top:4px">${esc(s.description)}</div>
        <div style="font-size:12px;margin-top:6px;color:#8b949e">
          ${trackRecord(s)}
        </div>
      </div>`).join('');

    return `<h2 style="margin:0 0 14px">Skills</h2>${rows}`;
  }

  // ─── Skill history (drill-down) view ─────────────────────────────────────

  const KIND_COLORS = {
    generated: '#d29922',
    injected:  '#58a6ff',
    lifecycle: '#bc8cff',
  };

  function renderSkillHistory(name, rows) {
    let backHtml = `<div class="back" id="skillsBackLink"><a style="cursor:pointer">← all skills</a></div>`;
    let heading  = `<h2 style="margin:0 0 14px">Skill: ${esc(name)}</h2>`;

    if (rows.length === 0) {
      return backHtml + heading +
        '<div class="empty">No history recorded for this skill yet.</div>';
    }

    const timeline = rows.map((r) => {
      const color = KIND_COLORS[r.kind] || '#8b949e';
      return `
        <div style="display:flex;gap:12px;padding:8px 0;border-bottom:1px solid #21262d">
          <div style="flex:0 0 160px;color:#6e7681;font-size:11px;font-family:monospace;padding-top:2px">
            ${esc(r.ts)}
          </div>
          <div>
            <span style="font-size:11px;padding:1px 7px;border-radius:3px;background:#21262d;color:${color};text-transform:uppercase;letter-spacing:0.3px">${esc(r.kind)}</span>
            <span style="margin-left:8px;font-size:13px;color:#c9d1d9">${esc(r.text)}</span>
          </div>
        </div>`;
    }).join('');

    return backHtml + heading +
      `<div style="background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:4px 14px">
        ${timeline}
      </div>`;
  }

  // ─── View render ──────────────────────────────────────────────────────────

  function render(container, api) {
    container.innerHTML =
      '<div class="empty" style="padding:32px 0;text-align:center;color:#8b949e">Loading skills…</div>';

    function showList() {
      api('/api/skills')
        .then((r) => r.json())
        .then(({ skills }) => {
          container.innerHTML = renderSkillsList(skills);
          container.querySelectorAll('[data-skill-name]').forEach((el) => {
            el.addEventListener('click', () => showHistory(el.dataset.skillName));
          });
        })
        .catch((err) => {
          container.innerHTML =
            `<div class="empty" style="color:#f85149">Failed to load skills: ${esc(err.message)}</div>`;
        });
    }

    function showHistory(name) {
      container.innerHTML =
        '<div class="empty" style="padding:32px 0;text-align:center;color:#8b949e">Loading history…</div>';
      api(`/api/skills/${encodeURIComponent(name)}/history`)
        .then((r) => r.json())
        .then(({ rows }) => {
          container.innerHTML = renderSkillHistory(name, rows);
          container.querySelector('#skillsBackLink')
            ?.addEventListener('click', showList);
        })
        .catch((err) => {
          container.innerHTML =
            `<div class="empty" style="color:#f85149">Failed to load history: ${esc(err.message)}</div>`;
        });
    }

    showList();
    // No SSE subscription — skills list is static until the next navigation.
    // Return undefined (no cleanup needed).
  }

  // ─── Self-register ────────────────────────────────────────────────────────

  if (typeof window !== 'undefined') {
    const doRegister = () => {
      if (window.Loom && typeof window.Loom.registerView === 'function') {
        window.Loom.registerView({ id: 'skills', label: 'Skills', render });
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', doRegister);
    } else {
      doRegister();
    }
  }
})();
