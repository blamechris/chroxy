/**
 * SkillsPanel — skills metadata + manual-skill toggles for the active session.
 *
 * Renders a popover-style list of all skills the active session has
 * loaded (auto + manual). Auto skills are shown read-only; manual
 * skills get a checkbox toggle that fires `skill_activate` /
 * `skill_deactivate` WS messages. The server broadcasts back so all
 * clients on the same session stay in sync.
 *
 * #3209: runtime activation toggles.
 * #3205: skills metadata (source, version, last-activated, hash) +
 * red-flag indicator on hash mismatch so operators can audit before
 * activating community-shared skills.
 * #3298: "Pending review" section for community skills awaiting
 * first-activation trust grant, with a per-row Trust button.
 *
 * Compact native checkboxes — no extra deps. Accessibility comes from
 * the label association.
 */
import type { PendingCommunitySkill, SessionSkillInfo } from '../store/types'

export interface SkillsPanelProps {
  skills: SessionSkillInfo[] | undefined
  // #3209/#3246: only providers that rebuild the system prompt each
  // turn (Claude SDK) can honour mid-session toggles. Subprocess
  // providers (Codex, Gemini, Claude CLI) snapshot the prompt at
  // session start. Default `false` so the panel is read-only on
  // unknown / older servers — operators see the skill list but the
  // checkboxes are disabled with an explanatory note.
  canToggle?: boolean
  // #3205: skill names whose hash mismatched the trust store's
  // recorded value during this session (delivered via
  // `skill_changed` events). The panel renders a red flag next to
  // each entry so the operator can audit before activating.
  mismatchedSkillNames?: Set<string>
  onActivate: (skillName: string) => void
  onDeactivate: (skillName: string) => void
  // #3270: optional 'Accept new content' callback. When supplied, the
  // panel renders an Accept button next to the mismatch flag for any
  // skill in `mismatchedSkillNames`. Clicking sends the
  // `skill_trust_accept` WS message via the wired store action; the
  // resulting `skill_trust_accepted` broadcast clears the flag.
  // Optional so older callers (and pre-#3269 servers) keep working.
  onAcceptTrust?: (skillName: string) => void
  // #3298: community skills pending first-activation trust grant.
  // Populated by skill_trust_request events; cleared by
  // skill_trust_granted. When supplied (and non-empty), the panel
  // renders a "Pending review" section above Always-on / Manual.
  pendingCommunitySkills?: PendingCommunitySkill[]
  // #3298: callback to grant first-activation trust to a community
  // skill author. Sends skill_trust_grant WS message. Only called
  // when capabilities?.skillTrustGrant is true — see section gate.
  onGrantTrust?: (skillName: string, author: string) => void
  // #3298: server-advertised capabilities. Gates the "Pending review"
  // section on the server supporting skill_trust_grant (advertised via
  // auth_ok.capabilities.skillTrustGrant). Older servers without this
  // capability won't emit skill_trust_request events anyway, so the
  // section would be empty — but the gate makes the contract explicit.
  capabilities?: { skillTrustGrant?: boolean }
  onClose: () => void
}

// #3205: format an ISO-8601 timestamp as a compact relative-or-date
// label. Same-day shows the time; earlier dates show the localised
// date. Defensive: returns the raw string when parsing fails so a
// non-ISO timestamp doesn't break rendering.
function formatTimestamp(iso: string | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const d = new Date(t)
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate()
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

// #3205: render the per-skill metadata row (source / version /
// last-activated / hash). Each field is conditional — older servers
// or trust-disabled sessions omit the relevant fields and the row
// just shrinks. Mismatch indicator (red flag) is rendered on the
// `name` line above by the caller.
function SkillMeta({ skill }: { skill: SessionSkillInfo }) {
  const fields: Array<{ label: string; value: string; testid: string }> = []
  if (skill.source) {
    fields.push({ label: 'source', value: skill.source, testid: `skill-meta-source-${skill.name}` })
  }
  if (skill.version) {
    fields.push({ label: 'version', value: skill.version, testid: `skill-meta-version-${skill.name}` })
  }
  if (skill.lastVerified) {
    fields.push({ label: 'last seen', value: formatTimestamp(skill.lastVerified), testid: `skill-meta-last-verified-${skill.name}` })
  }
  if (skill.hashPrefix) {
    fields.push({ label: 'hash', value: skill.hashPrefix, testid: `skill-meta-hash-${skill.name}` })
  }
  if (fields.length === 0) return null
  return (
    <span className="skill-meta">
      {fields.map((f, i) => (
        <span key={f.label} className="skill-meta-field" data-testid={f.testid}>
          {i > 0 && <span className="skill-meta-sep" aria-hidden> · </span>}
          <span className="skill-meta-label">{f.label}:</span>{' '}
          <span className="skill-meta-value">{f.value}</span>
        </span>
      ))}
    </span>
  )
}

export function SkillsPanel({
  skills,
  canToggle = false,
  mismatchedSkillNames,
  onActivate,
  onDeactivate,
  onAcceptTrust,
  pendingCommunitySkills,
  onGrantTrust,
  capabilities,
  onClose,
}: SkillsPanelProps) {
  // Auto skills are always active and live above manual ones (visual
  // hierarchy: "always-on" first, "operator-controlled" below).
  const autoSkills = (skills || []).filter(s => s.activation !== 'manual')
  const manualSkills = (skills || []).filter(s => s.activation === 'manual')

  // #3298: "Pending review" section is gated on the server capability
  // AND at least one pending entry being present.
  const showPendingReview = !!capabilities?.skillTrustGrant
    && !!onGrantTrust
    && Array.isArray(pendingCommunitySkills)
    && pendingCommunitySkills.length > 0

  // Stable empty Set so call sites without mismatch tracking don't
  // need to construct one — and the .has() check below stays cheap.
  const mismatched = mismatchedSkillNames || new Set<string>()

  // #3205: red-flag indicator. Renders inline next to the skill name
  // when the hash mismatched the trust-store record during this
  // session. Plain emoji — accessible (warning emoji is read by
  // screen readers as "warning"), no extra deps.
  function MismatchFlag({ name }: { name: string }) {
    if (!mismatched.has(name)) return null
    return (
      <span
        className="skill-mismatch-flag"
        data-testid={`skill-mismatch-${name}`}
        title="Skill content changed since last verified — review before activating"
        role="img"
        aria-label="Hash mismatch: skill content changed since last verified"
      >⚠️</span>
    )
  }

  // #3270: 'Accept new content' affordance. Only renders when:
  //   1. The skill is in `mismatchedSkillNames` (hash mismatch fired this session), AND
  //   2. The caller wired an `onAcceptTrust` handler (older callers and
  //      pre-#3269 servers don't support runtime re-trust).
  // Sits as a sibling to the <label> inside .skill-row so a click does
  // NOT bubble into the label-association and toggle the checkbox.
  function AcceptTrustButton({ name }: { name: string }) {
    if (!onAcceptTrust || !mismatched.has(name)) return null
    return (
      <button
        type="button"
        className="skill-accept-trust"
        data-testid={`skill-accept-trust-${name}`}
        onClick={() => onAcceptTrust(name)}
        title="Accept the current content as the new trusted version"
        aria-label={`Accept new content for skill ${name}`}
      >Accept</button>
    )
  }

  return (
    <div className="skills-panel" data-testid="skills-panel" role="dialog" aria-label="Skills">
      <div className="skills-panel-header">
        <h3>Skills</h3>
        <button
          type="button"
          className="skills-panel-close"
          onClick={onClose}
          aria-label="Close skills panel"
          data-testid="skills-panel-close"
        >×</button>
      </div>

      {(!skills || skills.length === 0) && !showPendingReview && (
        <p className="skills-panel-empty" data-testid="skills-panel-empty">
          No skills loaded for this session.
        </p>
      )}

      {/* #3298: community skills awaiting first-activation trust grant.
          Rendered above Always-on / Manual so it appears as a prompt
          the operator should act on before reviewing the active set. */}
      {showPendingReview && (
        <section data-testid="skills-panel-pending-section">
          <h4>Pending review</h4>
          <ul className="skills-panel-list">
            {(pendingCommunitySkills!).map(({ name, author }) => (
              <li key={`${author}/${name}`} data-testid={`skill-pending-${author}/${name}`}>
                <div className="skill-row">
                  <span className="skill-name">{name}</span>
                  <span className="skill-desc">from: {author}</span>
                  <button
                    type="button"
                    className="skill-accept-trust"
                    data-testid={`skill-grant-trust-${author}/${name}`}
                    onClick={() => onGrantTrust!(name, author)}
                    title={`Grant first-activation trust to community author '${author}'`}
                    aria-label={`Trust author ${author} for skill ${name}`}
                  >Trust &apos;{author}&apos;</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {autoSkills.length > 0 && (
        <section>
          <h4>Always on</h4>
          <ul className="skills-panel-list">
            {autoSkills.map(s => (
              <li key={s.name} data-testid={`skill-item-${s.name}`}>
                <div className="skill-row">
                  <span className="skill-name">{s.name}</span>
                  {s.description && <span className="skill-desc">{s.description}</span>}
                  {/* #3251: auto skills have no <label>, so label-
                      association doesn't apply here — keep the flag
                      inside the existing flex row so it renders
                      inline next to the skill name (matches v1
                      visual layout).
                      #3270: AcceptTrustButton sits next to the flag
                      so the recovery affordance is co-located with
                      the warning indicator. */}
                  <MismatchFlag name={s.name} />
                  <AcceptTrustButton name={s.name} />
                </div>
                <SkillMeta skill={s} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {manualSkills.length > 0 && (
        <section>
          <h4>Manual (toggle on/off)</h4>
          {!canToggle && (
            <p className="skills-panel-note" data-testid="skills-panel-no-toggle-note">
              Runtime toggle is not supported by this provider. Restart the
              session with the desired skills to change which manual skills
              are active.
            </p>
          )}
          <ul className="skills-panel-list">
            {manualSkills.map(s => (
              <li key={s.name} data-testid={`skill-item-${s.name}`}>
                {/* #3251: wrap <label> + <MismatchFlag /> in a flex
                    row so they render inline. The flag sits OUTSIDE
                    the <label>, so clicking it does not trigger
                    label-association and toggle the checkbox — but
                    the visual placement (inline, after the name)
                    matches the auto-skills section. */}
                <div className="skill-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={!!s.active}
                      disabled={!canToggle}
                      onChange={e => {
                        if (e.target.checked) onActivate(s.name)
                        else onDeactivate(s.name)
                      }}
                      data-testid={`skill-toggle-${s.name}`}
                    />
                    <span className="skill-name">{s.name}</span>
                    {s.description && <span className="skill-desc">{s.description}</span>}
                  </label>
                  <MismatchFlag name={s.name} />
                  {/* #3270: AcceptTrustButton sits as a sibling to
                      <label>, NOT inside it, so a click doesn't
                      bubble through label-association and flip the
                      checkbox — same defense as MismatchFlag. */}
                  <AcceptTrustButton name={s.name} />
                </div>
                <SkillMeta skill={s} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
