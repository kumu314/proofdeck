/**
 * Domain types for the Octopus Blackboard — a shared memory and coordination
 * layer for AI coding agents.
 *
 * The blackboard does NOT orchestrate, schedule, or trigger agents. It records
 * what each agent chooses to write, and lets every other agent read it. Six
 * questions it answers:
 *
 *   Who is working on what   → agents, tasks, claims
 *   What changed             → files_changed
 *   What was decided         → decisions
 *   What evidence exists      → evidence
 *   What risks are open      → risks
 *   What was left for whom    → messages, handoffs
 *
 * Every mutation appends a tamper-evident entry to the `timeline` (a hash
 * chain), so the whole history is replayable and auditable.
 */
export {};
//# sourceMappingURL=types.js.map