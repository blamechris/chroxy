/**
 * SkillsPanel — manual-skill toggles for the active session (#3209).
 *
 * Renders a popover-style list of all skills the active session has
 * loaded (auto + manual). Auto skills are shown read-only; manual
 * skills get a checkbox toggle that fires `skill_activate` /
 * `skill_deactivate` WS messages. The server broadcasts back so all
 * clients on the same session stay in sync.
 *
 * Compact native checkboxes — no extra deps. Accessibility comes from
 * the label association.
 */
import type { SessionSkillInfo } from '../store/types'

export interface SkillsPanelProps {
  skills: SessionSkillInfo[] | undefined
  onActivate: (skillName: string) => void
  onDeactivate: (skillName: string) => void
  onClose: () => void
}

export function SkillsPanel({
  skills,
  onActivate,
  onDeactivate,
  onClose,
}: SkillsPanelProps) {
  // Auto skills are always active and live above manual ones (visual
  // hierarchy: "always-on" first, "operator-controlled" below).
  const autoSkills = (skills || []).filter(s => s.activation !== 'manual')
  const manualSkills = (skills || []).filter(s => s.activation === 'manual')

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

      {(!skills || skills.length === 0) && (
        <p className="skills-panel-empty" data-testid="skills-panel-empty">
          No skills loaded for this session.
        </p>
      )}

      {autoSkills.length > 0 && (
        <section>
          <h4>Always on</h4>
          <ul className="skills-panel-list">
            {autoSkills.map(s => (
              <li key={s.name} data-testid={`skill-item-${s.name}`}>
                <span className="skill-name">{s.name}</span>
                {s.description && <span className="skill-desc">{s.description}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {manualSkills.length > 0 && (
        <section>
          <h4>Manual (toggle on/off)</h4>
          <ul className="skills-panel-list">
            {manualSkills.map(s => (
              <li key={s.name} data-testid={`skill-item-${s.name}`}>
                <label>
                  <input
                    type="checkbox"
                    checked={!!s.active}
                    onChange={e => {
                      if (e.target.checked) onActivate(s.name)
                      else onDeactivate(s.name)
                    }}
                    data-testid={`skill-toggle-${s.name}`}
                  />
                  <span className="skill-name">{s.name}</span>
                  {s.description && <span className="skill-desc">{s.description}</span>}
                </label>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
