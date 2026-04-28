const ROLE_CONFUSION_PATTERNS = [
  { label: 'ignore_previous', fragment: 'ignore previous instructions' },
  { label: 'ignore_all_previous', fragment: 'ignore all previous' },
  { label: 'disregard_previous', fragment: 'disregard previous' },
  { label: 'you_are_now', fragment: 'you are now' },
  { label: 'act_as', fragment: 'act as if you are' },
  { label: 'pretend_you_are', fragment: 'pretend you are' },
  { label: 'forget_instructions', fragment: 'forget your instructions' },
  { label: 'new_persona', fragment: 'new persona' },
  { label: 'fake_system_message', fragment: 'system: ' },
];
const TOOL_FORGERY_PATTERNS = [
  { label: 'json_tool_key', fragment: '{"tool":' },
  { label: 'function_call_key', fragment: '"function_call":' },
  { label: 'tool_use_key', fragment: '"tool_use":' },
  { label: 'xml_tool_call', fragment: '<tool_call>' },
];
const ALL_PATTERNS = [...ROLE_CONFUSION_PATTERNS, ...TOOL_FORGERY_PATTERNS];
// ---------------------------------------------------------------------------
// HeuristicInjectionDetector
// ---------------------------------------------------------------------------
export class HeuristicInjectionDetector {
  detect(text) {
    const lower = text.toLowerCase();
    for (const entry of ALL_PATTERNS) {
      if (lower.includes(entry.fragment.toLowerCase())) {
        return { detected: true, pattern: entry.label };
      }
    }
    return { detected: false };
  }
}
//# sourceMappingURL=heuristic-injection-detector.js.map
