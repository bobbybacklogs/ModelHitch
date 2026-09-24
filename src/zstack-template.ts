// Auto-generated template mapping for zstack skills bundling.
import skillMd from '../plugins/zstack/skills/zstack/SKILL.md';
import setupSkillMd from '../plugins/zstack/skills/setup-zstack/SKILL.md';

// Playbooks
import playbook_authoring_a_skill from '../plugins/zstack/skills/zstack/playbooks/authoring-a-skill.md';
import playbook_autonomous_run from '../plugins/zstack/skills/zstack/playbooks/autonomous-run.md';
import playbook_bug_fix from '../plugins/zstack/skills/zstack/playbooks/bug-fix.md';
import playbook_eval from '../plugins/zstack/skills/zstack/playbooks/eval.md';
import playbook_feature from '../plugins/zstack/skills/zstack/playbooks/feature.md';
import playbook_investigation from '../plugins/zstack/skills/zstack/playbooks/investigation.md';
import playbook_opening_a_pr from '../plugins/zstack/skills/zstack/playbooks/opening-a-pr.md';
import playbook_pause_safely from '../plugins/zstack/skills/zstack/playbooks/pause-safely.md';
import playbook_perf_issue from '../plugins/zstack/skills/zstack/playbooks/perf-issue.md';
import playbook_prototype from '../plugins/zstack/skills/zstack/playbooks/prototype.md';
import playbook_refactoring from '../plugins/zstack/skills/zstack/playbooks/refactoring.md';
import playbook_runtime_forensics from '../plugins/zstack/skills/zstack/playbooks/runtime-forensics.md';
import playbook_session_pickup from '../plugins/zstack/skills/zstack/playbooks/session-pickup.md';
import playbook_trace_forensics from '../plugins/zstack/skills/zstack/playbooks/trace-forensics.md';
import playbook_visual_parity from '../plugins/zstack/skills/zstack/playbooks/visual-parity.md';

// Principles
import principle_boundary_discipline from '../plugins/zstack/skills/zstack/principles/boundary-discipline.md';
import principle_build_the_lever from '../plugins/zstack/skills/zstack/principles/build-the-lever.md';
import principle_encode_lessons_in_structure from '../plugins/zstack/skills/zstack/principles/encode-lessons-in-structure.md';
import principle_exhaust_the_design_space from '../plugins/zstack/skills/zstack/principles/exhaust-the-design-space.md';
import principle_experience_first from '../plugins/zstack/skills/zstack/principles/experience-first.md';
import principle_fix_root_causes from '../plugins/zstack/skills/zstack/principles/fix-root-causes.md';
import principle_foundational_thinking from '../plugins/zstack/skills/zstack/principles/foundational-thinking.md';
import principle_guard_the_context_window from '../plugins/zstack/skills/zstack/principles/guard-the-context-window.md';
import principle_laziness_protocol from '../plugins/zstack/skills/zstack/principles/laziness-protocol.md';
import principle_make_operations_idempotent from '../plugins/zstack/skills/zstack/principles/make-operations-idempotent.md';
import principle_migrate_callers_then_delete_legacy_apis from '../plugins/zstack/skills/zstack/principles/migrate-callers-then-delete-legacy-apis.md';
import principle_minimize_reader_load from '../plugins/zstack/skills/zstack/principles/minimize-reader-load.md';
import principle_never_block_on_the_human from '../plugins/zstack/skills/zstack/principles/never-block-on-the-human.md';
import principle_outcome_oriented_execution from '../plugins/zstack/skills/zstack/principles/outcome-oriented-execution.md';
import principle_prove_it_works from '../plugins/zstack/skills/zstack/principles/prove-it-works.md';
import principle_redesign_from_first_principles from '../plugins/zstack/skills/zstack/principles/redesign-from-first-principles.md';
import principle_separate_before_serializing_shared_state from '../plugins/zstack/skills/zstack/principles/separate-before-serializing-shared-state.md';
import principle_sequence_verifiable_units from '../plugins/zstack/skills/zstack/principles/sequence-verifiable-units.md';
import principle_subtract_before_you_add from '../plugins/zstack/skills/zstack/principles/subtract-before-you-add.md';
import principle_type_system_discipline from '../plugins/zstack/skills/zstack/principles/type-system-discipline.md';

// References
import raw_reference_evidence_schema from '../plugins/zstack/skills/zstack/references/evidence-schema.json';
const reference_evidence_schema = typeof raw_reference_evidence_schema === 'string'
  ? raw_reference_evidence_schema
  : JSON.stringify(raw_reference_evidence_schema, null, 2);

import reference_feature_map_template from '../plugins/zstack/skills/zstack/references/feature-map.template.md';
import reference_README from '../plugins/zstack/skills/zstack/references/README.md';

export const zstackSkillFiles: Record<string, string> = {
  'SKILL.md': skillMd,
  'playbooks/authoring-a-skill.md': playbook_authoring_a_skill,
  'playbooks/autonomous-run.md': playbook_autonomous_run,
  'playbooks/bug-fix.md': playbook_bug_fix,
  'playbooks/eval.md': playbook_eval,
  'playbooks/feature.md': playbook_feature,
  'playbooks/investigation.md': playbook_investigation,
  'playbooks/opening-a-pr.md': playbook_opening_a_pr,
  'playbooks/pause-safely.md': playbook_pause_safely,
  'playbooks/perf-issue.md': playbook_perf_issue,
  'playbooks/prototype.md': playbook_prototype,
  'playbooks/refactoring.md': playbook_refactoring,
  'playbooks/runtime-forensics.md': playbook_runtime_forensics,
  'playbooks/session-pickup.md': playbook_session_pickup,
  'playbooks/trace-forensics.md': playbook_trace_forensics,
  'playbooks/visual-parity.md': playbook_visual_parity,
  'principles/boundary-discipline.md': principle_boundary_discipline,
  'principles/build-the-lever.md': principle_build_the_lever,
  'principles/encode-lessons-in-structure.md': principle_encode_lessons_in_structure,
  'principles/exhaust-the-design-space.md': principle_exhaust_the_design_space,
  'principles/experience-first.md': principle_experience_first,
  'principles/fix-root-causes.md': principle_fix_root_causes,
  'principles/foundational-thinking.md': principle_foundational_thinking,
  'principles/guard-the-context-window.md': principle_guard_the_context_window,
  'principles/laziness-protocol.md': principle_laziness_protocol,
  'principles/make-operations-idempotent.md': principle_make_operations_idempotent,
  'principles/migrate-callers-then-delete-legacy-apis.md': principle_migrate_callers_then_delete_legacy_apis,
  'principles/minimize-reader-load.md': principle_minimize_reader_load,
  'principles/never-block-on-the-human.md': principle_never_block_on_the_human,
  'principles/outcome-oriented-execution.md': principle_outcome_oriented_execution,
  'principles/prove-it-works.md': principle_prove_it_works,
  'principles/redesign-from-first-principles.md': principle_redesign_from_first_principles,
  'principles/separate-before-serializing-shared-state.md': principle_separate_before_serializing_shared_state,
  'principles/sequence-verifiable-units.md': principle_sequence_verifiable_units,
  'principles/subtract-before-you-add.md': principle_subtract_before_you_add,
  'principles/type-system-discipline.md': principle_type_system_discipline,
  'references/evidence-schema.json': reference_evidence_schema,
  'references/feature-map.template.md': reference_feature_map_template,
  'references/README.md': reference_README,
};

export const setupZstackSkillFiles: Record<string, string> = {
  'SKILL.md': setupSkillMd,
};
